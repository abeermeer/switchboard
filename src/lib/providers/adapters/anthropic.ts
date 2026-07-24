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
  mergeUsage,
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

const DEFAULT_MAX_TOKENS = 4_096;
const DATA_URI_RE = /^data:([^;,]+);base64,(.*)$/s;

// ─── OpenAI → Anthropic ──────────────────────────────────────────────────────

function toAnthropicContent(content: unknown): unknown {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return contentToText(content);

  const blocks: unknown[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      blocks.push({ type: 'text', text: part });
      continue;
    }
    if (!isRecord(part)) continue;

    const type = asString(part.type);
    if (type === 'text' || typeof part.text === 'string') {
      blocks.push({ type: 'text', text: asString(part.text) });
      continue;
    }
    if (type === 'image_url') {
      const holder = isRecord(part.image_url) ? part.image_url : null;
      const url = asString(holder?.url);
      if (url === '') continue;
      const dataUri = DATA_URI_RE.exec(url);
      blocks.push(
        dataUri
          ? {
              type: 'image',
              source: { type: 'base64', media_type: dataUri[1] ?? 'image/png', data: dataUri[2] ?? '' },
            }
          : { type: 'image', source: { type: 'url', url } },
      );
    }
  }
  return blocks.length > 0 ? blocks : '';
}

function toAnthropicTools(raw: unknown): unknown[] {
  const tools: unknown[] = [];
  for (const entry of asArray(raw)) {
    if (!isRecord(entry)) continue;
    const fn = isRecord(entry.function) ? entry.function : entry;
    const name = asString(fn.name);
    if (name === '') continue;
    tools.push({
      name,
      description: asString(fn.description),
      input_schema: isRecord(fn.parameters)
        ? fn.parameters
        : { type: 'object', properties: {} },
    });
  }
  return tools;
}

function toAnthropicToolChoice(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === 'string') {
    if (raw === 'auto') return { type: 'auto' };
    if (raw === 'required') return { type: 'any' };
    if (raw === 'none') return { type: 'none' };
    return null;
  }
  if (isRecord(raw)) {
    const fn = isRecord(raw.function) ? raw.function : null;
    const name = asString(fn?.name ?? raw.name);
    if (name !== '') return { type: 'tool', name };
  }
  return null;
}

function toAnthropicBody(req: AdapterRequest): Record<string, unknown> {
  const src = req.body;
  const systemParts: string[] = [];
  const messages: Array<Record<string, unknown>> = [];

  for (const raw of asArray(src.messages)) {
    if (!isRecord(raw)) continue;
    const role = asString(raw.role, 'user');

    if (role === 'system' || role === 'developer') {
      const text = contentToText(raw.content);
      if (text !== '') systemParts.push(text);
      continue;
    }

    if (role === 'tool' || role === 'function') {
      const block = {
        type: 'tool_result',
        tool_use_id: asString(raw.tool_call_id ?? raw.id),
        content: contentToText(raw.content),
      };
      // Anthropic wants consecutive tool results collapsed into one user turn.
      const last = messages[messages.length - 1];
      if (last !== undefined && last.role === 'user' && Array.isArray(last.content)) {
        (last.content as unknown[]).push(block);
      } else {
        messages.push({ role: 'user', content: [block] });
      }
      continue;
    }

    if (role === 'assistant') {
      const blocks: unknown[] = [];
      const text = contentToText(raw.content);
      if (text !== '') blocks.push({ type: 'text', text });
      for (const call of asArray(raw.tool_calls)) {
        if (!isRecord(call)) continue;
        const fn = isRecord(call.function) ? call.function : null;
        blocks.push({
          type: 'tool_use',
          id: asString(call.id, `toolu_${Math.random().toString(36).slice(2, 12)}`),
          name: asString(fn?.name),
          input: parseToolArguments(fn?.arguments),
        });
      }
      if (blocks.length > 0) messages.push({ role: 'assistant', content: blocks });
      continue;
    }

    messages.push({ role: 'user', content: toAnthropicContent(raw.content) });
  }

  const maxTokens =
    typeof src.max_tokens === 'number'
      ? src.max_tokens
      : typeof src.max_completion_tokens === 'number'
        ? src.max_completion_tokens
        : DEFAULT_MAX_TOKENS;

  const body: Record<string, unknown> = {
    model: req.model,
    messages,
    max_tokens: maxTokens,
  };

  if (systemParts.length > 0) body.system = systemParts.join('\n\n');
  if (typeof src.temperature === 'number') body.temperature = src.temperature;
  if (typeof src.top_p === 'number') body.top_p = src.top_p;
  if (typeof src.top_k === 'number') body.top_k = src.top_k;
  if (typeof src.stop === 'string') body.stop_sequences = [src.stop];
  else if (Array.isArray(src.stop)) body.stop_sequences = src.stop;

  const tools = toAnthropicTools(src.tools);
  if (tools.length > 0) {
    body.tools = tools;
    const choice = toAnthropicToolChoice(src.tool_choice);
    if (choice !== null) body.tool_choice = choice;
  }
  if (req.stream) body.stream = true;
  if (isRecord(src.thinking)) body.thinking = src.thinking;

  return body;
}

// ─── Anthropic → OpenAI ──────────────────────────────────────────────────────

function finishReasonOf(stopReason: unknown): string {
  switch (asString(stopReason)) {
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'refusal':
      return 'content_filter';
    default:
      return 'stop';
  }
}

