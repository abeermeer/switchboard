import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DONE_FRAME,
  SseDecoder,
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
  parseDurationHeader,
  parseRetryAfter,
  parseToolArguments,
  passthroughSse,
  pickHeaders,
  safeJson,
  timedFetch,
  translateSse,
  usageToOpenAi,
  zeroUsage,
} from '@/lib/providers/adapters/shared';
import type { SseEvent } from '@/lib/providers/adapters/shared';
import { PROVIDER_CATALOG } from '@/lib/providers/catalog';
import type { Connection, ProviderCatalogEntry, TokenUsage } from '@/types/core';

// ─── Fixtures ────────────────────────────────────────────────────────────────
//
// shared.ts imports only types, so nothing here touches the database or the
// network. No freshDb()/dropDb() is needed; the module is pure.

function provider(id: string): ProviderCatalogEntry {
  const entry = PROVIDER_CATALOG.find((p) => p.id === id);
  if (entry === undefined) throw new Error(`no such provider in catalog: ${id}`);
  return entry;
}

function makeConnection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: 'conn_test',
    providerId: 'groq',
    label: 'Test connection',
    enabled: true,
    tierOverride: null,
    priority: 0,
    baseUrlOverride: null,
    monthlyBudgetUsd: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function usage(overrides: Partial<TokenUsage> = {}): TokenUsage {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
    ...overrides,
  };
}

// ─── Stream helpers ──────────────────────────────────────────────────────────

const ENC = new TextEncoder();

function streamFromBytes(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function streamFromStrings(parts: string[]): ReadableStream<Uint8Array> {
  return streamFromBytes(parts.map((p) => ENC.encode(p)));
}

async function readAllBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value !== undefined) parts.push(value);
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

async function readAllText(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new TextDecoder().decode(await readAllBytes(stream));
}

/** Feeds a whole text through a fresh decoder, the way a caller reads a stream. */
function decodeAll(text: string): SseEvent[] {
  const decoder = new SseDecoder();
  return [...decoder.push(text), ...decoder.flush()];
}

// ─── Small type guards ───────────────────────────────────────────────────────

