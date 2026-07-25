import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { POST as chatPost } from '@/app/v1/chat/completions/route';
import { GET as modelsGet } from '@/app/v1/models/route';
import { POST as bootstrapPost } from '@/app/api/system/bootstrap/route';
import { createConnection } from '@/lib/db/repos/connections';
import { setCredential } from '@/lib/db/repos/credentials';
import { createApiKey } from '@/lib/db/repos/apiKeys';
import { listCombos } from '@/lib/db/repos/combos';
import { listRequestLogs, getRequestLog } from '@/lib/db/repos/log';
import { clearRateLimit } from '@/lib/auth/rateLimit';
import { reloadMasterKey } from '@/lib/crypto/vault';
import { dropDb, freshDb } from '../helpers/db';
import { chatOk, jsonRequest, providerError, stubUpstream, type Upstream } from '../helpers/upstream';

const CHAT_URL = 'http://127.0.0.1:7272/v1/chat/completions';
const MODELS_URL = 'http://127.0.0.1:7272/v1/models';
const BOOTSTRAP_URL = 'http://127.0.0.1:7272/api/system/bootstrap';

const HELLO = { model: 'auto', messages: [{ role: 'user', content: 'Hello' }] };

/** Two credentialed free-tier connections, so a fallback has somewhere to go. */
function seedConnections(): { first: string; second: string } {
  const groq = createConnection({ providerId: 'groq', label: 'Groq', priority: 10 });
  setCredential(groq.id, 'gsk_test_first');

  const cerebras = createConnection({ providerId: 'cerebras', label: 'Cerebras', priority: 20 });
  setCredential(cerebras.id, 'csk_test_second');

  return { first: groq.id, second: cerebras.id };
}

