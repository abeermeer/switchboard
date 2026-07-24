import type {
  AdapterError,
  AdapterRequest,
  AdapterResponse,
  Modality,
  ProviderAdapter,
  TokenUsage,
} from '@/types/core';
import {
  DONE_FRAME,
  EXECUTE_TIMEOUT_MS,
  PROBE_TIMEOUT_MS,
  adapterError,
  applyAuth,
  asArray,
  asString,
  classifyHttpError,
  completionId,
  contentToText,
  dataFrame,
  effectiveBaseUrl,
  extractErrorMessage,
  isRecord,
  networkError,
  normalizeUsage,
  nowSeconds,
  pickHeaders,
  safeJson,
  timedFetch,
  translateSse,
  usageToOpenAi,
} from './shared';

/** Cohere v2 is already OpenAI-shaped for messages and tools; only the response
 *  envelope, the `p`/`k` sampling names and the embed/rerank bodies differ. */
function toCohereChatBody(req: AdapterRequest): Record<string, unknown> {
  const src = req.body;
  const messages: Array<Record<string, unknown>> = [];

  for (const raw of asArray(src.messages)) {
    if (!isRecord(raw)) continue;
    const role = asString(raw.role, 'user');
    const message: Record<string, unknown> = {
      role: role === 'developer' ? 'system' : role,
    };

    if (role === 'tool' || role === 'function') {
      message.role = 'tool';
      message.tool_call_id = asString(raw.tool_call_id ?? raw.id);
      message.content = contentToText(raw.content);
    } else if (role === 'assistant') {
      const text = contentToText(raw.content);
      if (text !== '') message.content = text;
      const calls = asArray(raw.tool_calls);
      if (calls.length > 0) message.tool_calls = calls;
      if (typeof raw.tool_plan === 'string') message.tool_plan = raw.tool_plan;
      if (message.content === undefined && message.tool_calls === undefined) continue;
    } else {
      message.content = typeof raw.content === 'string' ? raw.content : contentToText(raw.content);
    }

    messages.push(message);
  }

  const body: Record<string, unknown> = { model: req.model, messages };
  if (typeof src.max_tokens === 'number') body.max_tokens = src.max_tokens;
  else if (typeof src.max_completion_tokens === 'number') {
    body.max_tokens = src.max_completion_tokens;
  }
  if (typeof src.temperature === 'number') body.temperature = src.temperature;
  if (typeof src.top_p === 'number') body.p = src.top_p;
  if (typeof src.top_k === 'number') body.k = src.top_k;
  if (typeof src.frequency_penalty === 'number') body.frequency_penalty = src.frequency_penalty;
  if (typeof src.presence_penalty === 'number') body.presence_penalty = src.presence_penalty;
  if (typeof src.seed === 'number') body.seed = src.seed;
  if (typeof src.stop === 'string') body.stop_sequences = [src.stop];
  else if (Array.isArray(src.stop)) body.stop_sequences = src.stop;
  if (Array.isArray(src.tools) && src.tools.length > 0) body.tools = src.tools;

  const responseFormat = isRecord(src.response_format) ? src.response_format : null;
  if (responseFormat !== null) {
    const type = asString(responseFormat.type);
    if (type === 'json_object') body.response_format = { type: 'json_object' };
    else if (type === 'json_schema') {
      const schema = isRecord(responseFormat.json_schema) ? responseFormat.json_schema : null;
      body.response_format = {
        type: 'json_object',
        json_schema: isRecord(schema?.schema) ? schema.schema : undefined,
      };
    }
  }
  if (req.stream) body.stream = true;

  return body;
}

function finishReasonOf(raw: unknown): string {
  switch (asString(raw)) {
    case 'MAX_TOKENS':
      return 'length';
    case 'TOOL_CALL':
      return 'tool_calls';
    case 'ERROR_TOXIC':
    case 'ERROR_LIMIT':
      return 'content_filter';
    default:
      return 'stop';
  }
}