describe('isRecord', () => {
  it('accepts a plain object', () => {
    expect(isRecord({ a: 1 })).toBe(true);
  });

  it('rejects arrays, so callers can treat records and lists apart', () => {
    expect(isRecord([1, 2])).toBe(false);
  });

  it('rejects null despite typeof null being "object"', () => {
    expect(isRecord(null)).toBe(false);
  });

  it('rejects primitives', () => {
    expect(isRecord('x')).toBe(false);
    expect(isRecord(5)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
  });
});

describe('asArray', () => {
  it('returns the array unchanged', () => {
    const input = [1, 2, 3];
    expect(asArray(input)).toBe(input);
  });

  it('returns an empty array for non-arrays', () => {
    expect(asArray('x')).toEqual([]);
    expect(asArray(null)).toEqual([]);
    expect(asArray({ length: 2 })).toEqual([]);
  });
});

describe('asString', () => {
  it('returns the string unchanged', () => {
    expect(asString('hello')).toBe('hello');
  });

  it('returns the default for non-strings', () => {
    expect(asString(5)).toBe('');
    expect(asString(null, 'fallback')).toBe('fallback');
    expect(asString(undefined, 'fallback')).toBe('fallback');
  });
});

// ─── safeJson ────────────────────────────────────────────────────────────────

describe('safeJson', () => {
  it('parses valid JSON', () => {
    expect(safeJson('{"a":1}')).toEqual({ a: 1 });
    expect(safeJson('[1,2,3]')).toEqual([1, 2, 3]);
  });

  it('returns null for the empty string without throwing', () => {
    expect(safeJson('')).toBeNull();
  });

  it('returns null for whitespace-only input', () => {
    expect(safeJson('   \n ')).toBeNull();
  });

  it('returns null for malformed JSON rather than throwing', () => {
    expect(safeJson('{not json')).toBeNull();
    expect(safeJson('undefined')).toBeNull();
  });
});

// ─── normalizeUsage ──────────────────────────────────────────────────────────

describe('normalizeUsage', () => {
  it('reads OpenAI chat-completions accounting', () => {
    expect(normalizeUsage({ prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 })).toEqual(
      usage({ promptTokens: 10, completionTokens: 20, totalTokens: 30 }),
    );
  });

  it('reads the OpenAI responses-API spelling (input/output tokens)', () => {
    expect(normalizeUsage({ input_tokens: 5, output_tokens: 7 })).toEqual(
      usage({ promptTokens: 5, completionTokens: 7, totalTokens: 12 }),
    );
  });

  it('reads the Gemini spelling including thoughts and cached content', () => {
    expect(
      normalizeUsage({
        promptTokenCount: 3,
        candidatesTokenCount: 4,
        totalTokenCount: 7,
        cachedContentTokenCount: 2,
        thoughtsTokenCount: 1,
      }),
    ).toEqual(
      usage({
        promptTokens: 3,
        completionTokens: 4,
        totalTokens: 7,
        cachedTokens: 2,
        reasoningTokens: 1,
      }),
    );
  });

  it('reads Cohere counts nested under tokens', () => {
    expect(normalizeUsage({ tokens: { input_tokens: 8, output_tokens: 9 } })).toEqual(
      usage({ promptTokens: 8, completionTokens: 9, totalTokens: 17 }),
    );
  });

  it('reads Cohere counts nested under billed_units', () => {
    expect(normalizeUsage({ billed_units: { input_tokens: 2, output_tokens: 3 } })).toEqual(
      usage({ promptTokens: 2, completionTokens: 3, totalTokens: 5 }),
    );
  });

  it('reads cached tokens from prompt_tokens_details', () => {
    expect(
      normalizeUsage({
        prompt_tokens: 10,
        completion_tokens: 5,
        prompt_tokens_details: { cached_tokens: 4 },
      }),
    ).toEqual(usage({ promptTokens: 10, completionTokens: 5, totalTokens: 15, cachedTokens: 4 }));
  });

  it('reads reasoning tokens from completion_tokens_details', () => {
    expect(
      normalizeUsage({
        prompt_tokens: 10,
        completion_tokens: 5,
        completion_tokens_details: { reasoning_tokens: 3 },
      }),
    ).toEqual(usage({ promptTokens: 10, completionTokens: 5, totalTokens: 15, reasoningTokens: 3 }));
  });

  it('reads the Anthropic cache_read_input_tokens field', () => {
    expect(
      normalizeUsage({ input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 6 }),
    ).toEqual(usage({ promptTokens: 10, completionTokens: 2, totalTokens: 12, cachedTokens: 6 }));
  });

  it('derives total from prompt + completion when the provider omits it', () => {
    const result = normalizeUsage({ prompt_tokens: 10, completion_tokens: 20 });
    expect(result?.totalTokens).toBe(30);
  });

  it('trusts a declared total over the sum, since providers bill the declared figure', () => {
    const result = normalizeUsage({ prompt_tokens: 10, completion_tokens: 20, total_tokens: 100 });
    expect(result?.totalTokens).toBe(100);
  });

  it('prefers the OpenAI field over the responses-API field when both appear', () => {
    const result = normalizeUsage({ prompt_tokens: 10, input_tokens: 999 });
    expect(result?.promptTokens).toBe(10);
  });

  it('coerces numeric strings, which some providers emit', () => {
    expect(normalizeUsage({ prompt_tokens: '10', completion_tokens: '20' })).toEqual(
      usage({ promptTokens: 10, completionTokens: 20, totalTokens: 30 }),
    );
  });

  it('returns null when the payload is not a record', () => {
    expect(normalizeUsage(null)).toBeNull();
    expect(normalizeUsage('usage')).toBeNull();
    expect(normalizeUsage(42)).toBeNull();
    expect(normalizeUsage([1, 2])).toBeNull();
  });

  it('returns null when no token field is present', () => {
    expect(normalizeUsage({})).toBeNull();
    expect(normalizeUsage({ model: 'x', unrelated: 5 })).toBeNull();
  });

  it('returns null when every count is explicitly zero', () => {
    expect(normalizeUsage({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 })).toBeNull();
  });

  it('does not collapse to null when only a cached count is present', () => {
    const result = normalizeUsage({ prompt_tokens_details: { cached_tokens: 5 } });
    expect(result).not.toBeNull();
    expect(result?.cachedTokens).toBe(5);
  });
});

// ─── mergeUsage ──────────────────────────────────────────────────────────────

describe('mergeUsage', () => {
  it('returns the other side when one is null', () => {
    const u = usage({ promptTokens: 3 });
    expect(mergeUsage(u, null)).toBe(u);
    expect(mergeUsage(null, u)).toBe(u);
  });

  it('returns null when both are null', () => {
    expect(mergeUsage(null, null)).toBeNull();
  });

  it('takes the max of each field, folding Anthropic start + delta frames together', () => {
    // input arrives at message_start, output at message_delta.
    const start = usage({ promptTokens: 100, totalTokens: 100, cachedTokens: 20 });
    const delta = usage({ completionTokens: 50, reasoningTokens: 10 });
    expect(mergeUsage(start, delta)).toEqual(
      usage({
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        cachedTokens: 20,
        reasoningTokens: 10,
      }),
    );
  });

  it('never lets the total fall below prompt + completion', () => {
    const a = usage({ promptTokens: 40, totalTokens: 0 });
    const b = usage({ completionTokens: 60, totalTokens: 0 });
    expect(mergeUsage(a, b)?.totalTokens).toBe(100);
  });
});

// ─── usageToOpenAi ───────────────────────────────────────────────────────────

describe('usageToOpenAi', () => {
  it('returns null for null usage', () => {
    expect(usageToOpenAi(null)).toBeNull();
  });

  it('maps the three headline counts', () => {
    expect(usageToOpenAi(usage({ promptTokens: 10, completionTokens: 20, totalTokens: 30 }))).toEqual(
      { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    );
  });

  it('omits detail objects when cached and reasoning are zero', () => {
    const out = usageToOpenAi(usage({ promptTokens: 1, completionTokens: 2, totalTokens: 3 }));
    expect(out).not.toHaveProperty('prompt_tokens_details');
    expect(out).not.toHaveProperty('completion_tokens_details');
  });

  it('adds prompt_tokens_details only when there are cached tokens', () => {
    const out = usageToOpenAi(usage({ promptTokens: 10, totalTokens: 10, cachedTokens: 4 }));
    expect(out?.prompt_tokens_details).toEqual({ cached_tokens: 4 });
  });

  it('adds completion_tokens_details only when there are reasoning tokens', () => {
    const out = usageToOpenAi(usage({ completionTokens: 8, totalTokens: 8, reasoningTokens: 5 }));
    expect(out?.completion_tokens_details).toEqual({ reasoning_tokens: 5 });
  });

  it('round-trips back through normalizeUsage', () => {
    const original = usage({
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30,
      cachedTokens: 4,
      reasoningTokens: 5,
    });
    expect(normalizeUsage(usageToOpenAi(original))).toEqual(original);
  });
});

describe('zeroUsage', () => {
  it('is all zeros', () => {
    expect(zeroUsage()).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cachedTokens: 0,
      reasoningTokens: 0,
    });
  });
});

