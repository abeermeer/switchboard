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
  parseToolArguments,
  pickHeaders,
  safeJson,
  timedFetch,
  translateSse,
  usageToOpenAi,
} from './shared';

const DATA_URI_RE = /^data:([^;,]+);base64,(.*)$/s;

function modelPath(model: string): string {
  return model.startsWith('models/') ? model : `models/${model}`;
}

// ─── OpenAI → Gemini ─────────────────────────────────────────────────────────

function toGeminiParts(content: unknown): unknown[] {
  if (typeof content === 'string') return content === '' ? [] : [{ text: content }];
  if (!Array.isArray(content)) {
    const text = contentToText(content);
    return text === '' ? [] : [{ text }];
  }

  const parts: unknown[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push({ text: part });
      continue;
    }
    if (!isRecord(part)) continue;
    const type = asString(part.type);

    if (type === 'text' || typeof part.text === 'string') {
      parts.push({ text: asString(part.text) });
      continue;
    }
    if (type === 'image_url') {
      const holder = isRecord(part.image_url) ? part.image_url : null;
      const url = asString(holder?.url);
      if (url === '') continue;
      const dataUri = DATA_URI_RE.exec(url);
      parts.push(
        dataUri
          ? { inline_data: { mime_type: dataUri[1] ?? 'image/png', data: dataUri[2] ?? '' } }
          : { file_data: { file_uri: url } },
      );
    }
  }
  return parts;
}

function toGeminiTools(raw: unknown): unknown[] {
  const declarations: unknown[] = [];
  for (const entry of asArray(raw)) {
    if (!isRecord(entry)) continue;
    const fn = isRecord(entry.function) ? entry.function : entry;
    const name = asString(fn.name);
    if (name === '') continue;
    declarations.push({
      name,
      description: asString(fn.description),
      parameters: isRecord(fn.parameters) ? fn.parameters : { type: 'object', properties: {} },
    });
  }
  return declarations.length > 0 ? [{ functionDeclarations: declarations }] : [];
}

function toGeminiBody(req: AdapterRequest): Record<string, unknown> {
  const src = req.body;
  const systemParts: string[] = [];
  const contents: Array<Record<string, unknown>> = [];
  // OpenAI tool results carry only the call id; Gemini wants the function name.
  const nameByCallId = new Map<string, string>();

  for (const raw of asArray(src.messages)) {
    if (!isRecord(raw)) continue;
    const role = asString(raw.role, 'user');

    if (role === 'system' || role === 'developer') {
      const text = contentToText(raw.content);
      if (text !== '') systemParts.push(text);
      continue;
    }

    if (role === 'tool' || role === 'function') {
      const callId = asString(raw.tool_call_id ?? raw.id);
      const name = nameByCallId.get(callId) ?? asString(raw.name, 'tool');
      contents.push({
        role: 'user',
        parts: [
          {
            functionResponse: {
              name,
              response: { content: contentToText(raw.content) },
            },
          },
        ],
      });
      continue;
    }

    if (role === 'assistant') {
      const parts: unknown[] = [];
      const text = contentToText(raw.content);
      if (text !== '') parts.push({ text });
      for (const call of asArray(raw.tool_calls)) {
        if (!isRecord(call)) continue;
        const fn = isRecord(call.function) ? call.function : null;
        const name = asString(fn?.name);
        nameByCallId.set(asString(call.id), name);
        parts.push({ functionCall: { name, args: parseToolArguments(fn?.arguments) } });
      }
      if (parts.length > 0) contents.push({ role: 'model', parts });
      continue;
    }

    const parts = toGeminiParts(raw.content);
    if (parts.length > 0) contents.push({ role: 'user', parts });
  }

  const generationConfig: Record<string, unknown> = {};
  if (typeof src.temperature === 'number') generationConfig.temperature = src.temperature;
  if (typeof src.top_p === 'number') generationConfig.topP = src.top_p;
  if (typeof src.top_k === 'number') generationConfig.topK = src.top_k;
  if (typeof src.max_tokens === 'number') generationConfig.maxOutputTokens = src.max_tokens;
  else if (typeof src.max_completion_tokens === 'number') {
    generationConfig.maxOutputTokens = src.max_completion_tokens;
  }
  if (typeof src.n === 'number') generationConfig.candidateCount = src.n;
  if (typeof src.stop === 'string') generationConfig.stopSequences = [src.stop];
  else if (Array.isArray(src.stop)) generationConfig.stopSequences = src.stop;

  const responseFormat = isRecord(src.response_format) ? src.response_format : null;
  const formatType = asString(responseFormat?.type);
  if (formatType === 'json_object') generationConfig.responseMimeType = 'application/json';
  else if (formatType === 'json_schema') {
    generationConfig.responseMimeType = 'application/json';
    const schema = isRecord(responseFormat?.json_schema) ? responseFormat.json_schema : null;
    if (isRecord(schema?.schema)) generationConfig.responseSchema = schema.schema;
  }

  const body: Record<string, unknown> = { contents };
  if (systemParts.length > 0) {
    body.systemInstruction = { parts: [{ text: systemParts.join('\n\n') }] };
  }
  if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;

  const tools = toGeminiTools(src.tools);
  if (tools.length > 0) {
    body.tools = tools;
    const choice = src.tool_choice;
    if (typeof choice === 'string') {
      const mode = choice === 'required' ? 'ANY' : choice === 'none' ? 'NONE' : 'AUTO';
      body.toolConfig = { functionCallingConfig: { mode } };
    } else if (isRecord(choice)) {
      const fn = isRecord(choice.function) ? choice.function : null;
      const name = asString(fn?.name ?? choice.name);
      if (name !== '') {
        body.toolConfig = {
          functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [name] },
        };
      }
    }
  }
  if (Array.isArray(src.safety_settings)) body.safetySettings = src.safety_settings;

  return body;
}

