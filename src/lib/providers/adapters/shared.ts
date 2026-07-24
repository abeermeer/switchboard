import type {
  AdapterError,
  Connection,
  ProviderCatalogEntry,
  TokenUsage,
} from '@/types/core';

/** Per-attempt ceiling. The router's own signal is the real deadline; this is
 *  only a backstop so a hung socket cannot pin a request forever. */
export const EXECUTE_TIMEOUT_MS = 600_000;
export const PROBE_TIMEOUT_MS = 8_000;

export const DONE_FRAME = 'data: [DONE]\n\n';

export function dataFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export function zeroUsage(): TokenUsage {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function firstNumber(...values: unknown[]): number {
  for (const value of values) {
    const parsed = finiteNumber(value);
    if (parsed !== null) return parsed;
  }
  return 0;
}

export function safeJson(text: string): unknown {
  if (text.trim() === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

// ─── Usage normalization ─────────────────────────────────────────────────────

/**
 * Every provider spells token accounting differently, and OpenAI itself now
 * ships two spellings (chat completions vs. the responses API). One function
 * absorbs all of it so no adapter has to guess.
 */
export function normalizeUsage(raw: unknown): TokenUsage | null {
  if (!isRecord(raw)) return null;

  // Cohere nests the real counts one level down.
  const nested = isRecord(raw.tokens)
    ? raw.tokens
    : isRecord(raw.billed_units)
      ? raw.billed_units
      : null;

  const promptDetails = isRecord(raw.prompt_tokens_details) ? raw.prompt_tokens_details : null;
  const completionDetails = isRecord(raw.completion_tokens_details)
    ? raw.completion_tokens_details
    : null;
  const inputDetails = isRecord(raw.input_tokens_details) ? raw.input_tokens_details : null;
  const outputDetails = isRecord(raw.output_tokens_details) ? raw.output_tokens_details : null;

  const promptTokens = firstNumber(
    raw.prompt_tokens,
    raw.input_tokens,
    raw.promptTokenCount,
    nested?.input_tokens,
  );
  const completionTokens = firstNumber(
    raw.completion_tokens,
    raw.output_tokens,
    raw.candidatesTokenCount,
    nested?.output_tokens,
  );
  const cachedTokens = firstNumber(
    promptDetails?.cached_tokens,
    inputDetails?.cached_tokens,
    raw.cache_read_input_tokens,
    raw.cachedContentTokenCount,
  );
  const reasoningTokens = firstNumber(
    completionDetails?.reasoning_tokens,
    outputDetails?.reasoning_tokens,
    raw.thoughtsTokenCount,
    raw.reasoning_tokens,
  );
  const declaredTotal = firstNumber(raw.total_tokens, raw.totalTokenCount);

  if (
    promptTokens === 0 &&
    completionTokens === 0 &&
    declaredTotal === 0 &&
    cachedTokens === 0 &&
    reasoningTokens === 0
  ) {
    return null;
  }

  return {
    promptTokens,
    completionTokens,
    totalTokens: declaredTotal > 0 ? declaredTotal : promptTokens + completionTokens,
    cachedTokens,
    reasoningTokens,
  };
}

/** Anthropic reports input once at message_start and output at message_delta. */
export function mergeUsage(a: TokenUsage | null, b: TokenUsage | null): TokenUsage | null {
  if (!a) return b;
  if (!b) return a;
  const promptTokens = Math.max(a.promptTokens, b.promptTokens);
  const completionTokens = Math.max(a.completionTokens, b.completionTokens);
  return {
    promptTokens,
    completionTokens,
    totalTokens: Math.max(a.totalTokens, b.totalTokens, promptTokens + completionTokens),
    cachedTokens: Math.max(a.cachedTokens, b.cachedTokens),
    reasoningTokens: Math.max(a.reasoningTokens, b.reasoningTokens),
  };
}

// ─── URLs, auth and headers ──────────────────────────────────────────────────

export function effectiveBaseUrl(conn: Connection, provider: ProviderCatalogEntry): string {
  const override = (conn.baseUrlOverride ?? '').trim();
  const raw = override.length > 0 ? override : provider.baseUrl;
  return raw.replace(/\/+$/, '');
}

export function applyAuth(
  url: URL,
  headers: Headers,
  provider: ProviderCatalogEntry,
  credential: string | null,
): void {
  for (const [name, value] of Object.entries(provider.extraHeaders ?? {})) {
    headers.set(name, value);
  }
  if (credential === null || credential === '') return;

  switch (provider.authScheme) {
    case 'bearer':
      headers.set('authorization', `Bearer ${credential}`);
      break;
    case 'header':
      headers.set(provider.authHeaderName ?? 'x-api-key', credential);
      break;
    case 'query':
      url.searchParams.set(provider.authQueryParam ?? 'key', credential);
      break;
    case 'none':
      break;
  }
}

const SURFACED_HEADERS = [
  'content-type',
  'retry-after',
  'ratelimit',
  'x-ratelimit',
  'anthropic-ratelimit',
  'x-request-id',
  'request-id',
  'x-groq-region',
  'openai-processing-ms',
  'openai-organization',
];

/** Keeps rate-limit and tracing headers for the request inspector, drops the rest. */
export function pickHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (SURFACED_HEADERS.some((prefix) => lower === prefix || lower.startsWith(prefix))) {
      out[lower] = value;
    }
  });
  return out;
}