// ─── contentToText ───────────────────────────────────────────────────────────

describe('contentToText', () => {
  it('returns a plain string unchanged', () => {
    expect(contentToText('hello world')).toBe('hello world');
  });

  it('joins an array of string parts', () => {
    expect(contentToText(['a', 'b', 'c'])).toBe('abc');
  });

  it('concatenates the text field of object parts', () => {
    expect(
      contentToText([
        { type: 'text', text: 'one ' },
        { type: 'text', text: 'two' },
      ]),
    ).toBe('one two');
  });

  it('ignores non-text parts such as image blocks', () => {
    expect(
      contentToText([
        { type: 'text', text: 'look: ' },
        { type: 'image_url', image_url: { url: 'http://x/y.png' } },
      ]),
    ).toBe('look: ');
  });

  it('returns an empty string for non-array, non-string input', () => {
    expect(contentToText(null)).toBe('');
    expect(contentToText(42)).toBe('');
    expect(contentToText({ text: 'nope' })).toBe('');
  });

  it('returns an empty string for an empty array', () => {
    expect(contentToText([])).toBe('');
  });
});

// ─── parseToolArguments ──────────────────────────────────────────────────────

describe('parseToolArguments', () => {
  it('returns an object argument unchanged', () => {
    expect(parseToolArguments({ city: 'Paris' })).toEqual({ city: 'Paris' });
  });

  it('parses a JSON-string argument, the common tool-call shape', () => {
    expect(parseToolArguments('{"city":"Paris","days":3}')).toEqual({ city: 'Paris', days: 3 });
  });

  it('returns an empty object for a JSON string that is not an object', () => {
    expect(parseToolArguments('[1,2,3]')).toEqual({});
    expect(parseToolArguments('"just a string"')).toEqual({});
    expect(parseToolArguments('42')).toEqual({});
  });

  it('returns an empty object for invalid JSON', () => {
    expect(parseToolArguments('{not json')).toEqual({});
    expect(parseToolArguments('')).toEqual({});
  });

  it('returns an empty object for non-string, non-record input', () => {
    expect(parseToolArguments(null)).toEqual({});
    expect(parseToolArguments(7)).toEqual({});
    expect(parseToolArguments([1])).toEqual({});
  });
});

// ─── extractErrorMessage ─────────────────────────────────────────────────────

describe('extractErrorMessage', () => {
  const FALLBACK = 'fallback message';

  it('reads the OpenAI-shaped error.message', () => {
    expect(extractErrorMessage({ error: { message: 'invalid api key' } }, FALLBACK)).toBe(
      'invalid api key',
    );
  });

  it('reads an error given as a bare string', () => {
    expect(extractErrorMessage({ error: 'boom' }, FALLBACK)).toBe('boom');
  });

  it('falls back through error.msg / error.detail / error.reason', () => {
    expect(extractErrorMessage({ error: { msg: 'via msg' } }, FALLBACK)).toBe('via msg');
    expect(extractErrorMessage({ error: { detail: 'via detail' } }, FALLBACK)).toBe('via detail');
    expect(extractErrorMessage({ error: { reason: 'via reason' } }, FALLBACK)).toBe('via reason');
  });

  it('reads a top-level message when there is no error object', () => {
    expect(extractErrorMessage({ message: 'top level' }, FALLBACK)).toBe('top level');
    expect(extractErrorMessage({ detail: 'top detail' }, FALLBACK)).toBe('top detail');
  });

  it('prefers a nested error.message over a top-level message', () => {
    expect(extractErrorMessage({ error: { message: 'inner' }, message: 'outer' }, FALLBACK)).toBe(
      'inner',
    );
  });

  it('falls to the top-level scan when the error object has no usable text', () => {
    expect(extractErrorMessage({ error: {}, message: 'outer' }, FALLBACK)).toBe('outer');
  });

  it('unwraps the first element of an array body', () => {
    expect(extractErrorMessage([{ error: { message: 'first' } }], FALLBACK)).toBe('first');
  });

  it('returns a bare string body directly', () => {
    expect(extractErrorMessage('plain text error', FALLBACK)).toBe('plain text error');
  });

  it('returns the fallback when nothing usable is present', () => {
    expect(extractErrorMessage({ status: 500, ok: false }, FALLBACK)).toBe(FALLBACK);
    expect(extractErrorMessage(null, FALLBACK)).toBe(FALLBACK);
    expect(extractErrorMessage(42, FALLBACK)).toBe(FALLBACK);
  });

  it('ignores whitespace-only strings and uses the fallback', () => {
    expect(extractErrorMessage({ error: '   ' }, FALLBACK)).toBe(FALLBACK);
    expect(extractErrorMessage({ message: '' }, FALLBACK)).toBe(FALLBACK);
  });

  it('truncates a very long message to 2000 characters', () => {
    const long = 'x'.repeat(5000);
    expect(extractErrorMessage({ error: { message: long } }, FALLBACK)).toHaveLength(2000);
  });
});