describe('gateway integration', () => {
  let dir: string;
  let upstream: Upstream | null = null;

  beforeEach(() => {
    dir = freshDb();
    reloadMasterKey();
    clearRateLimit();
  });

  afterEach(() => {
    upstream?.restore();
    upstream = null;
    dropDb(dir);
  });

  // ── bootstrap ─────────────────────────────────────────────────────────────

  describe('POST /api/system/bootstrap', () => {
    it('creates the four seed policies', async () => {
      const res = await bootstrapPost(new Request(BOOTSTRAP_URL, { method: 'POST' }));
      expect(res.status).toBe(200);

      const slugs = listCombos().map((c) => c.slug).sort();
      expect(slugs).toEqual(['auto', 'fast', 'free-only', 'quality']);
    });

    it('is idempotent — a second call does not duplicate anything', async () => {
      await bootstrapPost(new Request(BOOTSTRAP_URL, { method: 'POST' }));
      const afterFirst = listCombos().length;

      await bootstrapPost(new Request(BOOTSTRAP_URL, { method: 'POST' }));
      expect(listCombos()).toHaveLength(afterFirst);
    });

    it('reports what the dashboard still needs from the user', async () => {
      const before = (await (
        await bootstrapPost(new Request(BOOTSTRAP_URL, { method: 'POST' }))
      ).json()) as { ready: boolean; hasConnections: boolean; hasKeys: boolean };

      expect(before).toMatchObject({ ready: true, hasConnections: false, hasKeys: false });

      seedConnections();
      createApiKey({ name: 'test' });

      const after = (await (
        await bootstrapPost(new Request(BOOTSTRAP_URL, { method: 'POST' }))
      ).json()) as { hasConnections: boolean; hasKeys: boolean };

      expect(after).toMatchObject({ hasConnections: true, hasKeys: true });
    });

    it('exactly one policy is the default', async () => {
      await bootstrapPost(new Request(BOOTSTRAP_URL, { method: 'POST' }));
      expect(listCombos().filter((c) => c.isDefault)).toHaveLength(1);
    });
  });

  // ── authentication ────────────────────────────────────────────────────────

  describe('authentication', () => {
    beforeEach(() => {
      seedConnections();
      upstream = stubUpstream([chatOk()]);
    });

    it('serves an unauthenticated request while no API key exists', async () => {
      // Deliberate: a fresh install has to work before the user has opened the
      // dashboard. Asserted rather than "fixed".
      const res = await chatPost(jsonRequest(CHAT_URL, HELLO));
      expect(res.status).toBe(200);
    });

    it('demands a key the moment one exists', async () => {
      createApiKey({ name: 'locks the gateway' });

      const res = await chatPost(jsonRequest(CHAT_URL, HELLO));
      expect(res.status).toBe(401);

      const body = (await res.json()) as { error: { type: string; code: string } };
      expect(body.error.type).toBe('authentication_error');
      expect(body.error.code).toBe('missing_api_key');
    });

    it('rejects a wrong bearer token', async () => {
      createApiKey({ name: 'real' });

      const res = await chatPost(
        jsonRequest(CHAT_URL, HELLO, { authorization: 'Bearer sb-live-not-the-real-key' }),
      );
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('invalid_api_key');
    });

    it('accepts the correct bearer token', async () => {
      const { secret } = createApiKey({ name: 'real' });

      const res = await chatPost(
        jsonRequest(CHAT_URL, HELLO, { authorization: `Bearer ${secret}` }),
      );
      expect(res.status).toBe(200);
    });

    it('accepts x-api-key, for Anthropic-shaped clients', async () => {
      const { secret } = createApiKey({ name: 'real' });

      const res = await chatPost(jsonRequest(CHAT_URL, HELLO, { 'x-api-key': secret }));
      expect(res.status).toBe(200);
    });

    it('refuses a disabled key', async () => {
      const { key, secret } = createApiKey({ name: 'revoked' });
      const { updateApiKey } = await import('@/lib/db/repos/apiKeys');
      updateApiKey(key.id, { enabled: false });

      const res = await chatPost(
        jsonRequest(CHAT_URL, HELLO, { authorization: `Bearer ${secret}` }),
      );
      expect(res.status).toBe(401);
    });

    it('enforces a per-key rate limit and sets Retry-After', async () => {
      const { secret } = createApiKey({ name: 'limited', rateLimitPerMin: 1 });
      const headers = { authorization: `Bearer ${secret}` };

      const first = await chatPost(jsonRequest(CHAT_URL, HELLO, headers));
      expect(first.status).toBe(200);

      const second = await chatPost(jsonRequest(CHAT_URL, HELLO, headers));
      expect(second.status).toBe(429);
      expect(Number(second.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    });
  });

  // ── request validation ────────────────────────────────────────────────────

  describe('validation', () => {
    beforeEach(() => {
      seedConnections();
      upstream = stubUpstream([chatOk()]);
    });

    it('returns the OpenAI error envelope verbatim — clients parse this shape', async () => {
      const res = await chatPost(jsonRequest(CHAT_URL, { model: 'auto' }));
      expect(res.status).toBe(400);

      const body = (await res.json()) as {
        error: { message: string; type: string; param: null; code: string | null };
      };
      expect(Object.keys(body)).toEqual(['error']);
      expect(Object.keys(body.error).sort()).toEqual(['code', 'message', 'param', 'type']);
      expect(body.error.param).toBeNull();
      expect(typeof body.error.message).toBe('string');
    });

    it('rejects an empty messages array', async () => {
      const res = await chatPost(jsonRequest(CHAT_URL, { model: 'auto', messages: [] }));
      expect(res.status).toBe(400);
    });

    it('rejects a malformed JSON body', async () => {
      const res = await chatPost(
        new Request(CHAT_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{ not json',
        }),
      );
      expect(res.status).toBe(400);
    });

    it('passes provider-specific extras through rather than rejecting them', async () => {
      // Validation is deliberately shallow: a strict schema would break working
      // integrations that send fields the provider understands.
      const res = await chatPost(
        jsonRequest(CHAT_URL, { ...HELLO, reasoning_effort: 'high', safety_settings: [] }),
      );
      expect(res.status).toBe(200);

      const sent = upstream?.calls[0]?.body as Record<string, unknown>;
      expect(sent['reasoning_effort']).toBe('high');
    });
  });

  // ── the happy path ────────────────────────────────────────────────────────

  describe('POST /v1/chat/completions', () => {
    beforeEach(() => {
      seedConnections();
    });

    it('returns an OpenAI-shaped completion', async () => {
      upstream = stubUpstream([chatOk()]);

      const res = await chatPost(jsonRequest(CHAT_URL, HELLO));
      expect(res.status).toBe(200);

      const body = (await res.json()) as {
        object: string;
        choices: Array<{ message: { role: string; content: string } }>;
      };
      expect(body.object).toBe('chat.completion');
      expect(body.choices[0]?.message.content).toBe('Hello from the stub.');
    });

    it('sends the decrypted credential upstream as a bearer token', async () => {
      upstream = stubUpstream([chatOk()]);
      await chatPost(jsonRequest(CHAT_URL, HELLO));

      const auth = upstream.calls[0]?.headers['authorization'];
      expect(auth).toMatch(/^Bearer (gsk|csk)_test_/);
    });

    it('sets the full x-switchboard trace header set', async () => {
      upstream = stubUpstream([chatOk()]);

      const res = await chatPost(jsonRequest(CHAT_URL, HELLO));

      expect(res.headers.get('x-switchboard-request-id')).toMatch(/^req_/);
      expect(res.headers.get('x-switchboard-provider')).toBeTruthy();
      expect(res.headers.get('x-switchboard-model')).toBeTruthy();
      expect(res.headers.get('x-switchboard-connection')).toBeTruthy();
      expect(res.headers.get('x-switchboard-attempts')).toBe('1');
      expect(res.headers.get('x-switchboard-strategy')).toBeTruthy();
      expect(res.headers.get('x-switchboard-tier')).toBeTruthy();
      expect(Number(res.headers.get('x-switchboard-cost-usd'))).toBeGreaterThanOrEqual(0);
    });

    it('omits the fallback-reason header when the first choice worked', async () => {
      // Its presence is itself the signal that something failed, so it must not
      // appear on a clean request.
      upstream = stubUpstream([chatOk()]);

      const res = await chatPost(jsonRequest(CHAT_URL, HELLO));
      expect(res.headers.get('x-switchboard-fallback-reason')).toBeNull();
    });
  });

  // ── the fallback walk ─────────────────────────────────────────────────────

  describe('fallback', () => {
    beforeEach(() => {
      seedConnections();
    });

    it('recovers from a 429 on the first provider', async () => {
      // The single most important behaviour in the product.
      upstream = stubUpstream([providerError(429, 'Rate limit reached'), chatOk()]);

      const res = await chatPost(jsonRequest(CHAT_URL, HELLO));

      expect(res.status).toBe(200);
      expect(res.headers.get('x-switchboard-attempts')).toBe('2');
      expect(res.headers.get('x-switchboard-fallback-reason')).toMatch(/rate limit/i);
      expect(upstream.calls).toHaveLength(2);
    });

    it('routes around a 5xx', async () => {
      upstream = stubUpstream([providerError(503, 'upstream unavailable'), chatOk()]);

      const res = await chatPost(jsonRequest(CHAT_URL, HELLO));
      expect(res.status).toBe(200);
      expect(res.headers.get('x-switchboard-attempts')).toBe('2');
    });

    it('routes around a network failure', async () => {
      upstream = stubUpstream([{ networkError: 'fetch failed' }, chatOk()]);

      const res = await chatPost(jsonRequest(CHAT_URL, HELLO));
      expect(res.status).toBe(200);
      expect(res.headers.get('x-switchboard-attempts')).toBe('2');
    });

    it('tries a different provider on the second attempt, not the same one', async () => {
      upstream = stubUpstream([providerError(429, 'slow down'), chatOk()]);
      await chatPost(jsonRequest(CHAT_URL, HELLO));

      const hosts = upstream.calls.map((c) => new URL(c.url).host);
      expect(new Set(hosts).size).toBe(2);
    });

    it('does NOT retry a 400 elsewhere', async () => {
      // A malformed body produces the same 400 on every provider; retrying just
      // makes the client wait longer for the same answer.
      upstream = stubUpstream([providerError(400, 'unsupported parameter foo')]);

      const res = await chatPost(jsonRequest(CHAT_URL, HELLO));

      expect(res.status).toBe(400);
      expect(upstream.calls).toHaveLength(1);
    });

    it('maps a total auth failure to 401', async () => {
      upstream = stubUpstream([providerError(401, 'invalid api key')]);

      const res = await chatPost(jsonRequest(CHAT_URL, HELLO));
      expect(res.status).toBe(401);
    });

    it('maps a total rate-limit failure to 429 with Retry-After', async () => {
      upstream = stubUpstream([providerError(429, 'quota', { 'retry-after': '30' })]);

      const res = await chatPost(jsonRequest(CHAT_URL, HELLO));
      expect(res.status).toBe(429);
      expect(res.headers.get('retry-after')).toBe('30');
    });

    it('maps a total server failure to 502', async () => {
      upstream = stubUpstream([providerError(500, 'boom')]);

      const res = await chatPost(jsonRequest(CHAT_URL, HELLO));
      expect(res.status).toBe(502);
    });

    it('survives a non-ASCII provider error message', async () => {
      // Regression: header values are ByteStrings, so a curly quote or an
      // em-dash in a provider message used to throw inside `new Response` and
      // turn a handled upstream failure into an unhandled 500 — losing the real
      // error. Providers return non-English text routinely.
      upstream = stubUpstream([
        providerError(503, 'Le fournisseur est indisponible — réessayez plus tard'),
        chatOk(),
      ]);

      const res = await chatPost(jsonRequest(CHAT_URL, HELLO));

      expect(res.status).toBe(200);
      const reason = res.headers.get('x-switchboard-fallback-reason');
      expect(reason).toBeTruthy();
      // Every byte must be representable in a header.
      expect(reason!).toMatch(/^[\x20-\x7e]*$/);
    });

    it('keeps the fallback header safe for CJK and emoji', async () => {
      upstream = stubUpstream([providerError(429, '速率限制已达到 🚫'), chatOk()]);

      const res = await chatPost(jsonRequest(CHAT_URL, HELLO));

      expect(res.status).toBe(200);
      const reason = res.headers.get('x-switchboard-fallback-reason');
      expect(reason).toMatch(/^[\x20-\x7e]*$/);
      expect(reason).not.toBe('');
    });
  });

  // ── persistence ───────────────────────────────────────────────────────────

  describe('request logging', () => {
    beforeEach(() => {
      seedConnections();
    });

    it('writes one row for a successful request, with the decision trace', async () => {
      upstream = stubUpstream([chatOk()]);
      await chatPost(jsonRequest(CHAT_URL, HELLO));

      const { rows, total } = listRequestLogs({ limit: 10 });
      expect(total).toBe(1);

      const row = rows[0];
      expect(row?.status).toBe('success');
      expect(row?.httpStatus).toBe(200);
      expect(row?.attemptCount).toBe(1);
      expect(row?.usage?.promptTokens).toBe(12);
      expect(row?.usage?.completionTokens).toBe(8);

      const detail = getRequestLog(row!.id);
      expect(detail?.decision?.candidates.length).toBeGreaterThan(0);
      expect(detail?.decision?.winningAttempt).toBe(0);
    });

    it('records every attempt of a fallback in the stored trace', async () => {
      upstream = stubUpstream([providerError(429, 'slow down'), chatOk()]);
      await chatPost(jsonRequest(CHAT_URL, HELLO));

      const { rows } = listRequestLogs({ limit: 1 });
      const detail = getRequestLog(rows[0]!.id);

      expect(detail?.attemptCount).toBe(2);
      expect(detail?.decision?.attempts).toHaveLength(2);
      expect(detail?.decision?.attempts[0]?.status).toBe('error');
      expect(detail?.decision?.attempts[0]?.fallbackReason).toMatch(/rate limit/i);
      expect(detail?.decision?.attempts[1]?.status).toBe('success');
      expect(detail?.decision?.winningAttempt).toBe(1);
    });

    it('logs a failed request too, with the error text', async () => {
      upstream = stubUpstream([providerError(500, 'everything is on fire')]);
      await chatPost(jsonRequest(CHAT_URL, HELLO));

      const { rows } = listRequestLogs({ limit: 1 });
      expect(rows[0]?.status).toBe('error');
      expect(rows[0]?.error).toBeTruthy();
    });

    it('attributes the request to the API key that made it', async () => {
      const { key, secret } = createApiKey({ name: 'attributed' });
      upstream = stubUpstream([chatOk()]);

      await chatPost(jsonRequest(CHAT_URL, HELLO, { authorization: `Bearer ${secret}` }));

      const { rows } = listRequestLogs({ limit: 1 });
      expect(rows[0]?.apiKeyId).toBe(key.id);
    });
  });

  // ── model listing ─────────────────────────────────────────────────────────

  describe('GET /v1/models', () => {
    it('returns the OpenAI list shape', async () => {
      seedConnections();

      const res = await modelsGet(new Request(MODELS_URL));
      expect(res.status).toBe(200);

      const body = (await res.json()) as {
        object: string;
        data: Array<{ id: string; object: string; owned_by: string }>;
      };

      expect(body.object).toBe('list');
      expect(body.data.length).toBeGreaterThan(0);
      expect(body.data[0]?.object).toBe('model');
      expect(body.data[0]?.owned_by).toBeTruthy();
    });

    it('deduplicates a model served by several connections', async () => {
      // Two connections to the same provider offer identical catalogues; the
      // duplication is the fallback chain, not extra menu entries.
      const a = createConnection({ providerId: 'groq', label: 'Groq A' });
      setCredential(a.id, 'gsk_a');
      const b = createConnection({ providerId: 'groq', label: 'Groq B' });
      setCredential(b.id, 'gsk_b');

      const res = await modelsGet(new Request(MODELS_URL));
      const body = (await res.json()) as { data: Array<{ id: string }> };

      const ids = body.data.map((m) => m.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('lists nothing when no connection has a credential', async () => {
      createConnection({ providerId: 'groq', label: 'No key' });

      const res = await modelsGet(new Request(MODELS_URL));
      const body = (await res.json()) as { data: unknown[] };
      expect(body.data).toHaveLength(0);
    });
  });
});