// ─── Fetch with timeout ──────────────────────────────────────────────────────

export async function timedFetch(
  url: string,
  init: RequestInit,
  opts: { timeoutMs: number; signal: AbortSignal },
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException('Upstream timed out', 'TimeoutError'));
  }, opts.timeoutMs);

  if (opts.signal.aborted) {
    controller.abort(opts.signal.reason as unknown);
  } else {
    // Deliberately left attached: the caller's signal must still be able to kill
    // a stream long after the headers-phase timer has been cleared.
    opts.signal.addEventListener('abort', () => controller.abort(opts.signal.reason as unknown), {
      once: true,
    });
  }

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ─── Errors ──────────────────────────────────────────────────────────────────

export function extractErrorMessage(body: unknown, fallback: string): string {
  const seen = Array.isArray(body) ? body[0] : body;
  if (typeof seen === 'string' && seen.trim() !== '') return seen.slice(0, 2_000);
  if (!isRecord(seen)) return fallback;

  const error = seen.error;
  if (typeof error === 'string' && error.trim() !== '') return error.slice(0, 2_000);
  if (isRecord(error)) {
    const message = error.message ?? error.msg ?? error.detail ?? error.reason;
    if (typeof message === 'string' && message.trim() !== '') return message.slice(0, 2_000);
  }
  for (const key of ['message', 'detail', 'msg', 'error_message', 'reason']) {
    const value = seen[key];
    if (typeof value === 'string' && value.trim() !== '') return value.slice(0, 2_000);
  }
  return fallback;
}

const CONTEXT_LENGTH_RE = /context|token|too long|maximum|too large|exceeds/i;
const QUOTA_RE = /quota|billing|credit|insufficient.?(balance|funds)|payment|spend limit/i;
const MODEL_MISSING_RE = /model|not found|does not exist|unsupported|unknown|no such/i;

export function classifyHttpError(
  status: number,
  bodyText: string,
  headers: Headers,
): AdapterError {
  const parsed = safeJson(bodyText);
  const message = extractErrorMessage(parsed, bodyText.slice(0, 2_000) || `HTTP ${status}`);
  const retryAfterSec = parseRetryAfter(headers);
  const raw: unknown = parsed ?? bodyText.slice(0, 4_000);
  const base = { message, retryAfterSec, raw };

  if (status === 401 || status === 403) return { ...base, kind: 'auth' };
  if (status === 402) return { ...base, kind: 'quota_exceeded' };
  if (status === 429) {
    return { ...base, kind: QUOTA_RE.test(message) ? 'quota_exceeded' : 'rate_limit' };
  }
  if (status === 413) return { ...base, kind: 'context_length' };
  if (status === 404 || status === 400) {
    if (status === 400 && CONTEXT_LENGTH_RE.test(message)) return { ...base, kind: 'context_length' };
    if (status === 404) {
      return { ...base, kind: MODEL_MISSING_RE.test(message) ? 'unsupported' : 'bad_request' };
    }
    if (MODEL_MISSING_RE.test(message) && /model/i.test(message)) {
      return { ...base, kind: 'unsupported' };
    }
    return { ...base, kind: 'bad_request' };
  }
  if (status === 422) return { ...base, kind: 'bad_request' };
  if (status === 408 || status === 504) return { ...base, kind: 'timeout' };
  if (status >= 500) return { ...base, kind: 'server' };
  return { ...base, kind: 'unknown' };
}