// ─── Gemini → OpenAI ─────────────────────────────────────────────────────────

function finishReasonOf(raw: unknown): string {
  switch (asString(raw)) {
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
    case 'RECITATION':
    case 'PROHIBITED_CONTENT':
    case 'BLOCKLIST':
      return 'content_filter';
    case 'MALFORMED_FUNCTION_CALL':
      return 'tool_calls';
    default:
      return 'stop';
  }
}

interface CandidateParts {
  text: string;
  thinking: string;
  toolCalls: unknown[];
}

function readParts(candidate: Record<string, unknown>, toolSeed: number): CandidateParts {
  const content = isRecord(candidate.content) ? candidate.content : null;
  const text: string[] = [];
  const thinking: string[] = [];
  const toolCalls: unknown[] = [];

  for (const part of asArray(content?.parts)) {
    if (!isRecord(part)) continue;
    if (isRecord(part.functionCall)) {
      const call = part.functionCall;
      toolCalls.push({
        index: toolSeed + toolCalls.length,
        id: `call_${asString(call.name, 'fn')}_${toolSeed + toolCalls.length}`,
        type: 'function',
        function: {
          name: asString(call.name),
          arguments: JSON.stringify(call.args ?? {}),
        },
      });
      continue;
    }
    if (typeof part.text === 'string') {
      if (part.thought === true) thinking.push(part.text);
      else text.push(part.text);
    }
  }

  return { text: text.join(''), thinking: thinking.join(''), toolCalls };
}