function toOpenAiCompletion(
  payload: Record<string, unknown>,
  model: string,
): { json: Record<string, unknown>; usage: TokenUsage | null } {
  const usage = normalizeUsage(payload.usage);
  const cohereMessage = isRecord(payload.message) ? payload.message : null;
  const text = contentToText(cohereMessage?.content);
  const toolCalls = asArray(cohereMessage?.tool_calls);

  const message: Record<string, unknown> = {
    role: 'assistant',
    content: text !== '' ? text : null,
  };
  if (typeof cohereMessage?.tool_plan === 'string' && cohereMessage.tool_plan !== '') {
    message.reasoning_content = cohereMessage.tool_plan;
  }
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  return {
    json: {
      id: asString(payload.id, completionId()),
      object: 'chat.completion',
      created: nowSeconds(),
      model,
      choices: [
        {
          index: 0,
          message,
          logprobs: null,
          finish_reason:
            toolCalls.length > 0 ? 'tool_calls' : finishReasonOf(payload.finish_reason),
        },
      ],
      usage: usageToOpenAi(usage) ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    },
    usage,
  };
}

interface StreamState {
  id: string;
  model: string;
  usage: TokenUsage | null;
  finishReason: string;
  ended: boolean;
}

function chunkFrame(
  state: StreamState,
  delta: Record<string, unknown>,
  finishReason: string | null,
  usage: Record<string, unknown> | null = null,
): string {
  const frame: Record<string, unknown> = {
    id: state.id,
    object: 'chat.completion.chunk',
    created: nowSeconds(),
    model: state.model,
    choices: [{ index: 0, delta, logprobs: null, finish_reason: finishReason }],
  };
  if (usage !== null) frame.usage = usage;
  return dataFrame(frame);
}

function translateEvent(state: StreamState, data: string): string[] {
  if (data === '[DONE]') return [];
  const payload = safeJson(data);
  if (!isRecord(payload)) return [];

  const type = asString(payload.type);
  const delta = isRecord(payload.delta) ? payload.delta : null;
  const deltaMessage = isRecord(delta?.message) ? delta.message : null;
  const index = typeof payload.index === 'number' ? payload.index : 0;

  switch (type) {
    case 'message-start':
      state.id = asString(payload.id, state.id);
      return [chunkFrame(state, { role: 'assistant', content: '' }, null)];

    case 'content-delta': {
      const content = isRecord(deltaMessage?.content) ? deltaMessage.content : null;
      const text = asString(content?.text);
      return text === '' ? [] : [chunkFrame(state, { content: text }, null)];
    }

    case 'tool-plan-delta': {
      const plan = asString(deltaMessage?.tool_plan);
      return plan === '' ? [] : [chunkFrame(state, { reasoning_content: plan }, null)];
    }

    case 'tool-call-start': {
      const call = isRecord(deltaMessage?.tool_calls) ? deltaMessage.tool_calls : null;
      if (call === null) return [];
      const fn = isRecord(call.function) ? call.function : null;
      state.finishReason = 'tool_calls';
      return [
        chunkFrame(
          state,
          {
            tool_calls: [
              {
                index,
                id: asString(call.id, `call_${index}`),
                type: 'function',
                function: { name: asString(fn?.name), arguments: asString(fn?.arguments) },
              },
            ],
          },
          null,
        ),
      ];
    }

    case 'tool-call-delta': {
      const call = isRecord(deltaMessage?.tool_calls) ? deltaMessage.tool_calls : null;
      const fn = isRecord(call?.function) ? call.function : null;
      const args = asString(fn?.arguments);
      return args === ''
        ? []
        : [chunkFrame(state, { tool_calls: [{ index, function: { arguments: args } }] }, null)];
    }

    case 'message-end': {
      if (state.ended) return [];
      state.ended = true;
      if (delta !== null && typeof delta.finish_reason === 'string') {
        state.finishReason =
          state.finishReason === 'tool_calls' ? 'tool_calls' : finishReasonOf(delta.finish_reason);
      }
      const usage = normalizeUsage(delta?.usage);
      if (usage) state.usage = usage;
      return [chunkFrame(state, {}, state.finishReason, usageToOpenAi(state.usage)), DONE_FRAME];
    }

    default:
      return [];
  }
}

// ─── Embeddings & rerank ─────────────────────────────────────────────────────

function embeddingInputs(body: Record<string, unknown>): string[] {
  const input = body.input ?? body.texts;
  if (typeof input === 'string') return [input];
  if (Array.isArray(input)) {
    return input.map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry)));
  }
  return [];
}

function failure(error: AdapterError, httpStatus: number, ttftMs: number | null): AdapterResponse {
  return { ok: false, httpStatus, json: null, stream: null, usage: null, ttftMs, error, headers: {} };
}

async function postJson(
  req: AdapterRequest,
  path: string,
  body: Record<string, unknown>,
): Promise<
  | { kind: 'error'; response: AdapterResponse }
  | { kind: 'ok'; payload: Record<string, unknown>; res: Response; ttftMs: number }