// ─── classifyHttpError ───────────────────────────────────────────────────────
//
// This drives every fallback decision in the gateway, so the branches are worth
// pinning individually.

describe('classifyHttpError', () => {
  const noHeaders = (): Headers => new Headers();

  it('classifies 401 as auth', () => {
    expect(classifyHttpError(401, '{"error":"bad key"}', noHeaders()).kind).toBe('auth');
  });

  it('classifies 403 as auth', () => {
    expect(classifyHttpError(403, 'forbidden', noHeaders()).kind).toBe('auth');
  });

  it('classifies 402 as quota_exceeded', () => {
    expect(classifyHttpError(402, 'payment required', noHeaders()).kind).toBe('quota_exceeded');
  });

  it('classifies a plain 429 as rate_limit', () => {
    expect(classifyHttpError(429, '{"error":"Rate limit reached"}', noHeaders()).kind).toBe(
      'rate_limit',
    );
  });

  it('classifies a 429 whose message mentions quota as quota_exceeded', () => {
    expect(
      classifyHttpError(429, '{"error":"You exceeded your current quota"}', noHeaders()).kind,
    ).toBe('quota_exceeded');
  });

  it('classifies a 429 mentioning billing/credit as quota_exceeded', () => {
    expect(classifyHttpError(429, 'insufficient credit balance', noHeaders()).kind).toBe(
      'quota_exceeded',
    );
  });

  it('classifies 413 as context_length', () => {
    expect(classifyHttpError(413, 'payload too large', noHeaders()).kind).toBe('context_length');
  });

  it('classifies a 400 about context length as context_length, not bad_request', () => {
    // The distinction is load-bearing: context_length can be retried on a
    // bigger model, bad_request stops the walk.
    const msg = "This model's maximum context length is 8192 tokens, however you requested 9000";
    expect(classifyHttpError(400, JSON.stringify({ error: { message: msg } }), noHeaders()).kind).toBe(
      'context_length',
    );
  });

  it('classifies a 400 mentioning tokens/too long as context_length', () => {
    expect(classifyHttpError(400, 'input is too long', noHeaders()).kind).toBe('context_length');
    expect(classifyHttpError(400, 'too many tokens', noHeaders()).kind).toBe('context_length');
  });

  it('classifies a generic malformed 400 as bad_request', () => {
    expect(
      classifyHttpError(400, '{"error":"Invalid value for parameter temperature"}', noHeaders())
        .kind,
    ).toBe('bad_request');
  });

  it('classifies a 400 naming a model as unsupported', () => {
    expect(
      classifyHttpError(400, '{"error":{"message":"The model `x` is not supported"}}', noHeaders())
        .kind,
    ).toBe('unsupported');
  });

  it('classifies 422 as bad_request', () => {
    expect(classifyHttpError(422, 'unprocessable entity', noHeaders()).kind).toBe('bad_request');
  });

  it('classifies a 404 naming a model as unsupported', () => {
    expect(
      classifyHttpError(
        404,
        '{"error":{"message":"The model `gpt-9` does not exist"}}',
        noHeaders(),
      ).kind,
    ).toBe('unsupported');
  });

  it('classifies a 404 with no model reference as bad_request', () => {
    expect(classifyHttpError(404, '{"error":"endpoint disabled"}', noHeaders()).kind).toBe(
      'bad_request',
    );
  });

  it('classifies 408 and 504 as timeout', () => {
    expect(classifyHttpError(408, 'request timeout', noHeaders()).kind).toBe('timeout');
    expect(classifyHttpError(504, 'gateway timeout', noHeaders()).kind).toBe('timeout');
  });

  it('classifies 500, 502 and 503 as server', () => {
    expect(classifyHttpError(500, 'boom', noHeaders()).kind).toBe('server');
    expect(classifyHttpError(502, 'bad gateway', noHeaders()).kind).toBe('server');
    expect(classifyHttpError(503, 'unavailable', noHeaders()).kind).toBe('server');
  });

  it('classifies an unhandled status as unknown', () => {
    expect(classifyHttpError(418, "I'm a teapot", noHeaders()).kind).toBe('unknown');
  });

  it('extracts the upstream message from a JSON error body', () => {
    const err = classifyHttpError(429, '{"error":{"message":"slow down please"}}', noHeaders());
    expect(err.message).toBe('slow down please');
  });

  it('falls back to a synthetic message when the body is empty', () => {
    expect(classifyHttpError(418, '', noHeaders()).message).toBe('HTTP 418');
  });

  it('carries the parsed body through as raw for JSON bodies', () => {
    const err = classifyHttpError(500, '{"error":"nope"}', noHeaders());
    expect(err.raw).toEqual({ error: 'nope' });
  });

  it('carries the truncated text through as raw for non-JSON bodies', () => {
    const err = classifyHttpError(500, 'Internal Server Error', noHeaders());
    expect(err.raw).toBe('Internal Server Error');
    expect(err.message).toBe('Internal Server Error');
  });

  it('populates retryAfterSec from the Retry-After header', () => {
    const err = classifyHttpError(429, 'slow down', new Headers({ 'retry-after': '30' }));
    expect(err.retryAfterSec).toBe(30);
  });

  it('leaves retryAfterSec null when no reset header is present', () => {
    expect(classifyHttpError(500, 'boom', noHeaders()).retryAfterSec).toBeNull();
  });
});