export function networkError(err: unknown): AdapterError {
  const name = err instanceof Error ? err.name : '';
  const message = err instanceof Error ? err.message : String(err);
  if (name === 'TimeoutError' || name === 'AbortError') {
    return { kind: 'timeout', message: message || 'Request aborted', retryAfterSec: null, raw: message };
  }
  const cause = err instanceof Error && err.cause instanceof Error ? `: ${err.cause.message}` : '';
  return { kind: 'network', message: `${message}${cause}`, retryAfterSec: null, raw: message };
}

export function adapterError(
  kind: AdapterError['kind'],
  message: string,
  raw: unknown = null,
): AdapterError {
  return { kind, message, retryAfterSec: null, raw };
}

// ─── Retry-After ─────────────────────────────────────────────────────────────

const DURATION_PART_RE = /(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)/gi;
const UNIT_SECONDS: Record<string, number> = { ms: 0.001, s: 1, m: 60, h: 3_600, d: 86_400 };

const RESET_HEADERS = [
  'retry-after',
  'retry-after-ms',
  'x-ratelimit-reset-requests',
  'x-ratelimit-reset-tokens',
  'x-ratelimit-reset-after',
  'x-ratelimit-reset',
  'ratelimit-reset',
  'anthropic-ratelimit-requests-reset',
  'anthropic-ratelimit-tokens-reset',
];

export function parseRetryAfter(headers: Headers): number | null {
  for (const name of RESET_HEADERS) {
    const parsed = parseDurationHeader(headers.get(name), name.endsWith('-ms'));
    if (parsed !== null) return parsed;
  }
  return null;
}

/** Handles "12", "1.5s", "2m59.56s", an ISO reset timestamp and epoch seconds. */
export function parseDurationHeader(raw: string | null, isMillis = false): number | null {
  if (raw === null) return null;
  const value = raw.trim();
  if (value === '') return null;

  const plain = Number(value);
  if (Number.isFinite(plain)) {
    if (isMillis) return clampSeconds(plain / 1_000);
    // Providers occasionally hand back an absolute reset instant rather than a delta.
    if (plain > 1e12) return clampSeconds((plain - Date.now()) / 1_000);
    if (plain > 1e9) return clampSeconds(plain - Date.now() / 1_000);
    return clampSeconds(plain);
  }

  DURATION_PART_RE.lastIndex = 0;
  let total = 0;
  let matched = false;
  for (const match of value.matchAll(DURATION_PART_RE)) {
    const amount = Number(match[1]);
    const unit = (match[2] ?? 's').toLowerCase();
    const multiplier = UNIT_SECONDS[unit];
    if (!Number.isFinite(amount) || multiplier === undefined) continue;
    total += amount * multiplier;
    matched = true;
  }
  if (matched) return clampSeconds(total);

  const asDate = Date.parse(value);
  if (Number.isFinite(asDate)) return clampSeconds((asDate - Date.now()) / 1_000);
  return null;
}

function clampSeconds(seconds: number): number | null {
  if (!Number.isFinite(seconds)) return null;
  if (seconds < 0) return 0;
  return Math.min(Math.round(seconds * 100) / 100, 3_600);
}

// ─── SSE ─────────────────────────────────────────────────────────────────────

export interface SseEvent {
  event: string | null;
  data: string;
}