> {
  const startedAt = performance.now();
  const base = effectiveBaseUrl(req.connection, req.provider);

  let url: URL;
  try {
    url = new URL(base + path);
  } catch {
    return {
      kind: 'error',
      response: failure(adapterError('bad_request', `Invalid base URL: ${base}`, base), 0, null),
    };
  }

  const headers = new Headers({ 'content-type': 'application/json', accept: 'application/json' });
  applyAuth(url, headers, req.provider, req.credential);

  let res: Response;
  try {
    res = await timedFetch(
      url.toString(),
      { method: 'POST', headers, body: JSON.stringify(body) },
      { timeoutMs: EXECUTE_TIMEOUT_MS, signal: req.signal },
    );
  } catch (err) {
    return { kind: 'error', response: failure(networkError(err), 0, null) };
  }

  const ttftMs = Math.round(performance.now() - startedAt);
  const surfaced = pickHeaders(res.headers);
  const text = await res.text().catch(() => '');

  if (!res.ok) {
    return {
      kind: 'error',
      response: {
        ...failure(classifyHttpError(res.status, text, res.headers), res.status, ttftMs),
        headers: surfaced,
      },
    };
  }

  const parsed = safeJson(text);
  if (!isRecord(parsed)) {
    return {
      kind: 'error',
      response: {
        ...failure(
          adapterError('unknown', `Unparseable Cohere response: ${text.slice(0, 300)}`, text.slice(0, 4_000)),
          res.status,
          ttftMs,
        ),
        headers: surfaced,
      },
    };
  }

  return { kind: 'ok', payload: parsed, res, ttftMs };
}

async function executeEmbeddings(req: AdapterRequest): Promise<AdapterResponse> {
  const texts = embeddingInputs(req.body);
  if (texts.length === 0) {
    return failure(adapterError('bad_request', 'Embeddings request has no `input`'), 400, null);
  }

  const inputType = typeof req.body.input_type === 'string' ? req.body.input_type : 'search_document';
  const result = await postJson(req, '/v2/embed', {
    model: req.model,
    texts,
    input_type: inputType,
    embedding_types: ['float'],
  });
  if (result.kind === 'error') return result.response;

  const embeddings = isRecord(result.payload.embeddings) ? result.payload.embeddings : null;
  const vectors = asArray(embeddings?.float);
  const meta = isRecord(result.payload.meta) ? result.payload.meta : null;
  const usage = normalizeUsage(meta?.billed_units);

  return {
    ok: true,
    httpStatus: result.res.status,
    json: {
      object: 'list',
      data: vectors.map((values, index) => ({
        object: 'embedding',
        index,
        embedding: Array.isArray(values) ? values : [],
      })),
      model: req.model,
      usage: usageToOpenAi(usage) ?? { prompt_tokens: 0, total_tokens: 0 },
    },
    stream: null,
    usage,
    ttftMs: result.ttftMs,
    error: null,
    headers: pickHeaders(result.res.headers),
  };
}

async function executeRerank(req: AdapterRequest): Promise<AdapterResponse> {
  const documents = asArray(req.body.documents).map((doc) =>
    typeof doc === 'string' ? doc : isRecord(doc) ? asString(doc.text, JSON.stringify(doc)) : String(doc),
  );
  const query = asString(req.body.query);
  if (query === '' || documents.length === 0) {
    return failure(
      adapterError('bad_request', 'Rerank requires both `query` and `documents`'),
      400,
      null,
    );
  }

  const payload: Record<string, unknown> = { model: req.model, query, documents };
  if (typeof req.body.top_n === 'number') payload.top_n = req.body.top_n;

  const result = await postJson(req, '/v2/rerank', payload);
  if (result.kind === 'error') return result.response;

  const results = asArray(result.payload.results).map((entry) => {
    const row = isRecord(entry) ? entry : {};
    const index = typeof row.index === 'number' ? row.index : 0;
    return {
      index,
      relevance_score: typeof row.relevance_score === 'number' ? row.relevance_score : 0,
      document: { text: documents[index] ?? '' },
    };
  });

  return {
    ok: true,
    httpStatus: result.res.status,
    json: { id: asString(result.payload.id, completionId('rerank')), model: req.model, results },
    stream: null,
    usage: null,
    ttftMs: result.ttftMs,
    error: null,
    headers: pickHeaders(result.res.headers),
  };
}