// ─── networkError / adapterError ─────────────────────────────────────────────

describe('networkError', () => {
  it('maps a TimeoutError to kind timeout', () => {
    const err = networkError(new DOMException('Upstream timed out', 'TimeoutError'));
    expect(err.kind).toBe('timeout');
    expect(err.message).toBe('Upstream timed out');
  });

  it('maps an AbortError to kind timeout', () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect(networkError(abort).kind).toBe('timeout');
  });

  it('supplies a default message when a timeout has none', () => {
    expect(networkError(new DOMException('', 'TimeoutError')).message).toBe('Request aborted');
  });

  it('maps any other Error to kind network', () => {
    const err = networkError(new Error('ECONNREFUSED'));
    expect(err.kind).toBe('network');
    expect(err.message).toBe('ECONNREFUSED');
  });

  it('appends the cause message when the error wraps one', () => {
    const err = networkError(new Error('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND') }));
    expect(err.message).toBe('fetch failed: getaddrinfo ENOTFOUND');
  });

  it('stringifies a non-Error value as a network error', () => {
    const err = networkError('socket hang up');
    expect(err.kind).toBe('network');
    expect(err.message).toBe('socket hang up');
  });
});

describe('adapterError', () => {
  it('builds an error with a null retry and null raw by default', () => {
    expect(adapterError('bad_request', 'malformed body')).toEqual({
      kind: 'bad_request',
      message: 'malformed body',
      retryAfterSec: null,
      raw: null,
    });
  });

  it('carries the raw payload through when supplied', () => {
    expect(adapterError('server', 'boom', { code: 500 }).raw).toEqual({ code: 500 });
  });
});

// ─── parseDurationHeader ─────────────────────────────────────────────────────

describe('parseDurationHeader', () => {
  it('parses a plain integer number of seconds', () => {
    expect(parseDurationHeader('30')).toBe(30);
  });

  it('parses a fractional seconds value', () => {
    expect(parseDurationHeader('1.5s')).toBe(1.5);
  });

  it('parses a compound duration such as 2m59.56s', () => {
    expect(parseDurationHeader('2m59.56s')).toBe(179.56);
  });

  it('treats the value as milliseconds when told to', () => {
    expect(parseDurationHeader('1500', true)).toBe(1.5);
  });

  it('returns null for a missing header', () => {
    expect(parseDurationHeader(null)).toBeNull();
  });

  it('returns null for an empty or whitespace value', () => {
    expect(parseDurationHeader('')).toBeNull();
    expect(parseDurationHeader('   ')).toBeNull();
  });

  it('returns null for garbage rather than NaN, which would poison lockout math', () => {
    const result = parseDurationHeader('not-a-real-value');
    expect(result).toBeNull();
    expect(Number.isNaN(result)).toBe(false);
  });

  it('clamps a negative delta up to zero', () => {
    expect(parseDurationHeader('-10')).toBe(0);
  });

  it('clamps an absurdly large delay down to one hour', () => {
    expect(parseDurationHeader('99999')).toBe(3600);
  });

  it('resolves an ISO reset timestamp in the future to a positive delay', () => {
    const iso = new Date(Date.now() + 60_000).toISOString();
    const result = parseDurationHeader(iso);
    expect(result).not.toBeNull();
    expect(result!).toBeGreaterThan(40);
    expect(result!).toBeLessThanOrEqual(61);
  });

  it('interprets an absolute epoch-seconds instant as a delta', () => {
    const result = parseDurationHeader(String(Math.floor(Date.now() / 1000) + 45));
    expect(result!).toBeGreaterThan(40);
    expect(result!).toBeLessThanOrEqual(45.5);
  });

  it('interprets an absolute epoch-millis instant as a delta', () => {
    const result = parseDurationHeader(String(Date.now() + 45_000));
    expect(result!).toBeGreaterThan(40);
    expect(result!).toBeLessThanOrEqual(45.5);
  });
});

// ─── parseRetryAfter ─────────────────────────────────────────────────────────

describe('parseRetryAfter', () => {
  it('reads plain seconds from Retry-After', () => {
    expect(parseRetryAfter(new Headers({ 'retry-after': '30' }))).toBe(30);
  });

  it('reads the millisecond variant from Retry-After-Ms', () => {
    expect(parseRetryAfter(new Headers({ 'retry-after-ms': '1500' }))).toBe(1.5);
  });

  it('resolves an HTTP-date Retry-After to a positive number of seconds', () => {
    const future = new Date(Date.now() + 60_000).toUTCString();
    const result = parseRetryAfter(new Headers({ 'retry-after': future }));
    expect(result).not.toBeNull();
    expect(result!).toBeGreaterThan(40);
    expect(result!).toBeLessThanOrEqual(61);
  });

  it('reads provider-specific reset headers such as x-ratelimit-reset-after', () => {
    expect(parseRetryAfter(new Headers({ 'x-ratelimit-reset-after': '12' }))).toBe(12);
  });

  it('returns null when no reset header is present', () => {
    expect(parseRetryAfter(new Headers({ 'content-type': 'application/json' }))).toBeNull();
  });

  it('returns null for a garbage Retry-After rather than NaN', () => {
    const result = parseRetryAfter(new Headers({ 'retry-after': 'soon' }));
    expect(result).toBeNull();
    expect(Number.isNaN(result)).toBe(false);
  });
});

