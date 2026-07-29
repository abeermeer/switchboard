import { vi } from 'vitest';
import type { AdapterRequest, Connection, Modality, ProviderCatalogEntry } from '@/types/core';
import { getProvider } from '@/lib/providers/registry';

/**
 * Fixtures for exercising an adapter through its real `execute()` path.
 *
 * The translation functions inside each adapter are module-private, and testing
 * them through the public contract is the better bargain anyway: it covers the
 * URL, the auth headers, the request translation, the response translation and
 * the error classification in one pass, exactly as the router calls them.
 */

export interface UpstreamCapture {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  raw: string | null;
}

export interface AdapterHarness {
  /** Every upstream call, in order. */
  calls: UpstreamCapture[];
  /** The first call's translated body — what the provider actually received. */
  sent: () => Record<string, unknown>;
  restore: () => void;
}

/** A minimal Connection; adapters only read the override and the id. */
export function connectionFor(providerId: string, overrides: Partial<Connection> = {}): Connection {
  return {
    id: `conn_${providerId}`,
    providerId,
    label: providerId,
    enabled: true,
    tierOverride: null,
    priority: 100,
    baseUrlOverride: null,
    monthlyBudgetUsd: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

/** Real catalog entries, so base URLs and auth schemes are the shipped ones. */
export function providerFor(providerId: string): ProviderCatalogEntry {
  const provider = getProvider(providerId);
  if (provider === null) throw new Error(`no catalog entry for ${providerId}`);
  return provider;
}

export function requestFor(
  providerId: string,
  body: Record<string, unknown>,
  opts: { model?: string; stream?: boolean; modality?: Modality; credential?: string } = {},
): AdapterRequest {
  return {
    modality: opts.modality ?? 'chat',
    model: opts.model ?? 'test-model',
    body,
    stream: opts.stream ?? false,
    signal: new AbortController().signal,
    connection: connectionFor(providerId),
    provider: providerFor(providerId),
    credential: opts.credential ?? 'test-credential-value',
  };
}

export interface UpstreamStep {
  status?: number;
  json?: unknown;
  /** Raw SSE text. Supply pre-framed (`event: x\ndata: {...}\n\n`). */
  sse?: string;
  headers?: Record<string, string>;
  throws?: string;
}

/**
 * Replaces global `fetch` — the single boundary every adapter reaches the
 * network through. `plan` is consumed one entry per call; the last entry repeats
 * once exhausted.
 */
export function stubAdapterUpstream(plan: UpstreamStep[]): AdapterHarness {
  const calls: UpstreamCapture[] = [];
  let index = 0;

  const impl = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : String((input as { url?: string })?.url ?? input);

    const headers: Record<string, string> = {};
    const raw = init?.headers;
    if (raw instanceof Headers) {
      raw.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
    } else if (Array.isArray(raw)) {
      for (const [k, v] of raw) headers[String(k).toLowerCase()] = String(v);
    } else if (raw !== undefined && raw !== null) {
      for (const [k, v] of Object.entries(raw)) headers[k.toLowerCase()] = String(v);
    }

    const rawBody = typeof init?.body === 'string' ? init.body : null;
    let body: Record<string, unknown> = {};
    if (rawBody !== null) {
      try {
        const parsed: unknown = JSON.parse(rawBody);
        if (parsed !== null && typeof parsed === 'object') body = parsed as Record<string, unknown>;
      } catch {
        // Multipart or a non-JSON payload; `raw` still carries it.
      }
    }

    calls.push({ url, method: init?.method ?? 'GET', headers, body, raw: rawBody });

    const step = plan[Math.min(index, plan.length - 1)] ?? { json: {} };
    index += 1;

    if (step.throws !== undefined) throw new TypeError(step.throws);

    if (step.sse !== undefined) {
      return new Response(step.sse, {
        status: step.status ?? 200,
        headers: { 'content-type': 'text/event-stream', ...step.headers },
      });
    }

    return new Response(JSON.stringify(step.json ?? {}), {
      status: step.status ?? 200,
      headers: { 'content-type': 'application/json', ...step.headers },
    });
  };

  vi.stubGlobal('fetch', vi.fn(impl));

  return {
    calls,
    sent: () => {
      const first = calls[0];
      if (first === undefined) throw new Error('no upstream call was made');
      return first.body;
    },
    restore: () => vi.unstubAllGlobals(),
  };
}

/** Drains an adapter's OpenAI-shaped SSE stream into its parsed frames. */
export async function drainSse(
  stream: ReadableStream<Uint8Array>,
): Promise<{ frames: Array<Record<string, unknown>>; sawDone: boolean; text: string }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  const frames: Array<Record<string, unknown>> = [];
  let sawDone = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const parts = buffer.split('\n\n');
    // The tail may be a partial frame; carry it forward.
    buffer = parts.pop() ?? '';

    for (const part of parts) {
      text += `${part}\n\n`;
      const line = part.split('\n').find((l) => l.startsWith('data: '));
      if (line === undefined) continue;
      const payload = line.slice(6).trim();
      if (payload === '[DONE]') {
        sawDone = true;
        continue;
      }
      try {
        const parsed: unknown = JSON.parse(payload);
        if (parsed !== null && typeof parsed === 'object') {
          frames.push(parsed as Record<string, unknown>);
        }
      } catch {
        // A malformed frame is a case under test, not a harness failure.
      }
    }
  }

  return { frames, sawDone, text };
}

/** Concatenated `choices[0].delta.content` across streamed frames. */
export function deltaText(frames: Array<Record<string, unknown>>): string {
  let out = '';
  for (const frame of frames) {
    const choices = frame.choices;
    if (!Array.isArray(choices)) continue;
    const first = choices[0];
    if (first === null || typeof first !== 'object') continue;
    const delta = (first as Record<string, unknown>).delta;
    if (delta === null || typeof delta !== 'object') continue;
    const content = (delta as Record<string, unknown>).content;
    if (typeof content === 'string') out += content;
  }
  return out;
}