function toOpenAiCompletion(
  payload: Record<string, unknown>,
  model: string,
): { json: Record<string, unknown>; usage: TokenUsage | null } {
  const usage = normalizeUsage(payload.usageMetadata);
  const choices: unknown[] = [];

  asArray(payload.candidates).forEach((raw, index) => {
    if (!isRecord(raw)) return;
    const parts = readParts(raw, 0);
    const message: Record<string, unknown> = {
      role: 'assistant',
      content: parts.text !== '' ? parts.text : null,
    };
    if (parts.thinking !== '') message.reasoning_content = parts.thinking;
    if (parts.toolCalls.length > 0) message.tool_calls = parts.toolCalls;

    choices.push({
      index: typeof raw.index === 'number' ? raw.index : index,
      message,
      logprobs: null,
      finish_reason:
        parts.toolCalls.length > 0 ? 'tool_calls' : finishReasonOf(raw.finishReason),
    });
  });

  if (choices.length === 0) {
    choices.push({
      index: 0,
      message: { role: 'assistant', content: null },
      logprobs: null,
      finish_reason: 'content_filter',
    });
  }

  return {
    json: {
      id: completionId(),
      object: 'chat.completion',
      created: nowSeconds(),
      model: asString(payload.modelVersion, model),
      choices,
      usage: usageToOpenAi(usage) ?? {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    },
    usage,
  };
}

interface StreamState {
  id: string;
  model: string;
  usage: TokenUsage | null;
  finishReason: string;
  toolCount: number;
  roleSent: boolean;
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

  const usage = normalizeUsage(payload.usageMetadata);
  if (usage) state.usage = usage;
  state.model = asString(payload.modelVersion, state.model);

  const frames: string[] = [];
  if (!state.roleSent) {
    state.roleSent = true;
    frames.push(chunkFrame(state, { role: 'assistant', content: '' }, null));
  }

  for (const raw of asArray(payload.candidates)) {
    if (!isRecord(raw)) continue;
    const parts = readParts(raw, state.toolCount);
    if (parts.thinking !== '') {
      frames.push(chunkFrame(state, { reasoning_content: parts.thinking }, null));
    }
    if (parts.text !== '') frames.push(chunkFrame(state, { content: parts.text }, null));
    if (parts.toolCalls.length > 0) {
      state.toolCount += parts.toolCalls.length;
      state.finishReason = 'tool_calls';
      frames.push(chunkFrame(state, { tool_calls: parts.toolCalls }, null));
    }
    if (typeof raw.finishReason === 'string' && state.finishReason !== 'tool_calls') {
      state.finishReason = finishReasonOf(raw.finishReason);
    }
  }
  return frames;
}

// ─── Embeddings ──────────────────────────────────────────────────────────────

function embeddingInputs(body: Record<string, unknown>): string[] {
  const input = body.input;
  if (typeof input === 'string') return [input];
  if (Array.isArray(input)) {
    return input.map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry)));
  }
  return [];
}