function toOpenAiCompletion(payload: Record<string, unknown>, fallbackModel: string): {
  json: Record<string, unknown>;
  usage: TokenUsage | null;
} {
  const text: string[] = [];
  const thinking: string[] = [];
  const toolCalls: unknown[] = [];

  for (const block of asArray(payload.content)) {
    if (!isRecord(block)) continue;
    const type = asString(block.type);
    if (type === 'text') text.push(asString(block.text));
    else if (type === 'thinking') thinking.push(asString(block.thinking));
    else if (type === 'tool_use') {
      toolCalls.push({
        id: asString(block.id),
        type: 'function',
        function: {
          name: asString(block.name),
          arguments: JSON.stringify(block.input ?? {}),
        },
      });
    }
  }

  const usage = normalizeUsage(payload.usage);
  const message: Record<string, unknown> = {
    role: 'assistant',
    content: text.length > 0 ? text.join('') : null,
  };
  if (thinking.length > 0) message.reasoning_content = thinking.join('');
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  return {
    json: {
      id: asString(payload.id, completionId()),
      object: 'chat.completion',
      created: nowSeconds(),
      model: asString(payload.model, fallbackModel),
      choices: [
        {
          index: 0,
          message,
          logprobs: null,
          finish_reason:
            toolCalls.length > 0 ? 'tool_calls' : finishReasonOf(payload.stop_reason),
        },
      ],
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
  toolIndexByBlock: Map<number, number>;
  toolCount: number;
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

  switch (type) {
    case 'message_start': {
      const message = isRecord(payload.message) ? payload.message : null;
      state.id = asString(message?.id, state.id);
      state.model = asString(message?.model, state.model);
      state.usage = mergeUsage(state.usage, normalizeUsage(message?.usage));
      return [chunkFrame(state, { role: 'assistant', content: '' }, null)];
    }

    case 'content_block_start': {
      const block = isRecord(payload.content_block) ? payload.content_block : null;
      if (block === null || asString(block.type) !== 'tool_use') return [];
      const blockIndex = typeof payload.index === 'number' ? payload.index : state.toolCount;
      const toolIndex = state.toolCount;
      state.toolCount += 1;
      state.toolIndexByBlock.set(blockIndex, toolIndex);
      return [
        chunkFrame(
          state,
          {
            tool_calls: [
              {
                index: toolIndex,
                id: asString(block.id),
                type: 'function',
                function: { name: asString(block.name), arguments: '' },
              },
            ],
          },
          null,
        ),
      ];
    }

    case 'content_block_delta': {
      const delta = isRecord(payload.delta) ? payload.delta : null;
      if (delta === null) return [];
      const deltaType = asString(delta.type);

      if (deltaType === 'text_delta') {
        return [chunkFrame(state, { content: asString(delta.text) }, null)];
      }
      if (deltaType === 'thinking_delta') {
        return [chunkFrame(state, { reasoning_content: asString(delta.thinking) }, null)];
      }
      if (deltaType === 'input_json_delta') {
        const blockIndex = typeof payload.index === 'number' ? payload.index : 0;
        const toolIndex = state.toolIndexByBlock.get(blockIndex) ?? 0;
        return [
          chunkFrame(
            state,
            {
              tool_calls: [
                {
                  index: toolIndex,
                  function: { arguments: asString(delta.partial_json) },
                },
              ],
            },
            null,
          ),
        ];
      }
      return [];
    }

    case 'message_delta': {
      const delta = isRecord(payload.delta) ? payload.delta : null;
      if (delta !== null && typeof delta.stop_reason === 'string') {
        state.finishReason =
          state.toolCount > 0 && delta.stop_reason === 'tool_use'
            ? 'tool_calls'
            : finishReasonOf(delta.stop_reason);
      }
      state.usage = mergeUsage(state.usage, normalizeUsage(payload.usage));
      return [];
    }

    case 'message_stop': {
      if (state.ended) return [];
      state.ended = true;
      return [
        chunkFrame(state, {}, state.finishReason, usageToOpenAi(state.usage)),
        DONE_FRAME,
      ];
    }

    case 'error': {
      if (state.ended) return [];
      state.ended = true;
      const message = extractErrorMessage(payload, 'Upstream stream error');
      return [dataFrame({ error: { message, type: 'upstream_error' } }), DONE_FRAME];
    }

    default:
      return [];
  }
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

function failure(error: AdapterError, httpStatus: number, ttftMs: number | null): AdapterResponse {
  return { ok: false, httpStatus, json: null, stream: null, usage: null, ttftMs, error, headers: {} };
}

async function execute(req: AdapterRequest): Promise<AdapterResponse> {
  if (req.modality !== 'chat') {
    return failure(
      adapterError('unsupported', `Anthropic has no ${req.modality} endpoint`),
      0,
      null,
    );
  }

  const startedAt = performance.now();
  const base = effectiveBaseUrl(req.connection, req.provider);

  let url: URL;
  try {
    url = new URL(`${base}/messages`);
  } catch {
    return failure(adapterError('bad_request', `Invalid base URL: ${base}`, base), 0, null);
  }

  const headers = new Headers({
    'content-type': 'application/json',
    accept: req.stream ? 'text/event-stream' : 'application/json',
  });
  applyAuth(url, headers, req.provider, req.credential);
  if (!headers.has('anthropic-version')) headers.set('anthropic-version', '2023-06-01');

  let res: Response;
  try {
    res = await timedFetch(
      url.toString(),
      { method: 'POST', headers, body: JSON.stringify(toAnthropicBody(req)) },
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
      toolIndexByBlock: new Map(),
      toolCount: 0,
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
        adapterError('unknown', `Unparseable Anthropic response: ${text.slice(0, 300)}`, text.slice(0, 4_000)),
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
  if (!headers.has('anthropic-version')) headers.set('anthropic-version', '2023-06-01');

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

export const anthropicAdapter: ProviderAdapter = {
  kind: 'anthropic',
  supports: (modality: Modality): boolean => modality === 'chat',
  execute,
  probe,
};