// ─── effectiveBaseUrl ────────────────────────────────────────────────────────

describe('effectiveBaseUrl', () => {
  it('uses the provider base URL when there is no override', () => {
    const groq = provider('groq');
    expect(effectiveBaseUrl(makeConnection(), groq)).toBe(groq.baseUrl);
  });

  it('uses the connection override when set', () => {
    const conn = makeConnection({ baseUrlOverride: 'https://proxy.internal/v1' });
    expect(effectiveBaseUrl(conn, provider('groq'))).toBe('https://proxy.internal/v1');
  });

  it('strips trailing slashes from the resolved URL', () => {
    const conn = makeConnection({ baseUrlOverride: 'http://localhost:11434/v1///' });
    expect(effectiveBaseUrl(conn, provider('ollama'))).toBe('http://localhost:11434/v1');
  });

  it('trims whitespace and falls back to the provider for a blank override', () => {
    const groq = provider('groq');
    expect(effectiveBaseUrl(makeConnection({ baseUrlOverride: '   ' }), groq)).toBe(groq.baseUrl);
  });

  it('falls back to the provider when the override is null', () => {
    const groq = provider('groq');
    expect(effectiveBaseUrl(makeConnection({ baseUrlOverride: null }), groq)).toBe(groq.baseUrl);
  });
});

// ─── applyAuth ───────────────────────────────────────────────────────────────

describe('applyAuth', () => {
  const url = (): URL => new URL('https://example.test/v1/chat/completions');

  it('sets a Bearer header for the bearer scheme', () => {
    const headers = new Headers();
    applyAuth(url(), headers, provider('groq'), 'gsk_secret');
    expect(headers.get('authorization')).toBe('Bearer gsk_secret');
  });

  it('sets the named header for the header scheme', () => {
    const headers = new Headers();
    applyAuth(url(), headers, provider('google'), 'AIzaKey');
    expect(headers.get('x-goog-api-key')).toBe('AIzaKey');
  });

  it('defaults the header name to x-api-key when the provider omits it', () => {
    const headers = new Headers();
    const noName: ProviderCatalogEntry = { ...provider('google'), authHeaderName: undefined };
    applyAuth(url(), headers, noName, 'k');
    expect(headers.get('x-api-key')).toBe('k');
  });

  it('sets a query parameter for the query scheme, defaulting the name to key', () => {
    const target = url();
    const queryProvider: ProviderCatalogEntry = {
      ...provider('groq'),
      authScheme: 'query',
      authQueryParam: undefined,
    };
    applyAuth(target, new Headers(), queryProvider, 'qsecret');
    expect(target.searchParams.get('key')).toBe('qsecret');
  });

  it('honours a custom query parameter name', () => {
    const target = url();
    const queryProvider: ProviderCatalogEntry = {
      ...provider('groq'),
      authScheme: 'query',
      authQueryParam: 'api_key',
    };
    applyAuth(target, new Headers(), queryProvider, 'qsecret');
    expect(target.searchParams.get('api_key')).toBe('qsecret');
  });

  it('applies the provider extra headers', () => {
    const headers = new Headers();
    applyAuth(url(), headers, provider('anthropic'), 'sk-ant');
    expect(headers.get('anthropic-version')).toBe('2023-06-01');
    expect(headers.get('x-api-key')).toBe('sk-ant');
  });

  it('still applies extra headers when there is no credential', () => {
    const headers = new Headers();
    applyAuth(url(), headers, provider('anthropic'), null);
    expect(headers.get('anthropic-version')).toBe('2023-06-01');
    expect(headers.get('x-api-key')).toBeNull();
  });

  it('sets no credential for an empty-string credential', () => {
    const headers = new Headers();
    applyAuth(url(), headers, provider('groq'), '');
    expect(headers.get('authorization')).toBeNull();
  });

  it('attaches nothing for the none scheme, even when handed a credential', () => {
    const target = url();
    const headers = new Headers();
    applyAuth(target, headers, provider('ollama'), 'ignored');
    expect(headers.get('authorization')).toBeNull();
    expect(target.searchParams.get('key')).toBeNull();
  });
});

// ─── pickHeaders ─────────────────────────────────────────────────────────────

describe('pickHeaders', () => {
  it('keeps rate-limit and tracing headers and drops everything else', () => {
    const headers = new Headers({
      'content-type': 'application/json',
      authorization: 'Bearer secret',
      'x-ratelimit-remaining': '42',
      'retry-after': '5',
      'x-request-id': 'req_123',
      'x-internal-cookie': 'do-not-surface',
    });
    const picked = pickHeaders(headers);
    expect(picked).toEqual({
      'content-type': 'application/json',
      'x-ratelimit-remaining': '42',
      'retry-after': '5',
      'x-request-id': 'req_123',
    });
  });

  it('never surfaces the authorization header', () => {
    const picked = pickHeaders(new Headers({ authorization: 'Bearer secret' }));
    expect(picked).not.toHaveProperty('authorization');
  });
});

