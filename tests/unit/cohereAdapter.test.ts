import { afterEach, describe, expect, it } from 'vitest';
import { cohereAdapter } from '@/lib/providers/adapters/cohere';
import {
  deltaText,
  drainSse,
  requestFor,
  stubAdapterUpstream,
  type AdapterHarness,
} from '../helpers/adapter';

/**
 * The Cohere adapter targets the v2 API, which is closer to the OpenAI shape
 * than Anthropic or Gemini — close enough that the differences are easy to miss.
 * `top_p` is `p`, `top_k` is `k`, usage hides under `meta.billed_units`, and
 * embeddings come back grouped by type rather than as a flat list.
 */

const MODEL = 'command-r-plus';

function req(body: Record<string, unknown>, stream = false) {
  return requestFor('cohere', body, { model: MODEL, stream });
}

function chatOk(overrides: Record<string, unknown> = {}) {
  return {
    json: {
      id: 'c_123',
      finish_reason: 'COMPLETE',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Hello there.' }] },
      usage: { billed_units: { input_tokens: 12, output_tokens: 5 } },
      ...overrides,
    },
  };
}

describe('cohere adapter', () => {
  let upstream: AdapterHarness | null = null;

  afterEach(() => {
    upstream?.restore();
    upstream = null;
  });

  describe('transport', () => {
    it('posts chat to /v2/chat with a bearer token', async () => {
      upstream = stubAdapterUpstream([chatOk()]);
      await cohereAdapter.execute(req({ messages: [{ role: 'user', content: 'hi' }] }));

      const call = upstream.calls[0]!;
      expect(call.url).toContain('/v2/chat');
      expect(call.headers['authorization']).toBe('Bearer test-credential-value');
    });

    it('supports chat, embeddings and rerank', () => {
      expect(cohereAdapter.supports('chat')).toBe(true);
      expect(cohereAdapter.supports('embeddings')).toBe(true);
      expect(cohereAdapter.supports('rerank')).toBe(true);
    });
  });

  describe('OpenAI → Cohere (request)', () => {
    it('keeps system messages inline rather than lifting them out', async () => {
      // Unlike Anthropic and Gemini, Cohere v2 accepts a system role in the
      // message list, so hoisting it would be wrong.
      upstream = stubAdapterUpstream([chatOk()]);
      await cohereAdapter.execute(
        req({
          messages: [
            { role: 'system', content: 'Be terse.' },
            { role: 'user', content: 'hi' },
          ],
        }),
      );

      const messages = upstream.sent().messages as Array<Record<string, unknown>>;
      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({ role: 'system', content: 'Be terse.' });
      expect(upstream.sent().systemInstruction).toBeUndefined();
    });

    it('renames the developer role to system', async () => {
      upstream = stubAdapterUpstream([chatOk()]);
      await cohereAdapter.execute(
        req({ messages: [{ role: 'developer', content: 'Prefer TS.' }] }),
      );

      const messages = upstream.sent().messages as Array<Record<string, unknown>>;
      expect(messages[0]?.role).toBe('system');
    });

    it('translates top_p and top_k to Cohere p and k', async () => {
      // The single easiest field to get wrong: Cohere silently ignores the
      // OpenAI spellings, so the sampling setting would just vanish.
      upstream = stubAdapterUpstream([chatOk()]);
      await cohereAdapter.execute(
        req({ messages: [{ role: 'user', content: 'hi' }], top_p: 0.85, top_k: 40 }),
      );

      const sent = upstream.sent();
      expect(sent.p).toBe(0.85);
      expect(sent.k).toBe(40);
      expect(sent.top_p).toBeUndefined();
      expect(sent.top_k).toBeUndefined();
    });

    it('passes the parameters that share OpenAI names straight through', async () => {
      upstream = stubAdapterUpstream([chatOk()]);
      await cohereAdapter.execute(
        req({
          messages: [{ role: 'user', content: 'hi' }],
          temperature: 0.2,
          max_tokens: 128,
          frequency_penalty: 0.1,
          presence_penalty: 0.2,
          seed: 7,
        }),
      );

      const sent = upstream.sent();
      expect(sent.temperature).toBe(0.2);
      expect(sent.max_tokens).toBe(128);
      expect(sent.frequency_penalty).toBe(0.1);
      expect(sent.presence_penalty).toBe(0.2);
      expect(sent.seed).toBe(7);
    });

    it('honours max_completion_tokens as a fallback for max_tokens', async () => {
      upstream = stubAdapterUpstream([chatOk()]);
      await cohereAdapter.execute(
        req({ messages: [{ role: 'user', content: 'hi' }], max_completion_tokens: 999 }),
      );

      expect(upstream.sent().max_tokens).toBe(999);
    });

    it('normalises stop into stop_sequences', async () => {
      upstream = stubAdapterUpstream([chatOk()]);
      await cohereAdapter.execute(
        req({ messages: [{ role: 'user', content: 'hi' }], stop: 'HALT' }),
      );
      expect(upstream.sent().stop_sequences).toEqual(['HALT']);

      upstream.restore();
      upstream = stubAdapterUpstream([chatOk()]);
      await cohereAdapter.execute(
        req({ messages: [{ role: 'user', content: 'hi' }], stop: ['A', 'B'] }),
      );
      expect(upstream.sent().stop_sequences).toEqual(['A', 'B']);
    });

    it('carries a tool result with its call id', async () => {
      upstream = stubAdapterUpstream([chatOk()]);
      await cohereAdapter.execute(
        req({
          messages: [
            { role: 'user', content: 'weather?' },
            { role: 'tool', tool_call_id: 'call_1', content: '31C' },
          ],
        }),
      );

      const messages = upstream.sent().messages as Array<Record<string, unknown>>;
      const toolTurn = messages.find((m) => m.role === 'tool')!;
      expect(toolTurn.tool_call_id).toBe('call_1');
      expect(toolTurn.content).toBe('31C');
    });

    it('drops an assistant turn that carries neither content nor tool calls', async () => {
      // Cohere rejects an empty assistant message outright.
      upstream = stubAdapterUpstream([chatOk()]);
      await cohereAdapter.execute(
        req({
          messages: [
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: null },
            { role: 'user', content: 'again' },
          ],
        }),
      );

      const messages = upstream.sent().messages as Array<Record<string, unknown>>;
      expect(messages.every((m) => m.role !== 'assistant')).toBe(true);
    });

    it('maps json_object response_format through', async () => {
      upstream = stubAdapterUpstream([chatOk()]);
      await cohereAdapter.execute(
        req({
          messages: [{ role: 'user', content: 'hi' }],
          response_format: { type: 'json_object' },
        }),
      );

      expect(upstream.sent().response_format).toMatchObject({ type: 'json_object' });
    });

    it('flattens a json_schema request onto Cohere json_object form', async () => {
      upstream = stubAdapterUpstream([chatOk()]);
      await cohereAdapter.execute(
        req({
          messages: [{ role: 'user', content: 'hi' }],
          response_format: {
            type: 'json_schema',
            json_schema: { schema: { type: 'object', properties: { a: { type: 'string' } } } },
          },
        }),
      );

      const format = upstream.sent().response_format as Record<string, unknown>;
      expect(format.type).toBe('json_object');
      expect(format.json_schema).toMatchObject({ type: 'object' });
    });

    it('skips malformed messages instead of throwing', async () => {
      upstream = stubAdapterUpstream([chatOk()]);
      const res = await cohereAdapter.execute(
        req({ messages: [null, 7, { role: 'user', content: 'hi' }] }),
      );

      expect(res.ok).toBe(true);
      expect((upstream.sent().messages as unknown[]).length).toBe(1);
    });
  });

  describe('Cohere → OpenAI (response)', () => {
    it('produces a chat.completion envelope', async () => {
      upstream = stubAdapterUpstream([chatOk()]);
      const res = await cohereAdapter.execute(req({ messages: [{ role: 'user', content: 'hi' }] }));

      expect(res.ok).toBe(true);
      const json = res.json!;
      expect(json.object).toBe('chat.completion');

      const choice = (json.choices as Array<Record<string, unknown>>)[0]!;
      const message = choice.message as Record<string, unknown>;
      expect(message.role).toBe('assistant');
      expect(message.content).toBe('Hello there.');
    });

    it('reads usage out of meta.billed_units', async () => {
      // Cohere buries it two levels deeper than every other provider.
      upstream = stubAdapterUpstream([chatOk()]);
      const res = await cohereAdapter.execute(req({ messages: [{ role: 'user', content: 'hi' }] }));

      expect(res.usage?.promptTokens).toBe(12);
      expect(res.usage?.completionTokens).toBe(5);
    });

    it.each([
      ['COMPLETE', 'stop'],
      ['MAX_TOKENS', 'length'],
      ['TOOL_CALL', 'tool_calls'],
    ])('maps finish_reason %s to %s', async (reason, expected) => {
      upstream = stubAdapterUpstream([chatOk({ finish_reason: reason })]);
      const res = await cohereAdapter.execute(req({ messages: [{ role: 'user', content: 'hi' }] }));

      const choice = (res.json!.choices as Array<Record<string, unknown>>)[0]!;
      expect(choice.finish_reason).toBe(expected);
    });

    it('concatenates several content blocks', async () => {
      upstream = stubAdapterUpstream([
        chatOk({
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'one ' },
              { type: 'text', text: 'two' },
            ],
          },
        }),
      ]);
      const res = await cohereAdapter.execute(req({ messages: [{ role: 'user', content: 'hi' }] }));

      const message = (res.json!.choices as Array<Record<string, unknown>>)[0]!
        .message as Record<string, unknown>;
      expect(message.content).toBe('one two');
    });

    it('translates tool calls back into the OpenAI shape', async () => {
      upstream = stubAdapterUpstream([
        chatOk({
          finish_reason: 'TOOL_CALL',
          message: {
            role: 'assistant',
            tool_calls: [
              {
                id: 'call_9',
                type: 'function',
                function: { name: 'get_weather', arguments: '{"city":"Lahore"}' },
              },
            ],
          },
        }),
      ]);
      const res = await cohereAdapter.execute(req({ messages: [{ role: 'user', content: 'hi' }] }));

      const choice = (res.json!.choices as Array<Record<string, unknown>>)[0]!;
      const calls = (choice.message as Record<string, unknown>).tool_calls as Array<
        Record<string, unknown>
      >;

      expect(choice.finish_reason).toBe('tool_calls');
      expect(calls[0]?.id).toBe('call_9');
      expect(typeof (calls[0]?.function as Record<string, unknown>).arguments).toBe('string');
    });

    it('handles a response with no message rather than crashing', async () => {
      upstream = stubAdapterUpstream([{ json: { id: 'c_1', finish_reason: 'COMPLETE' } }]);
      const res = await cohereAdapter.execute(req({ messages: [{ role: 'user', content: 'hi' }] }));

      expect(res.json).not.toBeNull();
      expect(Array.isArray(res.json!.choices)).toBe(true);
    });
  });

  describe('streaming', () => {
    const SSE = [
      'data: {"type":"message-start","id":"c_s"}',
      '',
      'data: {"type":"content-delta","delta":{"message":{"content":{"text":"Hel"}}}}',
      '',
      'data: {"type":"content-delta","delta":{"message":{"content":{"text":"lo"}}}}',
      '',
      'data: {"type":"message-end","delta":{"finish_reason":"COMPLETE","usage":{"billed_units":{"input_tokens":9,"output_tokens":2}}}}',
      '',
    ].join('\n');

    it('translates Cohere stream events into OpenAI chunk frames', async () => {
      upstream = stubAdapterUpstream([{ sse: SSE }]);
      const res = await cohereAdapter.execute(
        req({ messages: [{ role: 'user', content: 'hi' }] }, true),
      );

      const { frames, sawDone } = await drainSse(res.stream!);

      expect(deltaText(frames)).toBe('Hello');
      expect(frames.every((f) => f.object === 'chat.completion.chunk')).toBe(true);
      expect(sawDone).toBe(true);
    });

    it('sets stream on the upstream request', async () => {
      upstream = stubAdapterUpstream([{ sse: SSE }]);
      const res = await cohereAdapter.execute(
        req({ messages: [{ role: 'user', content: 'hi' }] }, true),
      );
      await drainSse(res.stream!);

      expect(upstream.sent().stream).toBe(true);
    });

    it('scrapes usage from the terminal event', async () => {
      upstream = stubAdapterUpstream([{ sse: SSE }]);
      const res = await cohereAdapter.execute(
        req({ messages: [{ role: 'user', content: 'hi' }] }, true),
      );
      await drainSse(res.stream!);

      expect(res.usage?.promptTokens).toBe(9);
    });

    it('survives a frame split across reads', async () => {
      const midpoint = Math.floor(SSE.length / 2);
      const encoder = new TextEncoder();
      const split = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(SSE.slice(0, midpoint)));
          controller.enqueue(encoder.encode(SSE.slice(midpoint)));
          controller.close();
        },
      });

      const { vi } = await import('vitest');
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(split, {
              status: 200,
              headers: { 'content-type': 'text/event-stream' },
            }),
        ),
      );

      const res = await cohereAdapter.execute(
        req({ messages: [{ role: 'user', content: 'hi' }] }, true),
      );
      const { frames } = await drainSse(res.stream!);

      expect(deltaText(frames)).toBe('Hello');
      vi.unstubAllGlobals();
    });

    it('ignores a malformed event without ending the stream', async () => {
      const broken = [
        'data: {"type":"content-delta","delta":{"message":{"content":{"text":"a"}}}}',
        '',
        'data: {oops',
        '',
        'data: {"type":"content-delta","delta":{"message":{"content":{"text":"b"}}}}',
        '',
      ].join('\n');

      upstream = stubAdapterUpstream([{ sse: broken }]);
      const res = await cohereAdapter.execute(
        req({ messages: [{ role: 'user', content: 'hi' }] }, true),
      );
      const { frames } = await drainSse(res.stream!);

      expect(deltaText(frames)).toBe('ab');
    });
  });

  describe('embeddings', () => {
    it('posts to /v2/embed and flattens the float vectors', async () => {
      // Cohere returns embeddings grouped by type; OpenAI clients expect a flat
      // list of `{ embedding, index }`.
      upstream = stubAdapterUpstream([
        {
          json: {
            embeddings: { float: [[0.1, 0.2], [0.3, 0.4]] },
            meta: { billed_units: { input_tokens: 6 } },
          },
        },
      ]);
      const res = await cohereAdapter.execute(
        requestFor('cohere', { input: ['a', 'b'] }, {
          model: 'embed-english-v3.0',
          modality: 'embeddings',
        }),
      );

      expect(upstream.calls[0]!.url).toContain('/v2/embed');
      expect(res.ok).toBe(true);

      const data = res.json!.data as Array<Record<string, unknown>>;
      expect(data).toHaveLength(2);
      expect(data[0]?.embedding).toEqual([0.1, 0.2]);
      expect(data[1]?.index).toBe(1);
    });

    it('asks for float embeddings explicitly', async () => {
      upstream = stubAdapterUpstream([{ json: { embeddings: { float: [[0.1]] } } }]);
      await cohereAdapter.execute(
        requestFor('cohere', { input: 'a' }, {
          model: 'embed-english-v3.0',
          modality: 'embeddings',
        }),
      );

      expect(upstream.sent().embedding_types).toEqual(['float']);
      // Cohere requires an input_type; omitting it is a 400.
      expect(upstream.sent().input_type).toBe('search_document');
    });

    it('honours a caller-supplied input_type', async () => {
      upstream = stubAdapterUpstream([{ json: { embeddings: { float: [[0.1]] } } }]);
      await cohereAdapter.execute(
        requestFor('cohere', { input: 'a', input_type: 'search_query' }, {
          model: 'embed-english-v3.0',
          modality: 'embeddings',
        }),
      );

      expect(upstream.sent().input_type).toBe('search_query');
    });

    it('rejects an embeddings request with no input, without calling upstream', async () => {
      upstream = stubAdapterUpstream([{ json: {} }]);
      const res = await cohereAdapter.execute(
        requestFor('cohere', {}, { model: 'embed-english-v3.0', modality: 'embeddings' }),
      );

      expect(res.ok).toBe(false);
      expect(res.error?.kind).toBe('bad_request');
      expect(upstream.calls).toHaveLength(0);
    });
  });

  describe('rerank', () => {
    it('posts to /v2/rerank and returns the ranked results', async () => {
      upstream = stubAdapterUpstream([
        {
          json: {
            results: [
              { index: 1, relevance_score: 0.9 },
              { index: 0, relevance_score: 0.2 },
            ],
            meta: { billed_units: { search_units: 1 } },
          },
        },
      ]);
      const res = await cohereAdapter.execute(
        requestFor('cohere', { query: 'cats', documents: ['dogs', 'cats'] }, {
          model: 'rerank-v3.5',
          modality: 'rerank',
        }),
      );

      expect(upstream.calls[0]!.url).toContain('/v2/rerank');
      expect(res.ok).toBe(true);

      const results = res.json!.results as Array<Record<string, unknown>>;
      expect(results[0]?.index).toBe(1);
      expect(results[0]?.relevance_score).toBe(0.9);
    });
  });

  describe('error classification', () => {
    it.each([
      [401, 'auth'],
      [403, 'auth'],
      [429, 'rate_limit'],
      [500, 'server'],
    ])('maps HTTP %i to kind %s', async (status, kind) => {
      upstream = stubAdapterUpstream([{ status, json: { message: 'nope' } }]);
      const res = await cohereAdapter.execute(req({ messages: [{ role: 'user', content: 'hi' }] }));

      expect(res.ok).toBe(false);
      expect(res.error?.kind).toBe(kind);
    });

    it('extracts the message from Cohere flat error envelope', async () => {
      // Cohere returns `{ message }` at the top level rather than nesting it
      // under `error`.
      upstream = stubAdapterUpstream([{ status: 400, json: { message: 'invalid model id' } }]);
      const res = await cohereAdapter.execute(req({ messages: [{ role: 'user', content: 'hi' }] }));

      expect(res.error?.message).toContain('invalid model id');
    });

    it('classifies a transport failure as network', async () => {
      upstream = stubAdapterUpstream([{ throws: 'socket hang up' }]);
      const res = await cohereAdapter.execute(req({ messages: [{ role: 'user', content: 'hi' }] }));

      expect(res.error?.kind).toBe('network');
    });
  });
});
