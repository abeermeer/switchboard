import { afterEach, describe, expect, it } from 'vitest';
import { anthropicAdapter } from '@/lib/providers/adapters/anthropic';
import {
  deltaText,
  drainSse,
  requestFor,
  stubAdapterUpstream,
  type AdapterHarness,
} from '../helpers/adapter';

/**
 * The Anthropic adapter translates in both directions between the OpenAI wire
 * format and `/v1/messages`. A bug here corrupts every Anthropic request
 * silently — the shapes are close enough that a wrong field is accepted and
 * quietly ignored rather than rejected.
 */

const MODEL = 'claude-sonnet-4-5';

function req(body: Record<string, unknown>, stream = false) {
  return requestFor('anthropic', body, { model: MODEL, stream });
}

/** A minimal well-formed Anthropic response. */
function messagesOk(overrides: Record<string, unknown> = {}) {
  return {
    json: {
      id: 'msg_123',
      type: 'message',
      role: 'assistant',
      model: MODEL,
      content: [{ type: 'text', text: 'Hello there.' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 12, output_tokens: 5 },
      ...overrides,
    },
  };
}

describe('anthropic adapter', () => {
  let upstream: AdapterHarness | null = null;

  afterEach(() => {
    upstream?.restore();
    upstream = null;
  });

  describe('transport', () => {
    it('posts to /v1/messages with the versioned auth headers', async () => {
      upstream = stubAdapterUpstream([messagesOk()]);
      await anthropicAdapter.execute(req({ messages: [{ role: 'user', content: 'hi' }] }));

      const call = upstream.calls[0]!;
      expect(call.url).toContain('/messages');
      expect(call.method).toBe('POST');
      // Anthropic authenticates with x-api-key, not a bearer token, and refuses
      // a request with no version header.
      expect(call.headers['x-api-key']).toBe('test-credential-value');
      expect(call.headers['anthropic-version']).toBe('2023-06-01');
    });

    it('reports the modality it supports', () => {
      expect(anthropicAdapter.supports('chat')).toBe(true);
      expect(anthropicAdapter.supports('embeddings')).toBe(false);
    });
  });

  describe('OpenAI → Anthropic (request)', () => {
    it('lifts a system message into the top-level system field', async () => {
      // Anthropic has no system role; leaving it in messages would make the
      // instruction read as a user turn.
      upstream = stubAdapterUpstream([messagesOk()]);
      await anthropicAdapter.execute(
        req({
          messages: [
            { role: 'system', content: 'You are terse.' },
            { role: 'user', content: 'hi' },
          ],
        }),
      );

      const sent = upstream.sent();
      expect(sent.system).toBe('You are terse.');
      expect((sent.messages as unknown[]).length).toBe(1);
    });

    it('joins several system messages rather than dropping all but one', async () => {
      upstream = stubAdapterUpstream([messagesOk()]);
      await anthropicAdapter.execute(
        req({
          messages: [
            { role: 'system', content: 'Be terse.' },
            { role: 'developer', content: 'Prefer TypeScript.' },
            { role: 'user', content: 'hi' },
          ],
        }),
      );

      expect(upstream.sent().system).toBe('Be terse.\n\nPrefer TypeScript.');
    });

    it('always sends max_tokens, which Anthropic requires', async () => {
      // Omitting it is a hard 400 from Anthropic, so the adapter has to supply a
      // default the caller never asked for.
      upstream = stubAdapterUpstream([messagesOk()]);
      await anthropicAdapter.execute(req({ messages: [{ role: 'user', content: 'hi' }] }));

      expect(upstream.sent().max_tokens).toBe(4_096);
    });

    it('honours max_tokens and max_completion_tokens', async () => {
      upstream = stubAdapterUpstream([messagesOk()]);
      await anthropicAdapter.execute(
        req({ messages: [{ role: 'user', content: 'hi' }], max_tokens: 256 }),
      );
      expect(upstream.sent().max_tokens).toBe(256);

      upstream.restore();
      upstream = stubAdapterUpstream([messagesOk()]);
      await anthropicAdapter.execute(
        req({ messages: [{ role: 'user', content: 'hi' }], max_completion_tokens: 512 }),
      );
      expect(upstream.sent().max_tokens).toBe(512);
    });

    it('passes sampling parameters through under their Anthropic names', async () => {
      upstream = stubAdapterUpstream([messagesOk()]);
      await anthropicAdapter.execute(
        req({
          messages: [{ role: 'user', content: 'hi' }],
          temperature: 0.3,
          top_p: 0.9,
          stop: ['STOP'],
        }),
      );

      const sent = upstream.sent();
      expect(sent.temperature).toBe(0.3);
      expect(sent.top_p).toBe(0.9);
      // OpenAI calls it `stop`; Anthropic calls it `stop_sequences`.
      expect(sent.stop_sequences).toEqual(['STOP']);
    });

    it('wraps a single string stop value into an array', async () => {
      upstream = stubAdapterUpstream([messagesOk()]);
      await anthropicAdapter.execute(
        req({ messages: [{ role: 'user', content: 'hi' }], stop: 'HALT' }),
      );
      expect(upstream.sent().stop_sequences).toEqual(['HALT']);
    });

    it('translates tools into Anthropic input_schema form', async () => {
      upstream = stubAdapterUpstream([messagesOk()]);
      await anthropicAdapter.execute(
        req({
          messages: [{ role: 'user', content: 'weather?' }],
          tools: [
            {
              type: 'function',
              function: {
                name: 'get_weather',
                description: 'Look up weather',
                parameters: { type: 'object', properties: { city: { type: 'string' } } },
              },
            },
          ],
        }),
      );

      const tools = upstream.sent().tools as Array<Record<string, unknown>>;
      expect(tools).toHaveLength(1);
      expect(tools[0]?.name).toBe('get_weather');
      // Anthropic names the schema field differently from OpenAI's `parameters`.
      expect(tools[0]?.input_schema).toMatchObject({ type: 'object' });
    });

    it('converts an assistant tool call into a tool_use block', async () => {
      upstream = stubAdapterUpstream([messagesOk()]);
      await anthropicAdapter.execute(
        req({
          messages: [
            { role: 'user', content: 'weather?' },
            {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'get_weather', arguments: '{"city":"Lahore"}' },
                },
              ],
            },
            { role: 'tool', tool_call_id: 'call_1', content: '31C' },
          ],
        }),
      );

      const messages = upstream.sent().messages as Array<Record<string, unknown>>;
      const assistant = messages.find((m) => m.role === 'assistant');
      const blocks = assistant?.content as Array<Record<string, unknown>>;

      expect(blocks[0]?.type).toBe('tool_use');
      expect(blocks[0]?.name).toBe('get_weather');
      // The arguments arrive as a JSON string and must become an object.
      expect(blocks[0]?.input).toEqual({ city: 'Lahore' });
    });

    it('turns a tool result into a user tool_result block', async () => {
      upstream = stubAdapterUpstream([messagesOk()]);
      await anthropicAdapter.execute(
        req({
          messages: [
            { role: 'user', content: 'weather?' },
            { role: 'tool', tool_call_id: 'call_1', content: '31C' },
          ],
        }),
      );

      const messages = upstream.sent().messages as Array<Record<string, unknown>>;
      const last = messages[messages.length - 1]!;
      const blocks = last.content as Array<Record<string, unknown>>;

      expect(last.role).toBe('user');
      expect(blocks[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'call_1' });
    });

    it('collapses consecutive tool results into one user turn', async () => {
      // Anthropic rejects two user turns in a row, so parallel tool results have
      // to be merged rather than appended.
      upstream = stubAdapterUpstream([messagesOk()]);
      await anthropicAdapter.execute(
        req({
          messages: [
            { role: 'user', content: 'both?' },
            { role: 'tool', tool_call_id: 'call_1', content: 'a' },
            { role: 'tool', tool_call_id: 'call_2', content: 'b' },
          ],
        }),
      );

      const messages = upstream.sent().messages as Array<Record<string, unknown>>;
      const toolTurns = messages.filter(
        (m) => Array.isArray(m.content) && (m.content as Array<Record<string, unknown>>)[0]?.type === 'tool_result',
      );

      expect(toolTurns).toHaveLength(1);
      expect((toolTurns[0]?.content as unknown[]).length).toBe(2);
    });

    it('translates an image content part into a base64 source block', async () => {
      upstream = stubAdapterUpstream([messagesOk()]);
      await anthropicAdapter.execute(
        req({
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'what is this' },
                {
                  type: 'image_url',
                  image_url: { url: 'data:image/png;base64,AAAnevermind' },
                },
              ],
            },
          ],
        }),
      );

      const messages = upstream.sent().messages as Array<Record<string, unknown>>;
      const parts = messages[0]?.content as Array<Record<string, unknown>>;
      const image = parts.find((p) => p.type === 'image');

      expect(image).toBeDefined();
      expect(image?.source).toMatchObject({ type: 'base64', media_type: 'image/png' });
    });

    it('sets stream only when streaming was asked for', async () => {
      upstream = stubAdapterUpstream([messagesOk()]);
      await anthropicAdapter.execute(req({ messages: [{ role: 'user', content: 'hi' }] }));
      expect(upstream.sent().stream).toBeUndefined();
    });

    it('skips malformed messages instead of throwing', async () => {
      upstream = stubAdapterUpstream([messagesOk()]);
      const res = await anthropicAdapter.execute(
        req({ messages: [null, 42, { role: 'user', content: 'hi' }] }),
      );

      expect(res.ok).toBe(true);
      expect((upstream.sent().messages as unknown[]).length).toBe(1);
    });
  });

  describe('Anthropic → OpenAI (response)', () => {
    it('produces a chat.completion envelope', async () => {
      upstream = stubAdapterUpstream([messagesOk()]);
      const res = await anthropicAdapter.execute(req({ messages: [{ role: 'user', content: 'hi' }] }));

      expect(res.ok).toBe(true);
      const json = res.json!;
      expect(json.object).toBe('chat.completion');
      expect(json.id).toBe('msg_123');
      expect(json.model).toBe(MODEL);

      const choice = (json.choices as Array<Record<string, unknown>>)[0]!;
      const message = choice.message as Record<string, unknown>;
      expect(message.role).toBe('assistant');
      expect(message.content).toBe('Hello there.');
      expect(choice.finish_reason).toBe('stop');
    });

    it('concatenates several text blocks', async () => {
      upstream = stubAdapterUpstream([
        messagesOk({
          content: [
            { type: 'text', text: 'one ' },
            { type: 'text', text: 'two' },
          ],
        }),
      ]);
      const res = await anthropicAdapter.execute(req({ messages: [{ role: 'user', content: 'hi' }] }));

      const choice = (res.json!.choices as Array<Record<string, unknown>>)[0]!;
      expect((choice.message as Record<string, unknown>).content).toBe('one two');
    });

    it('maps input_tokens/output_tokens onto the OpenAI usage shape', async () => {
      upstream = stubAdapterUpstream([messagesOk()]);
      const res = await anthropicAdapter.execute(req({ messages: [{ role: 'user', content: 'hi' }] }));

      expect(res.usage?.promptTokens).toBe(12);
      expect(res.usage?.completionTokens).toBe(5);
      expect(res.json!.usage).toMatchObject({ prompt_tokens: 12, completion_tokens: 5 });
    });

    it('carries Anthropic cache-read tokens into cachedTokens', async () => {
      upstream = stubAdapterUpstream([
        messagesOk({
          usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 80 },
        }),
      ]);
      const res = await anthropicAdapter.execute(req({ messages: [{ role: 'user', content: 'hi' }] }));

      // Cached tokens bill at a tenth, so losing them here overstates the cost.
      expect(res.usage?.cachedTokens).toBe(80);
    });

    it('converts tool_use blocks back into OpenAI tool_calls', async () => {
      upstream = stubAdapterUpstream([
        messagesOk({
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Lahore' } }],
          stop_reason: 'tool_use',
        }),
      ]);
      const res = await anthropicAdapter.execute(req({ messages: [{ role: 'user', content: 'hi' }] }));

      const choice = (res.json!.choices as Array<Record<string, unknown>>)[0]!;
      const calls = (choice.message as Record<string, unknown>).tool_calls as Array<
        Record<string, unknown>
      >;

      expect(choice.finish_reason).toBe('tool_calls');
      expect(calls[0]?.id).toBe('toolu_1');
      const fn = calls[0]?.function as Record<string, unknown>;
      expect(fn.name).toBe('get_weather');
      // OpenAI clients expect a JSON *string* here, not an object.
      expect(typeof fn.arguments).toBe('string');
      expect(JSON.parse(fn.arguments as string)).toEqual({ city: 'Lahore' });
    });

    it('surfaces thinking blocks as reasoning_content', async () => {
      upstream = stubAdapterUpstream([
        messagesOk({
          content: [
            { type: 'thinking', thinking: 'considering' },
            { type: 'text', text: 'answer' },
          ],
        }),
      ]);
      const res = await anthropicAdapter.execute(req({ messages: [{ role: 'user', content: 'hi' }] }));

      const message = (res.json!.choices as Array<Record<string, unknown>>)[0]!
        .message as Record<string, unknown>;
      expect(message.reasoning_content).toBe('considering');
      expect(message.content).toBe('answer');
    });

    it.each([
      ['end_turn', 'stop'],
      ['max_tokens', 'length'],
      ['stop_sequence', 'stop'],
    ])('maps stop_reason %s to finish_reason %s', async (stopReason, expected) => {
      upstream = stubAdapterUpstream([messagesOk({ stop_reason: stopReason })]);
      const res = await anthropicAdapter.execute(req({ messages: [{ role: 'user', content: 'hi' }] }));

      const choice = (res.json!.choices as Array<Record<string, unknown>>)[0]!;
      expect(choice.finish_reason).toBe(expected);
    });

    it('reports null content rather than an empty string when there is no text', async () => {
      // OpenAI clients branch on `content === null` for a tool-only reply.
      upstream = stubAdapterUpstream([messagesOk({ content: [] })]);
      const res = await anthropicAdapter.execute(req({ messages: [{ role: 'user', content: 'hi' }] }));

      const message = (res.json!.choices as Array<Record<string, unknown>>)[0]!
        .message as Record<string, unknown>;
      expect(message.content).toBeNull();
    });
  });

  describe('streaming', () => {
    const SSE = [
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"msg_s","model":"claude-sonnet-4-5","usage":{"input_tokens":9,"output_tokens":0}}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n');

    it('translates Anthropic events into OpenAI chunk frames', async () => {
      upstream = stubAdapterUpstream([{ sse: SSE }]);
      const res = await anthropicAdapter.execute(
        req({ messages: [{ role: 'user', content: 'hi' }] }, true),
      );

      expect(res.ok).toBe(true);
      expect(res.stream).not.toBeNull();

      const { frames, sawDone } = await drainSse(res.stream!);

      expect(deltaText(frames)).toBe('Hello');
      expect(frames.every((f) => f.object === 'chat.completion.chunk')).toBe(true);
      // Clients wait for the sentinel; without it they hang until timeout.
      expect(sawDone).toBe(true);
    });

    it('sets stream: true on the upstream request', async () => {
      upstream = stubAdapterUpstream([{ sse: SSE }]);
      const res = await anthropicAdapter.execute(
        req({ messages: [{ role: 'user', content: 'hi' }] }, true),
      );
      await drainSse(res.stream!);

      expect(upstream.sent().stream).toBe(true);
    });

    it('carries the finish reason on the final frame', async () => {
      upstream = stubAdapterUpstream([{ sse: SSE }]);
      const res = await anthropicAdapter.execute(
        req({ messages: [{ role: 'user', content: 'hi' }] }, true),
      );
      const { frames } = await drainSse(res.stream!);

      const finishes = frames
        .flatMap((f) => (Array.isArray(f.choices) ? (f.choices as Array<Record<string, unknown>>) : []))
        .map((c) => c.finish_reason)
        .filter((r) => r !== null && r !== undefined);

      expect(finishes).toContain('stop');
    });

    it('reports usage scraped from the stream', async () => {
      upstream = stubAdapterUpstream([{ sse: SSE }]);
      const res = await anthropicAdapter.execute(
        req({ messages: [{ role: 'user', content: 'hi' }] }, true),
      );
      await drainSse(res.stream!);

      // Read after the stream drains — this is what the handler bills against.
      expect(res.usage?.promptTokens).toBe(9);
    });

    it('survives a frame split across two chunks', async () => {
      // The bug in every naive SSE implementation: a JSON payload arriving in
      // two reads.
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

      const res = await anthropicAdapter.execute(
        req({ messages: [{ role: 'user', content: 'hi' }] }, true),
      );
      const { frames } = await drainSse(res.stream!);

      expect(deltaText(frames)).toBe('Hello');
      vi.unstubAllGlobals();
    });

    it('ignores a malformed event without killing the stream', async () => {
      const broken = [
        'event: message_start',
        'data: {"type":"message_start","message":{"id":"m","model":"x"}}',
        '',
        'data: {not json',
        '',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
        '',
        'event: message_stop',
        'data: {"type":"message_stop"}',
        '',
      ].join('\n');

      upstream = stubAdapterUpstream([{ sse: broken }]);
      const res = await anthropicAdapter.execute(
        req({ messages: [{ role: 'user', content: 'hi' }] }, true),
      );
      const { frames } = await drainSse(res.stream!);

      expect(deltaText(frames)).toBe('ok');
    });

    it('translates a streamed tool call', async () => {
      const toolSse = [
        'event: message_start',
        'data: {"type":"message_start","message":{"id":"m","model":"x"}}',
        '',
        'event: content_block_start',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_9","name":"lookup"}}',
        '',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"q\\":1}"}}',
        '',
        'event: message_delta',
        'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}',
        '',
        'event: message_stop',
        'data: {"type":"message_stop"}',
        '',
      ].join('\n');

      upstream = stubAdapterUpstream([{ sse: toolSse }]);
      const res = await anthropicAdapter.execute(
        req({ messages: [{ role: 'user', content: 'hi' }] }, true),
      );
      const { frames } = await drainSse(res.stream!);

      const sawToolCall = frames.some((f) => {
        const choices = Array.isArray(f.choices) ? (f.choices as Array<Record<string, unknown>>) : [];
        const delta = choices[0]?.delta;
        return (
          delta !== null &&
          typeof delta === 'object' &&
          Array.isArray((delta as Record<string, unknown>).tool_calls)
        );
      });

      expect(sawToolCall).toBe(true);
    });
  });

  describe('error classification', () => {
    it.each([
      [401, 'auth'],
      [403, 'auth'],
      [429, 'rate_limit'],
      [500, 'server'],
      [503, 'server'],
    ])('maps HTTP %i to kind %s', async (status, kind) => {
      upstream = stubAdapterUpstream([
        { status, json: { type: 'error', error: { type: 'x', message: 'nope' } } },
      ]);
      const res = await anthropicAdapter.execute(req({ messages: [{ role: 'user', content: 'hi' }] }));

      expect(res.ok).toBe(false);
      expect(res.error?.kind).toBe(kind);
    });

    it('classifies an oversized prompt as context_length, not bad_request', async () => {
      // The distinction decides whether the router tries a bigger model or gives
      // up entirely.
      upstream = stubAdapterUpstream([
        {
          status: 400,
          json: {
            type: 'error',
            error: { type: 'invalid_request_error', message: 'prompt is too long: 500000 tokens' },
          },
        },
      ]);
      const res = await anthropicAdapter.execute(req({ messages: [{ role: 'user', content: 'hi' }] }));

      expect(res.error?.kind).toBe('context_length');
    });

    it('classifies an ordinary 400 as bad_request', async () => {
      upstream = stubAdapterUpstream([
        {
          status: 400,
          json: { type: 'error', error: { type: 'invalid_request_error', message: 'bad field foo' } },
        },
      ]);
      const res = await anthropicAdapter.execute(req({ messages: [{ role: 'user', content: 'hi' }] }));

      expect(res.error?.kind).toBe('bad_request');
    });

    it('extracts the provider message rather than a generic one', async () => {
      upstream = stubAdapterUpstream([
        {
          status: 429,
          json: { type: 'error', error: { type: 'rate_limit_error', message: 'slow down please' } },
        },
      ]);
      const res = await anthropicAdapter.execute(req({ messages: [{ role: 'user', content: 'hi' }] }));

      expect(res.error?.message).toContain('slow down please');
    });

    it('reads Retry-After off a 429', async () => {
      upstream = stubAdapterUpstream([
        { status: 429, json: { error: { message: 'wait' } }, headers: { 'retry-after': '42' } },
      ]);
      const res = await anthropicAdapter.execute(req({ messages: [{ role: 'user', content: 'hi' }] }));

      expect(res.error?.retryAfterSec).toBe(42);
    });

    it('classifies a transport failure as network', async () => {
      upstream = stubAdapterUpstream([{ throws: 'fetch failed' }]);
      const res = await anthropicAdapter.execute(req({ messages: [{ role: 'user', content: 'hi' }] }));

      expect(res.ok).toBe(false);
      expect(res.error?.kind).toBe('network');
    });
  });

  describe('probe', () => {
    it('reports ok on a healthy response', async () => {
      upstream = stubAdapterUpstream([messagesOk()]);
      const result = await anthropicAdapter.probe({
        signal: new AbortController().signal,
        connection: requestFor('anthropic', {}).connection,
        provider: requestFor('anthropic', {}).provider,
        credential: 'k',
      });

      expect(result.ok).toBe(true);
      expect(result.error).toBeNull();
    });

    it('reports the failure on a rejected credential', async () => {
      upstream = stubAdapterUpstream([{ status: 401, json: { error: { message: 'bad key' } } }]);
      const result = await anthropicAdapter.probe({
        signal: new AbortController().signal,
        connection: requestFor('anthropic', {}).connection,
        provider: requestFor('anthropic', {}).provider,
        credential: 'k',
      });

      expect(result.ok).toBe(false);
      expect(result.error).toBeTruthy();
    });
  });
});