// ─── SSE frame builders ──────────────────────────────────────────────────────

describe('dataFrame and DONE_FRAME', () => {
  it('wraps a payload as a JSON SSE data frame', () => {
    expect(dataFrame({ a: 1 })).toBe('data: {"a":1}\n\n');
  });

  it('exposes the [DONE] sentinel frame', () => {
    expect(DONE_FRAME).toBe('data: [DONE]\n\n');
  });

  it('round-trips a payload through the decoder', () => {
    const [event] = decodeAll(dataFrame({ hello: 'world', n: 3 }));
    expect(event).toBeDefined();
    expect(JSON.parse(event!.data)).toEqual({ hello: 'world', n: 3 });
  });
});

describe('completionId and nowSeconds', () => {
  it('prefixes the id with chatcmpl by default', () => {
    expect(completionId()).toMatch(/^chatcmpl_/);
  });

  it('honours a custom prefix', () => {
    expect(completionId('cmpl')).toMatch(/^cmpl_/);
  });

  it('produces a fresh id on each call', () => {
    expect(completionId()).not.toBe(completionId());
  });

  it('returns whole seconds close to the current time', () => {
    const now = nowSeconds();
    expect(Number.isInteger(now)).toBe(true);
    expect(Math.abs(now - Date.now() / 1000)).toBeLessThan(2);
  });
});

// ─── SseDecoder ──────────────────────────────────────────────────────────────

describe('SseDecoder', () => {
  it('decodes a single complete frame', () => {
    const events = new SseDecoder().push('data: {"x":1}\n\n');
    expect(events).toEqual([{ event: null, data: '{"x":1}' }]);
  });

  it('reassembles a frame split across two byte chunks', () => {
    // The classic streaming bug: a naive decoder drops the half-frame. This is
    // exactly the case that must survive.
    const decoder = new SseDecoder();
    expect(decoder.push('data: {"x')).toEqual([]);
    const events = decoder.push('":1}\n\n');
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!.data)).toEqual({ x: 1 });
  });

  it('emits multiple frames delivered in one chunk', () => {
    const events = new SseDecoder().push('data: a\n\ndata: b\n\n');
    expect(events.map((e) => e.data)).toEqual(['a', 'b']);
  });

  it('surfaces the [DONE] sentinel as its data payload', () => {
    const events = new SseDecoder().push('data: [DONE]\n\n');
    expect(events[0]!.data).toBe('[DONE]');
  });

  it('captures the event field alongside the data', () => {
    const events = new SseDecoder().push('event: message_start\ndata: {}\n\n');
    expect(events[0]).toEqual({ event: 'message_start', data: '{}' });
  });

  it('joins multi-line data fields with newlines', () => {
    const events = new SseDecoder().push('data: line one\ndata: line two\n\n');
    expect(events[0]!.data).toBe('line one\nline two');
  });

  it('strips exactly one leading space after the colon', () => {
    expect(new SseDecoder().push('data:  two spaces\n\n')[0]!.data).toBe(' two spaces');
    expect(new SseDecoder().push('data:nospace\n\n')[0]!.data).toBe('nospace');
  });

  it('normalises CRLF line endings', () => {
    const events = new SseDecoder().push('data: a\r\n\r\n');
    expect(events).toEqual([{ event: null, data: 'a' }]);
  });

  it('ignores comment lines that start with a colon', () => {
    const events = new SseDecoder().push(': keep-alive\ndata: real\n\n');
    expect(events).toEqual([{ event: null, data: 'real' }]);
  });

  it('skips a dataless frame without killing the following frames', () => {
    const events = new SseDecoder().push('event: ping\n\ndata: survived\n\n');
    expect(events).toEqual([{ event: null, data: 'survived' }]);
  });

  it('holds a trailing partial frame until flush', () => {
    const decoder = new SseDecoder();
    expect(decoder.push('data: tail-with-no-terminator')).toEqual([]);
    expect(decoder.flush()).toEqual([{ event: null, data: 'tail-with-no-terminator' }]);
  });

  it('flushes nothing when the buffer holds only whitespace', () => {
    const decoder = new SseDecoder();
    decoder.push('\n\n');
    expect(decoder.flush()).toEqual([]);
  });
});

// ─── passthroughSse ──────────────────────────────────────────────────────────