function toOpenAiEmbeddings(
  vectors: unknown[],
  model: string,
): Record<string, unknown> {
  return {
    object: 'list',
    data: vectors.map((values, index) => ({
      object: 'embedding',
      index,
      embedding: Array.isArray(values) ? values : [],
    })),
    model,
    usage: { prompt_tokens: 0, total_tokens: 0 },
  };
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

function failure(error: AdapterError, httpStatus: number, ttftMs: number | null): AdapterResponse {
  return { ok: false, httpStatus, json: null, stream: null, usage: null, ttftMs, error, headers: {} };
}

async function executeEmbeddings(req: AdapterRequest, base: string): Promise<AdapterResponse> {
  const startedAt = performance.now();
  const inputs = embeddingInputs(req.body);
  if (inputs.length === 0) {
    return failure(adapterError('bad_request', 'Embeddings request has no `input`'), 400, null);
  }

  const batched = inputs.length > 1;
  const method = batched ? 'batchEmbedContents' : 'embedContent';
  const dimensions = typeof req.body.dimensions === 'number' ? req.body.dimensions : undefined;

  let url: URL;
  try {
    url = new URL(`${base}/${modelPath(req.model)}:${method}`);
  } catch {
    return failure(adapterError('bad_request', `Invalid base URL: ${base}`, base), 0, null);
  }

  const headers = new Headers({ 'content-type': 'application/json', accept: 'application/json' });
  applyAuth(url, headers, req.provider, req.credential);

  const single = (text: string): Record<string, unknown> => {
    const entry: Record<string, unknown> = {
      model: modelPath(req.model),
      content: { parts: [{ text }] },
    };
    if (dimensions !== undefined) entry.outputDimensionality = dimensions;
    return entry;
  };
  const first = inputs[0] ?? '';
  const body = batched
    ? { requests: inputs.map(single) }
    : single(first);

  let res: Response;
  try {
    res = await timedFetch(
      url.toString(),
      { method: 'POST', headers, body: JSON.stringify(body) },
      { timeoutMs: EXECUTE_TIMEOUT_MS, signal: req.signal },
    );
  } catch (err) {
    return failure(networkError(err), 0, null);
  }

  const ttftMs = Math.round(performance.now() - startedAt);
  const surfaced = pickHeaders(res.headers);
  const text = await res.text().catch(() => '');

  if (!res.ok) {
    return {
      ...failure(classifyHttpError(res.status, text, res.headers), res.status, ttftMs),
      headers: surfaced,
    };
  }

  const parsed = safeJson(text);
  if (!isRecord(parsed)) {
    return {
      ...failure(adapterError('unknown', 'Unparseable embeddings response', text.slice(0, 2_000)), res.status, ttftMs),
      headers: surfaced,
    };
  }

  const vectors: unknown[] = batched
    ? asArray(parsed.embeddings).map((entry) => (isRecord(entry) ? entry.values : []))
    : [isRecord(parsed.embedding) ? parsed.embedding.values : []];

  return {
    ok: true,
    httpStatus: res.status,
    json: toOpenAiEmbeddings(vectors, req.model),
    stream: null,
    usage: null,
    ttftMs,
    error: null,
    headers: surfaced,
  };
}

async function execute(req: AdapterRequest): Promise<AdapterResponse> {
  const base = effectiveBaseUrl(req.connection, req.provider);

  if (req.modality === 'embeddings') return executeEmbeddings(req, base);
  if (req.modality !== 'chat') {
    return failure(
      adapterError('unsupported', `Gemini adapter has no ${req.modality} endpoint`),
      0,
      null,
    );
  }

  const startedAt = performance.now();
  const method = req.stream ? 'streamGenerateContent' : 'generateContent';

  let url: URL;
  try {
    url = new URL(`${base}/${modelPath(req.model)}:${method}`);
  } catch {
    return failure(adapterError('bad_request', `Invalid base URL: ${base}`, base), 0, null);
  }
  if (req.stream) url.searchParams.set('alt', 'sse');

  const headers = new Headers({
    'content-type': 'application/json',
    accept: req.stream ? 'text/event-stream' : 'application/json',
  });
  applyAuth(url, headers, req.provider, req.credential);

  let res: Response;
  try {
    res = await timedFetch(
      url.toString(),
      { method: 'POST', headers, body: JSON.stringify(toGeminiBody(req)) },
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

  if (req.stream && res.body !== null) {
    const state: StreamState = {
      id: completionId(),
      model: req.model,
      usage: null,
      finishReason: 'stop',
      toolCount: 0,
      roleSent: false,
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

  const text = await res.text().catch(() => '');
  const parsed = safeJson(text);
  if (!isRecord(parsed)) {
    return {
      ...failure(
        adapterError('unknown', `Unparseable Gemini response: ${text.slice(0, 300)}`, text.slice(0, 4_000)),
        res.status,
        headersReceivedMs,
      ),
      headers: surfaced,
    };
  }

  const translated = toOpenAiCompletion(parsed, req.model);
  return {
    ok: true,
    httpStatus: res.status,
    json: translated.json,
    stream: null,
    usage: translated.usage,
    ttftMs: headersReceivedMs,
    error: null,
    headers: surfaced,
  };
}

async function probe(
  req: Omit<AdapterRequest, 'body' | 'stream' | 'modality' | 'model'>,
): Promise<{ ok: boolean; latencyMs: number; error: string | null }> {
  const startedAt = performance.now();
  const base = effectiveBaseUrl(req.connection, req.provider);

  let url: URL;
  try {
    url = new URL(`${base}${req.provider.modelsPath ?? '/models'}`);
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

export const googleAdapter: ProviderAdapter = {
  kind: 'google',
  supports: (modality: Modality): boolean => modality === 'chat' || modality === 'embeddings',
  execute,
  probe,
};
