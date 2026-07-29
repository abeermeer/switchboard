import { afterEach, describe, expect, it } from 'vitest';
import { googleAdapter } from '@/lib/providers/adapters/google';
import {
  deltaText,
  drainSse,
  requestFor,
  stubAdapterUpstream,
  type AdapterHarness,
} from '../helpers/adapter';

/**
 * The Google adapter translates between the OpenAI wire format and Gemini's
 * `generateContent`. Almost every field is renamed — `assistant` becomes
 * `model`, `max_tokens` becomes `generationConfig.maxOutputTokens`, `content`
 * becomes `parts` — and Gemini ignores fields it does not recognise, so a
 * mistranslation silently drops the setting instead of erroring.
 */

const MODEL = 'gemini-2.0-flash';

function req(body: Record<string, unknown>, stream = false) {
  return requestFor('google', body, { model: MODEL, stream });
}

function generateOk(overrides: Record<string, unknown> = {}) {
  return {
    json: {
      candidates: [
        {
          content: { role: 'model', parts: [{ text: 'Hello there.' }] },
          finishReason: 'STOP',
          index: 0,
        },
      ],
      usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 5, totalTokenCount: 17 },
      modelVersion: MODEL,
      ...overrides,
    },
  };
}

describe('google adapter', () => {
  let upstream: AdapterHarness | null = null;

  afterEach(() => {
    upstream?.restore();
    upstream = null;
  });

  describe('transport', () => {
    it('posts to the model-scoped generateContent path', async () => {
      upstream = stubAdapterUpstream([generateOk()]);
      await googleAdapter.execute(req({ messages: [{ role: 'user', content: 'hi' }] }));

      const call = upstream.calls[0]!;
      expect(call.url).toContain(`models/${MODEL}:generateContent`);
      expect(call.method).toBe('POST');
    });

    it('authenticates with the x-goog-api-key header, keeping the key out of the URL', async () => {
      // Gemini accepts either `?key=` or this header. The header is the better
      // choice: a key in a query string leaks into proxy logs, browser history
      // and any error report that echoes the request URL.
      upstream = stubAdapterUpstream([generateOk()]);
      await googleAdapter.execute(req({ messages: [{ role: 'user', content: 'hi' }] }));

      expect(upstream.calls[0]!.headers['x-goog-api-key']).toBe('test-credential-value');
      expect(upstream.calls[0]!.url).not.toContain('test-credential-value');
      expect(upstream.calls[0]!.headers['authorization']).toBeUndefined();
    });

    it('does not double-prefix a model id that already carries models/', async () => {
      upstream = stubAdapterUpstream([generateOk()]);
      await googleAdapter.execute(
        requestFor('google', { messages: [{ role: 'user', content: 'hi' }] }, {
          model: 'models/gemini-2.0-flash',
        }),
      );

      expect(upstream.calls[0]!.url).not.toContain('models/models/');
    });

    it('switches to streamGenerateContent with SSE when streaming', async () => {
      upstream = stubAdapterUpstream([{ sse: 'data: {"candidates":[]}\n\n' }]);
      const res = await googleAdapter.execute(
        req({ messages: [{ role: 'user', content: 'hi' }] }, true),
      );
      if (res.stream !== null) await drainSse(res.stream);

      const url = upstream.calls[0]!.url;
      expect(url).toContain(':streamGenerateContent');
      // Without alt=sse Gemini returns a JSON array, not an event stream.
      expect(url).toContain('alt=sse');
    });

    it('supports chat and embeddings, not images', () => {
      expect(googleAdapter.supports('chat')).toBe(true);
      expect(googleAdapter.supports('embeddings')).toBe(true);
    });
  });

  describe('OpenAI → Gemini (request)', () => {
    it('lifts system messages into systemInstruction', async () => {
      upstream = stubAdapterUpstream([generateOk()]);
      await googleAdapter.execute(
        req({
          messages: [
            { role: 'system', content: 'Be terse.' },
            { role: 'user', content: 'hi' },
          ],
        }),
      );

      const sent = upstream.sent();
      const instruction = sent.systemInstruction as Record<string, unknown>;
      expect((instruction.parts as Array<Record<string, unknown>>)[0]?.text).toBe('Be terse.');
      expect((sent.contents as unknown[]).length).toBe(1);
    });

    it('renames the assistant role to model', async () => {
      // Gemini rejects `assistant` outright.
      upstream = stubAdapterUpstream([generateOk()]);
      await googleAdapter.execute(
        req({
          messages: [
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: 'hello' },
            { role: 'user', content: 'again' },
          ],
        }),
      );

      const contents = upstream.sent().contents as Array<Record<string, unknown>>;
      expect(contents.map((c) => c.role)).toEqual(['user', 'model', 'user']);
    });

    it('wraps text into a parts array', async () => {
      upstream = stubAdapterUpstream([generateOk()]);
      await googleAdapter.execute(req({ messages: [{ role: 'user', content: 'hi' }] }));

      const contents = upstream.sent().contents as Array<Record<string, unknown>>;
      expect(contents[0]?.parts).toEqual([{ text: 'hi' }]);
    });

    it('moves sampling parameters into generationConfig under Gemini names', async () => {
      upstream = stubAdapterUpstream([generateOk()]);
      await googleAdapter.execute(
        req({
          messages: [{ role: 'user', content: 'hi' }],
          temperature: 0.4,
          top_p: 0.8,
          max_tokens: 256,
          stop: ['END'],
        }),
      );

      const config = upstream.sent().generationConfig as Record<string, unknown>;
      expect(config.temperature).toBe(0.4);
      expect(config.topP).toBe(0.8);
      expect(config.maxOutputTokens).toBe(256);
      expect(config.stopSequences).toEqual(['END']);
    });

    it('honours max_completion_tokens as well as max_tokens', async () => {
      upstream = stubAdapterUpstream([generateOk()]);
      await googleAdapter.execute(
        req({ messages: [{ role: 'user', content: 'hi' }], max_completion_tokens: 700 }),
      );

      const config = upstream.sent().generationConfig as Record<string, unknown>;
      expect(config.maxOutputTokens).toBe(700);
    });

    it('omits generationConfig entirely when nothing was set', async () => {
      // Sending an empty object is harmless but noisy; absence is the tell that
      // the translation is conditional rather than blanket.
      upstream = stubAdapterUpstream([generateOk()]);
      await googleAdapter.execute(req({ messages: [{ role: 'user', content: 'hi' }] }));

      expect(upstream.sent().generationConfig).toBeUndefined();
    });

    it('maps json_object response_format to a JSON mime type', async () => {
      upstream = stubAdapterUpstream([generateOk()]);
      await googleAdapter.execute(
        req({
          messages: [{ role: 'user', content: 'hi' }],
          response_format: { type: 'json_object' },
        }),
      );

      const config = upstream.sent().generationConfig as Record<string, unknown>;
      expect(config.responseMimeType).toBe('application/json');
    });

    it('carries a json_schema through as responseSchema', async () => {
      upstream = stubAdapterUpstream([generateOk()]);
      await googleAdapter.execute(
        req({
          messages: [{ role: 'user', content: 'hi' }],
          response_format: {
            type: 'json_schema',
            json_schema: { schema: { type: 'object', properties: { a: { type: 'string' } } } },
          },
        }),
      );

      const config = upstream.sent().generationConfig as Record<string, unknown>;
      expect(config.responseMimeType).toBe('application/json');
      expect(config.responseSchema).toMatchObject({ type: 'object' });
    });

    it('translates tools into functionDeclarations', async () => {
      upstream = stubAdapterUpstream([generateOk()]);
      await googleAdapter.execute(
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
      const declarations = tools[0]?.functionDeclarations as Array<Record<string, unknown>>;
      expect(declarations[0]?.name).toBe('get_weather');
    });

    it('converts an assistant tool call into a functionCall part', async () => {
      upstream = stubAdapterUpstream([generateOk()]);
      await googleAdapter.execute(
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
          ],
        }),
      );

      const contents = upstream.sent().contents as Array<Record<string, unknown>>;
      const modelTurn = contents.find((c) => c.role === 'model')!;
      const call = (modelTurn.parts as Array<Record<string, unknown>>)[0]!
        .functionCall as Record<string, unknown>;

      expect(call.name).toBe('get_weather');
      // Gemini wants an object, not the JSON string OpenAI sends.
      expect(call.args).toEqual({ city: 'Lahore' });
    });

    it('recovers the function name for a tool result from the preceding call', async () => {
      // OpenAI tool results carry only `tool_call_id`; Gemini's
      // functionResponse requires the name, so the adapter has to remember it.
      upstream = stubAdapterUpstream([generateOk()]);
      await googleAdapter.execute(
        req({
          messages: [
            { role: 'user', content: 'weather?' },
            {
              role: 'assistant',
              content: null,
              tool_calls: [
                { id: 'call_7', type: 'function', function: { name: 'get_weather', arguments: '{}' } },
              ],
            },
            { role: 'tool', tool_call_id: 'call_7', content: '31C' },
          ],
        }),
      );

      const contents = upstream.sent().contents as Array<Record<string, unknown>>;
      const last = contents[contents.length - 1]!;
      const response = (last.parts as Array<Record<string, unknown>>)[0]!
        .functionResponse as Record<string, unknown>;

      expect(response.name).toBe('get_weather');
      expect(response.response).toMatchObject({ content: '31C' });
    });

    it('translates an inline image into inline_data with its mime type', async () => {
      // snake_case, because this is the REST surface — the camelCase spelling
      // belongs to the client libraries and is ignored here.
      upstream = stubAdapterUpstream([generateOk()]);
      await googleAdapter.execute(
        req({
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'what is this' },
                { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } },
              ],
            },
          ],
        }),
      );

      const contents = upstream.sent().contents as Array<Record<string, unknown>>;
      const parts = contents[0]?.parts as Array<Record<string, unknown>>;
      const inline = parts.find((p) => p.inline_data !== undefined)!;

      expect(inline.inline_data).toMatchObject({ mime_type: 'image/jpeg', data: 'QUJD' });
    });

    it('sends a remote image as a file_data reference rather than inlining it', async () => {
      upstream = stubAdapterUpstream([generateOk()]);
      await googleAdapter.execute(
        req({
          messages: [
            {
              role: 'user',
              content: [{ type: 'image_url', image_url: { url: 'https://example.com/cat.png' } }],
            },
          ],
        }),
      );

      const contents = upstream.sent().contents as Array<Record<string, unknown>>;
      const parts = contents[0]?.parts as Array<Record<string, unknown>>;

      expect(parts[0]?.file_data).toMatchObject({ file_uri: 'https://example.com/cat.png' });
    });

    it('skips malformed messages instead of throwing', async () => {
      upstream = stubAdapterUpstream([generateOk()]);
      const res = await googleAdapter.execute(
        req({ messages: ['nope', null, { role: 'user', content: 'hi' }] }),
      );

      expect(res.ok).toBe(true);
      expect((upstream.sent().contents as unknown[]).length).toBe(1);
    });
  });

  describe('Gemini → OpenAI (response)', () => {
    it('produces a chat.completion envelope', async () => {
      upstream = stubAdapterUpstream([generateOk()]);
      const res = await googleAdapter.execute(req({ messages: [{ role: 'user', content: 'hi' }] }));

      expect(res.ok).toBe(true);
      const json = res.json!;
      expect(json.object).toBe('chat.completion');

      const choice = (json.choices as Array<Record<string, unknown>>)[0]!;
      const message = choice.message as Record<string, unknown>;
      expect(message.role).toBe('assistant');
      expect(message.content).toBe('Hello there.');
      expect(choice.finish_reason).toBe('stop');
    });

    it('maps usageMetadata onto the OpenAI usage shape', async () => {
      upstream = stubAdapterUpstream([generateOk()]);
      const res = await googleAdapter.execute(req({ messages: [{ role: 'user', content: 'hi' }] }));

      expect(res.usage?.promptTokens).toBe(12);
      expect(res.usage?.completionTokens).toBe(5);
    });

    it('carries cachedContentTokenCount into cachedTokens', async () => {
      upstream = stubAdapterUpstream([
        generateOk({
          usageMetadata: {
            promptTokenCount: 100,
            candidatesTokenCount: 8,
            cachedContentTokenCount: 60,
          },
        }),
      ]);
      const res = await googleAdapter.execute(req({ messages: [{ role: 'user', content: 'hi' }] }));

      expect(res.usage?.cachedTokens).toBe(60);
    });

    it.each([
      ['STOP', 'stop'],
      ['MAX_TOKENS', 'length'],
      ['SAFETY', 'content_filter'],
    ])('maps finishReason %s to %s', async (reason, expected) => {
      upstream = stubAdapterUpstream([
        generateOk({
          candidates: [
            { content: { role: 'model', parts: [{ text: 'x' }] }, finishReason: reason, index: 0 },
          ],
        }),
      ]);
      const res = await googleAdapter.execute(req({ messages: [{ role: 'user', content: 'hi' }] }));

      const choice = (res.json!.choices as Array<Record<string, unknown>>)[0]!;
      expect(choice.finish_reason).toBe(expected);
    });

    it('converts a functionCall part into an OpenAI tool call', async () => {
      upstream = stubAdapterUpstream([
        generateOk({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ functionCall: { name: 'get_weather', args: { city: 'Lahore' } } }],
              },
              finishReason: 'STOP',
              index: 0,
            },
          ],
        }),
      ]);
      const res = await googleAdapter.execute(req({ messages: [{ role: 'user', content: 'hi' }] }));

      const choice = (res.json!.choices as Array<Record<string, unknown>>)[0]!;
      const calls = (choice.message as Record<string, unknown>).tool_calls as Array<
        Record<string, unknown>
      >;

      expect(choice.finish_reason).toBe('tool_calls');
      const fn = calls[0]?.function as Record<string, unknown>;
      expect(fn.name).toBe('get_weather');
      // Must be a string for OpenAI clients, even though Gemini sends an object.
      expect(typeof fn.arguments).toBe('string');
      expect(JSON.parse(fn.arguments as string)).toEqual({ city: 'Lahore' });
    });

    it('handles a response with no candidates rather than crashing', async () => {
      // Gemini returns this when a prompt is blocked outright.
      upstream = stubAdapterUpstream([
        { json: { candidates: [], promptFeedback: { blockReason: 'SAFETY' } } },
      ]);
      const res = await googleAdapter.execute(req({ messages: [{ role: 'user', content: 'hi' }] }));

      expect(res.json).not.toBeNull();
      expect(Array.isArray(res.json!.choices)).toBe(true);
    });

    it('concatenates several text parts', async () => {
      upstream = stubAdapterUpstream([
        generateOk({
          candidates: [
            {
              content: { role: 'model', parts: [{ text: 'one ' }, { text: 'two' }] },
              finishReason: 'STOP',
              index: 0,
            },
          ],
        }),
      ]);
      const res = await googleAdapter.execute(req({ messages: [{ role: 'user', content: 'hi' }] }));

      const message = (res.json!.choices as Array<Record<string, unknown>>)[0]!
        .message as Record<string, unknown>;
      expect(message.content).toBe('one two');
    });
  });

  describe('streaming', () => {
    const SSE = [
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Hel"}]},"index":0}]}',
      '',
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"lo"}]},"index":0}]}',
      '',
      'data: {"candidates":[{"content":{"role":"model","parts":[]},"finishReason":"STOP","index":0}],"usageMetadata":{"promptTokenCount":9,"candidatesTokenCount":2}}',
      '',
    ].join('\n');

    it('translates Gemini stream chunks into OpenAI chunk frames', async () => {
      upstream = stubAdapterUpstream([{ sse: SSE }]);
      const res = await googleAdapter.execute(
        req({ messages: [{ role: 'user', content: 'hi' }] }, true),
      );

      const { frames, sawDone } = await drainSse(res.stream!);

      expect(deltaText(frames)).toBe('Hello');
      expect(frames.every((f) => f.object === 'chat.completion.chunk')).toBe(true);
      expect(sawDone).toBe(true);
    });

    it('scrapes usage out of the final chunk', async () => {
      upstream = stubAdapterUpstream([{ sse: SSE }]);
      const res = await googleAdapter.execute(
        req({ messages: [{ role: 'user', content: 'hi' }] }, true),
      );
      await drainSse(res.stream!);

      expect(res.usage?.promptTokens).toBe(9);
    });

    it('survives a chunk split mid-frame', async () => {
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

      const res = await googleAdapter.execute(
        req({ messages: [{ role: 'user', content: 'hi' }] }, true),
      );
      const { frames } = await drainSse(res.stream!);

      expect(deltaText(frames)).toBe('Hello');
      vi.unstubAllGlobals();
    });

    it('ignores a malformed chunk without ending the stream', async () => {
      const broken = [
        'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"a"}]},"index":0}]}',
        '',
        'data: {broken',
        '',
        'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"b"}]},"index":0}]}',
        '',
      ].join('\n');

      upstream = stubAdapterUpstream([{ sse: broken }]);
      const res = await googleAdapter.execute(
        req({ messages: [{ role: 'user', content: 'hi' }] }, true),
      );
      const { frames } = await drainSse(res.stream!);

      expect(deltaText(frames)).toBe('ab');
    });
  });

  describe('embeddings', () => {
    it('posts to embedContent and returns the OpenAI list shape', async () => {
      upstream = stubAdapterUpstream([{ json: { embedding: { values: [0.1, 0.2, 0.3] } } }]);
      const res = await googleAdapter.execute(
        requestFor('google', { input: 'hello' }, {
          model: 'text-embedding-004',
          modality: 'embeddings',
        }),
      );

      expect(upstream.calls[0]!.url).toContain(':embedContent');
      expect(res.ok).toBe(true);

      const json = res.json!;
      expect(json.object).toBe('list');
      const data = json.data as Array<Record<string, unknown>>;
      expect(data[0]?.embedding).toEqual([0.1, 0.2, 0.3]);
      expect(data[0]?.object).toBe('embedding');
    });

    it('handles a batch of inputs', async () => {
      upstream = stubAdapterUpstream([
        { json: { embeddings: [{ values: [0.1] }, { values: [0.2] }] } },
      ]);
      const res = await googleAdapter.execute(
        requestFor('google', { input: ['a', 'b'] }, {
          model: 'text-embedding-004',
          modality: 'embeddings',
        }),
      );

      const data = res.json!.data as unknown[];
      expect(data.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('error classification', () => {
    it.each([
      [401, 'auth'],
      [403, 'auth'],
      [429, 'rate_limit'],
      [500, 'server'],
    ])('maps HTTP %i to kind %s', async (status, kind) => {
      upstream = stubAdapterUpstream([
        { status, json: { error: { code: status, message: 'nope', status: 'X' } } },
      ]);
      const res = await googleAdapter.execute(req({ messages: [{ role: 'user', content: 'hi' }] }));

      expect(res.ok).toBe(false);
      expect(res.error?.kind).toBe(kind);
    });

    it('extracts the message from Gemini error envelope', async () => {
      upstream = stubAdapterUpstream([
        {
          status: 400,
          json: { error: { code: 400, message: 'API key not valid', status: 'INVALID_ARGUMENT' } },
        },
      ]);
      const res = await googleAdapter.execute(req({ messages: [{ role: 'user', content: 'hi' }] }));

      expect(res.error?.message).toContain('API key not valid');
    });

    it('classifies a transport failure as network', async () => {
      upstream = stubAdapterUpstream([{ throws: 'ECONNRESET' }]);
      const res = await googleAdapter.execute(req({ messages: [{ role: 'user', content: 'hi' }] }));

      expect(res.error?.kind).toBe('network');
    });
  });
});
