import { vi } from 'vitest';

/**
 * Stands in for a provider at the `fetch` boundary.
 *
 * Every adapter reaches the network through `timedFetch`, which calls global
 * `fetch` — stubbing there exercises the real adapter, the real router and the
 * real route handler, and only fakes the far side of the wire. Nothing in the
 * suite is allowed to reach a real provider.
 */

export interface UpstreamCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface StubResponse {
  status?: number;
  json?: unknown;
  /** Raw SSE text, for streaming responses. */
  sse?: string;
  headers?: Record<string, string>;
  /** Reject instead of responding, to exercise the network-failure path. */
  networkError?: string;
}

export interface Upstream {
  /** Every call made, in order, for asserting the fallback walk. */
  calls: UpstreamCall[];
  restore: () => void;
}

const OPENAI_CHAT_BODY = {
  id: 'chatcmpl-test',
  object: 'chat.completion',
  created: 1_700_000_000,
  model: 'stub-model',
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: 'Hello from the stub.' },
      finish_reason: 'stop',
    },
  ],
  usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
};

/** A successful OpenAI-shaped chat completion. */
export function chatOk(overrides: Record<string, unknown> = {}): StubResponse {
  return { status: 200, json: { ...OPENAI_CHAT_BODY, ...overrides } };
}

/** An error in the envelope providers actually return. */
export function providerError(status: number, message: string, extra: Record<string, string> = {}): StubResponse {
  return {
    status,
    json: { error: { message, type: 'error' } },
    headers: extra,
  };
}

/**
 * Installs the stub. `plan` is consumed one entry per upstream call, so a
 * two-element plan describes "the first provider fails, the second succeeds" —
 * which is the fallback walk. The last entry repeats once the plan runs out, so
 * a single-entry plan means "every provider behaves this way".
 */
export function stubUpstream(plan: StubResponse[]): Upstream {
  const calls: UpstreamCall[] = [];
  let index = 0;

  const impl = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : String((input as { url?: string }).url ?? input);

    const headers: Record<string, string> = {};
    const rawHeaders = init?.headers;
    if (rawHeaders !== undefined) {
      if (rawHeaders instanceof Headers) {
        rawHeaders.forEach((value, key) => {
          headers[key.toLowerCase()] = value;
        });
      } else if (Array.isArray(rawHeaders)) {
        for (const [key, value] of rawHeaders) headers[String(key).toLowerCase()] = String(value);
      } else {
        for (const [key, value] of Object.entries(rawHeaders)) {
          headers[key.toLowerCase()] = String(value);
        }
      }
    }

    let body: unknown = null;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }

    calls.push({ url, method: init?.method ?? 'GET', headers, body });

    const step = plan[Math.min(index, plan.length - 1)] ?? chatOk();
    index += 1;

    if (step.networkError !== undefined) {
      throw new TypeError(step.networkError);
    }

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
    restore: () => vi.unstubAllGlobals(),
  };
}

/** Builds a JSON Request the way a real client would send one. */
export function jsonRequest(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}