describe('passthroughSse', () => {
  it('forwards bytes unchanged while observing each frame', async () => {
    const frame = dataFrame({ hello: 'world' });
    const bytes = ENC.encode(frame);
    // Deliberately split the JSON mid-token across two chunks.
    const chunks = [bytes.slice(0, 10), bytes.slice(10)];

    const events: SseEvent[] = [];
    let firstChunks = 0;
    const out = await readAllBytes(
      passthroughSse({
        upstream: streamFromBytes(chunks),
        onFirstChunk: () => {
          firstChunks += 1;
        },
        onEvent: (event) => events.push(event),
      }),
    );

    expect(Buffer.from(out).equals(Buffer.from(bytes))).toBe(true);
    expect(firstChunks).toBe(1);
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!.data)).toEqual({ hello: 'world' });
  });

  it('observes a trailing frame with no terminator via flush', async () => {
    const events: SseEvent[] = [];
    await readAllBytes(
      passthroughSse({
        upstream: streamFromStrings(['data: {"a":1}\n\n', 'data: {"b":2}']),
        onFirstChunk: () => undefined,
        onEvent: (event) => events.push(event),
      }),
    );
    expect(events.map((e) => JSON.parse(e.data))).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('forwards the [DONE] frame to the observer', async () => {
    const events: SseEvent[] = [];
    await readAllBytes(
      passthroughSse({
        upstream: streamFromStrings([dataFrame({ delta: 'hi' }), DONE_FRAME]),
        onFirstChunk: () => undefined,
        onEvent: (event) => events.push(event),
      }),
    );
    expect(events.map((e) => e.data)).toEqual(['{"delta":"hi"}', '[DONE]']);
  });

  it('calls onFirstChunk exactly once across many chunks', async () => {
    let firstChunks = 0;
    await readAllBytes(
      passthroughSse({
        upstream: streamFromStrings(['data: a\n\n', 'data: b\n\n', 'data: c\n\n']),
        onFirstChunk: () => {
          firstChunks += 1;
        },
        onEvent: () => undefined,
      }),
    );
    expect(firstChunks).toBe(1);
  });
});

// ─── translateSse ────────────────────────────────────────────────────────────

describe('translateSse', () => {
  it('rewrites each frame and appends the closing frames from onEnd', async () => {
    // First frame split across chunks; second whole; third with no terminator
    // so the flush path is exercised too.
    const firstBytes = ENC.encode('data: {"i":0}\n\n');
    const chunks = [
      firstBytes.slice(0, 8),
      firstBytes.slice(8),
      ENC.encode('data: {"i":1}\n\n'),
      ENC.encode('data: {"i":2}'),
    ];

    const seen: SseEvent[] = [];
    let firstChunks = 0;
    let endCalls = 0;

    const text = await readAllText(
      translateSse({
        upstream: streamFromBytes(chunks),
        onFirstChunk: () => {
          firstChunks += 1;
        },
        onEvent: (event) => {
          seen.push(event);
          return [dataFrame({ echo: event.data })];
        },
        onEnd: () => {
          endCalls += 1;
          return [DONE_FRAME];
        },
      }),
    );

    expect(firstChunks).toBe(1);
    expect(endCalls).toBe(1);
    expect(seen.map((e) => e.data)).toEqual(['{"i":0}', '{"i":1}', '{"i":2}']);

    const outEvents = decodeAll(text);
    expect(outEvents).toHaveLength(4);
    expect(outEvents.slice(0, 3).map((e) => JSON.parse(e.data).echo)).toEqual([
      '{"i":0}',
      '{"i":1}',
      '{"i":2}',
    ]);
    expect(outEvents[3]!.data).toBe('[DONE]');
  });

  it('lets a mapper drop a frame by returning no output frames', async () => {
    const text = await readAllText(
      translateSse({
        upstream: streamFromStrings(['data: keep\n\n', 'data: drop\n\n']),
        onFirstChunk: () => undefined,
        onEvent: (event) => (event.data === 'drop' ? [] : [dataFrame({ kept: event.data })]),
        onEnd: () => [],
      }),
    );
    const outEvents = decodeAll(text);
    expect(outEvents).toHaveLength(1);
    expect(JSON.parse(outEvents[0]!.data)).toEqual({ kept: 'keep' });
  });
});

// ─── timedFetch ──────────────────────────────────────────────────────────────
//
// Every path stubs the global fetch. No request ever escapes to the network.

describe('timedFetch', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('resolves with the upstream response and forwards method and signal', async () => {
    const response = new Response('ok', { status: 200 });
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(response));
    vi.stubGlobal('fetch', fetchMock);

    const res = await timedFetch(
      'https://example.test/v1',
      { method: 'POST' },
      { timeoutMs: 1000, signal: new AbortController().signal },
    );

    expect(res).toBe(response);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0]!;
    expect(calledUrl).toBe('https://example.test/v1');
    expect((init as RequestInit).method).toBe('POST');
    expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it('clears the timeout timer once the request settles', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', fetchMock);

    const res = await timedFetch(
      'https://example.test/v1',
      {},
      { timeoutMs: 5000, signal: new AbortController().signal },
    );

    expect(res.status).toBe(200);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts with a TimeoutError once the per-attempt ceiling elapses', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const p = timedFetch(
      'https://example.test/v1',
      {},
      { timeoutMs: 1000, signal: new AbortController().signal },
    );
    const assertion = expect(p).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it('rejects immediately when the caller signal is already aborted', async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      if (init?.signal?.aborted) return Promise.reject(init.signal.reason);
      return new Promise<Response>(() => undefined);
    });
    vi.stubGlobal('fetch', fetchMock);

    const controller = new AbortController();
    controller.abort(new Error('caller cancelled'));

    await expect(
      timedFetch('https://example.test/v1', {}, { timeoutMs: 1000, signal: controller.signal }),
    ).rejects.toThrow('caller cancelled');
  });

  it('propagates a caller abort raised mid-flight', async () => {
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const controller = new AbortController();
    const p = timedFetch(
      'https://example.test/v1',
      {},
      { timeoutMs: 10_000, signal: controller.signal },
    );
    controller.abort(new Error('mid-flight cancel'));

    await expect(p).rejects.toThrow('mid-flight cancel');
  });
});