async function execute(req: AdapterRequest): Promise<AdapterResponse> {
  if (req.modality === 'embeddings') return executeEmbeddings(req);
  if (req.modality === 'rerank') return executeRerank(req);
  if (req.modality !== 'chat') {
    return failure(
      adapterError('unsupported', `Cohere adapter has no ${req.modality} endpoint`),
      0,
      null,
    );
  }

  if (!req.stream) {
    const result = await postJson(req, '/v2/chat', toCohereChatBody(req));
    if (result.kind === 'error') return result.response;
    const translated = toOpenAiCompletion(result.payload, req.model);
    return {
      ok: true,
      httpStatus: result.res.status,
      json: translated.json,
      stream: null,
      usage: translated.usage,
      ttftMs: result.ttftMs,
      error: null,
      headers: pickHeaders(result.res.headers),
    };
  }

  const startedAt = performance.now();
  const base = effectiveBaseUrl(req.connection, req.provider);

  let url: URL;
  try {
    url = new URL(`${base}/v2/chat`);
  } catch {
    return failure(adapterError('bad_request', `Invalid base URL: ${base}`, base), 0, null);
  }

  const headers = new Headers({
    'content-type': 'application/json',
    accept: 'text/event-stream',
  });
  applyAuth(url, headers, req.provider, req.credential);

  let res: Response;
  try {
    res = await timedFetch(
      url.toString(),
      { method: 'POST', headers, body: JSON.stringify(toCohereChatBody(req)) },
      { timeoutMs: EXECUTE_TIMEOUT_MS, signal: req.signal },
    );
  } catch (err) {
    return failure(networkError(err), 0, null);
  }

  const headersReceivedMs = Math.round(performance.now() - startedAt);
  const surfaced = pickHeaders(res.headers);

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return {
      ...failure(classifyHttpError(res.status, text, res.headers), res.status, headersReceivedMs),
      headers: surfaced,
    };
  }
  if (res.body === null) {
    return {
      ...failure(adapterError('server', 'Cohere returned an empty stream'), res.status, headersReceivedMs),
      headers: surfaced,
    };
  }

  const state: StreamState = {
    id: completionId(),
    model: req.model,
    usage: null,
    finishReason: 'stop',
    ended: false,
  };
  const response: AdapterResponse = {
    ok: true,
    httpStatus: res.status,
    json: null,
    stream: null,
    usage: null,
    ttftMs: null,
    error: null,
    headers: surfaced,
  };
  response.stream = translateSse({
    upstream: res.body,
    onFirstChunk: () => {
      response.ttftMs = Math.round(performance.now() - startedAt);
    },
    onEvent: (event) => {
      const frames = translateEvent(state, event.data);
      response.usage = state.usage;
      return frames;
    },
    onEnd: () => {
      response.usage = state.usage;
      if (state.ended) return [];
      state.ended = true;
      return [chunkFrame(state, {}, state.finishReason, usageToOpenAi(state.usage)), DONE_FRAME];
    },
  });
  return response;
}

async function probe(
  req: Omit<AdapterRequest, 'body' | 'stream' | 'modality' | 'model'>,
): Promise<{ ok: boolean; latencyMs: number; error: string | null }> {
  const startedAt = performance.now();
  const base = effectiveBaseUrl(req.connection, req.provider);

  // The v2 surface has no models listing; v1 does, and it shares the same host.
  let url: URL;
  try {
    url = new URL(`${base}${req.provider.modelsPath ?? '/v1/models'}`);
  } catch {
    return { ok: false, latencyMs: 0, error: `Invalid base URL: ${base}` };
  }

  const headers = new Headers({ accept: 'application/json' });
  applyAuth(url, headers, req.provider, req.credential);

  try {
    const res = await timedFetch(
      url.toString(),
      { method: 'GET', headers },
      { timeoutMs: PROBE_TIMEOUT_MS, signal: req.signal },
    );
    const latencyMs = Math.round(performance.now() - startedAt);
    if (res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return { ok: true, latencyMs, error: null };
    }
    const text = await res.text().catch(() => '');
    const message = extractErrorMessage(safeJson(text), text || res.statusText);
    return { ok: false, latencyMs, error: `HTTP ${res.status}: ${message.slice(0, 200)}` };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Math.round(performance.now() - startedAt),
      error: networkError(err).message,
    };
  }
}

export const cohereAdapter: ProviderAdapter = {
  kind: 'cohere',
  supports: (modality: Modality): boolean =>
    modality === 'chat' || modality === 'embeddings' || modality === 'rerank',
  execute,
  probe,
};