function parseSseBlock(block: string): SseEvent | null {
  let event: string | null = null;
  const data: string[] = [];

  for (const line of block.split('\n')) {
    if (line === '' || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }

  if (data.length === 0) return null;
  return { event, data: data.join('\n') };
}

/** Incremental SSE reader. Frames arrive split across arbitrary byte chunks. */
export class SseDecoder {
  private buffer = '';

  push(text: string): SseEvent[] {
    this.buffer += text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const events: SseEvent[] = [];
    let split = this.buffer.indexOf('\n\n');
    while (split !== -1) {
      const block = this.buffer.slice(0, split);
      this.buffer = this.buffer.slice(split + 2);
      const event = parseSseBlock(block);
      if (event) events.push(event);
      split = this.buffer.indexOf('\n\n');
    }
    return events;
  }

  flush(): SseEvent[] {
    const rest = this.buffer;
    this.buffer = '';
    if (rest.trim() === '') return [];
    const event = parseSseBlock(rest);
    return event ? [event] : [];
  }
}

/**
 * Forwards the upstream stream byte-for-byte while sniffing frames in passing.
 *
 * A real `ReadableStream.tee()` buffers unboundedly for whichever branch reads
 * slower — with a slow HTTP client that means holding the entire completion in
 * memory. A pass-through transform observes the same bytes with none of that.
 */
export function passthroughSse(opts: {
  upstream: ReadableStream<Uint8Array>;
  onFirstChunk: () => void;
  onEvent: (event: SseEvent) => void;
}): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const sse = new SseDecoder();
  let first = true;

  return opts.upstream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (first) {
          first = false;
          opts.onFirstChunk();
        }
        for (const event of sse.push(decoder.decode(chunk, { stream: true }))) opts.onEvent(event);
        controller.enqueue(chunk);
      },
      flush() {
        for (const event of sse.push(decoder.decode())) opts.onEvent(event);
        for (const event of sse.flush()) opts.onEvent(event);
      },
    }),
  );
}

/** Same plumbing, but the mapper rewrites each frame into OpenAI-shaped SSE. */
export function translateSse(opts: {
  upstream: ReadableStream<Uint8Array>;
  onFirstChunk: () => void;
  onEvent: (event: SseEvent) => string[];
  onEnd: () => string[];
}): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const sse = new SseDecoder();
  let first = true;

  return opts.upstream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (first) {
          first = false;
          opts.onFirstChunk();
        }
        for (const event of sse.push(decoder.decode(chunk, { stream: true }))) {
          for (const frame of opts.onEvent(event)) controller.enqueue(encoder.encode(frame));
        }
      },
      flush(controller) {
        const trailing = [...sse.push(decoder.decode()), ...sse.flush()];
        for (const event of trailing) {
          for (const frame of opts.onEvent(event)) controller.enqueue(encoder.encode(frame));
        }
        for (const frame of opts.onEnd()) controller.enqueue(encoder.encode(frame));
      },
    }),
  );
}

// ─── Small OpenAI-shape builders shared by the translating adapters ──────────

export function completionId(prefix = 'chatcmpl'): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`;
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1_000);
}

export function usageToOpenAi(usage: TokenUsage | null): Record<string, unknown> | null {
  if (!usage) return null;
  const out: Record<string, unknown> = {
    prompt_tokens: usage.promptTokens,
    completion_tokens: usage.completionTokens,
    total_tokens: usage.totalTokens,
  };
  if (usage.cachedTokens > 0) out.prompt_tokens_details = { cached_tokens: usage.cachedTokens };
  if (usage.reasoningTokens > 0) {
    out.completion_tokens_details = { reasoning_tokens: usage.reasoningTokens };
  }
  return out;
}

/** Flattens OpenAI's string-or-parts content into plain text. */
export function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const pieces: string[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      pieces.push(part);
      continue;
    }
    if (!isRecord(part)) continue;
    if (typeof part.text === 'string') pieces.push(part.text);
  }
  return pieces.join('');
}

export function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (isRecord(raw)) return raw;
  if (typeof raw === 'string') {
    const parsed = safeJson(raw);
    if (isRecord(parsed)) return parsed;
  }
  return {};
}
