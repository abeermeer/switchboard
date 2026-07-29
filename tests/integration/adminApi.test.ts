import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GET as providersGet } from '@/app/api/providers/route';
import { GET as connectionsGet, POST as connectionsPost } from '@/app/api/connections/route';
import {
  DELETE as connectionDelete,
  GET as connectionGet,
  PATCH as connectionPatch,
} from '@/app/api/connections/[id]/route';
import { PUT as credentialPut, DELETE as credentialDelete } from '@/app/api/connections/[id]/credential/route';
import { GET as combosGet, POST as combosPost } from '@/app/api/combos/route';
import { PATCH as comboPatch, DELETE as comboDelete } from '@/app/api/combos/[id]/route';
import { PUT as membersPut } from '@/app/api/combos/[id]/members/route';
import { POST as simulatePost } from '@/app/api/combos/[id]/simulate/route';
import { GET as keysGet, POST as keysPost } from '@/app/api/keys/route';
import { PATCH as keyPatch, DELETE as keyDelete } from '@/app/api/keys/[id]/route';
import { GET as settingsGet, PATCH as settingsPatch } from '@/app/api/settings/route';
import { GET as statusGet } from '@/app/api/system/status/route';
import { GET as healthGet } from '@/app/api/health/route';
import { GET as logsGet, DELETE as logsDelete } from '@/app/api/logs/route';
import { GET as modelsGet } from '@/app/api/models/route';
import { ensureSeedCombos, listCombos } from '@/lib/db/repos/combos';
import { createConnection, listConnections } from '@/lib/db/repos/connections';
import { setCredential, hasCredential } from '@/lib/db/repos/credentials';
import { insertRequestLog } from '@/lib/db/repos/log';
import { reloadMasterKey } from '@/lib/crypto/vault';
import { dropDb, freshDb } from '../helpers/db';

/**
 * The management API is what the dashboard talks to. It can create API keys,
 * read stored prompts and change routing, so the guard on every handler matters
 * as much as the handlers themselves.
 */

const BASE = 'http://127.0.0.1:7272';

/** A request that looks like it came from the machine itself. */
function local(path: string, init: RequestInit = {}): Request {
  return new Request(`${BASE}${path}`, init);
}

/** A request arriving through a proxy from somewhere else. */
function remote(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set('x-forwarded-for', '203.0.113.9');
  return new Request(`${BASE}${path}`, { ...init, headers });
}

function json(path: string, body: unknown, init: RequestInit = {}): Request {
  return new Request(`${BASE}${path}`, {
    method: init.method ?? 'POST',
    headers: { 'content-type': 'application/json', ...(init.headers as Record<string, string>) },
    body: JSON.stringify(body),
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe('management API', () => {
  let dir: string;

  beforeEach(() => {
    dir = freshDb();
    reloadMasterKey();
    delete process.env.SWITCHBOARD_ALLOW_REMOTE;
  });

  afterEach(() => {
    delete process.env.SWITCHBOARD_ALLOW_REMOTE;
    dropDb(dir);
  });

  // ── the guard ─────────────────────────────────────────────────────────────

  describe('access control', () => {
    it('serves a loopback request', async () => {
      expect((await statusGet(local('/api/system/status'))).status).toBe(200);
    });

    it('refuses a remote request with 403 and an actionable message', async () => {
      const res = await statusGet(remote('/api/system/status'));

      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('remote_access_denied');
      // The message has to say how to fix it, or the operator is stuck.
      expect(body.error.message).toContain('SWITCHBOARD_ALLOW_REMOTE');
    });

    it('allows a remote request once the operator opts in', async () => {
      process.env.SWITCHBOARD_ALLOW_REMOTE = '1';
      expect((await statusGet(remote('/api/system/status'))).status).toBe(200);
    });

    it('treats an IPv6 loopback address as local', async () => {
      const res = await statusGet(
        new Request(`${BASE}/api/system/status`, { headers: { 'x-forwarded-for': '::1' } }),
      );
      expect(res.status).toBe(200);
    });

    it('treats an IPv4-mapped IPv6 loopback as local', async () => {
      const res = await statusGet(
        new Request(`${BASE}/api/system/status`, {
          headers: { 'x-forwarded-for': '::ffff:127.0.0.1' },
        }),
      );
      expect(res.status).toBe(200);
    });

    it('guards every read endpoint, not just status', async () => {
      // A guard applied inconsistently is worse than none, because it implies a
      // protection that is not there.
      const guarded: Array<[string, Promise<Response>]> = [
        ['providers', providersGet(remote('/api/providers'))],
        ['connections', connectionsGet(remote('/api/connections'))],
        ['combos', combosGet(remote('/api/combos'))],
        ['keys', keysGet(remote('/api/keys'))],
        ['settings', settingsGet(remote('/api/settings'))],
        ['health', healthGet(remote('/api/health'))],
        ['logs', logsGet(remote('/api/logs'))],
        ['models', modelsGet(remote('/api/models'))],
      ];

      for (const [name, promise] of guarded) {
        expect((await promise).status, `${name} should refuse a remote caller`).toBe(403);
      }
    });

    it('guards the destructive endpoints too', async () => {
      const conn = createConnection({ providerId: 'groq' });

      expect((await connectionDelete(remote(`/api/connections/${conn.id}`, { method: 'DELETE' }), params(conn.id))).status).toBe(403);
      expect((await logsDelete(remote('/api/logs', { method: 'DELETE' }))).status).toBe(403);
      expect((await credentialDelete(remote(`/api/connections/${conn.id}/credential`, { method: 'DELETE' }), params(conn.id))).status).toBe(403);
    });
  });

  // ── connections ───────────────────────────────────────────────────────────

  describe('connections', () => {
    it('creates a connection and stores its credential', async () => {
      const res = await connectionsPost(
        json('/api/connections', { providerId: 'groq', label: 'Groq', apiKey: 'gsk_test_123456' }),
      );

      expect(res.status).toBe(201);
      const created = (await res.json()) as { id: string; label: string };
      expect(created.label).toBe('Groq');
      expect(hasCredential(created.id)).toBe(true);
    });

    it('rejects an unknown provider with 404', async () => {
      const res = await connectionsPost(
        json('/api/connections', { providerId: 'not-a-provider' }),
      );

      expect(res.status).toBe(404);
      expect(listConnections()).toHaveLength(0);
    });

    it('rejects a body missing providerId with 400', async () => {
      const res = await connectionsPost(json('/api/connections', { label: 'orphan' }));
      expect(res.status).toBe(400);
    });

    it('rejects a malformed JSON body with 400 rather than 500', async () => {
      const res = await connectionsPost(
        new Request(`${BASE}/api/connections`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{ not json',
        }),
      );
      expect(res.status).toBe(400);
    });

    it('returns a connection view with provider and health joined in', async () => {
      const conn = createConnection({ providerId: 'groq', label: 'Groq' });
      setCredential(conn.id, 'gsk_x');

      const res = await connectionGet(local(`/api/connections/${conn.id}`), params(conn.id));
      const view = (await res.json()) as Record<string, unknown>;

      expect(res.status).toBe(200);
      expect((view.provider as Record<string, unknown>).name).toBeTruthy();
      expect(view.health).toBeTruthy();
      expect(view.hasCredential).toBe(true);
    });

    it('404s for a connection that does not exist', async () => {
      const res = await connectionGet(local('/api/connections/nope'), params('nope'));
      expect(res.status).toBe(404);
    });

    it('patches a connection', async () => {
      const conn = createConnection({ providerId: 'groq', label: 'Old' });

      const res = await connectionPatch(
        json(`/api/connections/${conn.id}`, { label: 'New', priority: 5 }, { method: 'PATCH' }),
        params(conn.id),
      );

      expect(res.status).toBe(200);
      const updated = (await res.json()) as { label: string; priority: number };
      expect(updated.label).toBe('New');
      expect(updated.priority).toBe(5);
    });

    it('rejects a patch with an out-of-range priority', async () => {
      const conn = createConnection({ providerId: 'groq' });
      const res = await connectionPatch(
        json(`/api/connections/${conn.id}`, { priority: 99_999 }, { method: 'PATCH' }),
        params(conn.id),
      );
      expect(res.status).toBe(400);
    });

    it('deletes a connection', async () => {
      const conn = createConnection({ providerId: 'groq' });

      const res = await connectionDelete(
        local(`/api/connections/${conn.id}`, { method: 'DELETE' }),
        params(conn.id),
      );

      expect(res.status).toBe(200);
      expect(listConnections()).toHaveLength(0);
    });

    it('stores a credential and returns only a hint, never the key', async () => {
      const conn = createConnection({ providerId: 'groq' });

      const res = await credentialPut(
        json(`/api/connections/${conn.id}/credential`, { apiKey: 'gsk_supersecret_9876' }, { method: 'PUT' }),
        params(conn.id),
      );

      expect(res.status).toBe(200);
      const body = await res.text();
      // No endpoint may echo a stored credential back.
      expect(body).not.toContain('gsk_supersecret_9876');
      expect(body).toContain('hint');
    });

    it('removes a credential', async () => {
      const conn = createConnection({ providerId: 'groq' });
      setCredential(conn.id, 'gsk_x');

      await credentialDelete(
        local(`/api/connections/${conn.id}/credential`, { method: 'DELETE' }),
        params(conn.id),
      );

      expect(hasCredential(conn.id)).toBe(false);
    });
  });

  // ── combos ────────────────────────────────────────────────────────────────

  describe('routing policies', () => {
    it('creates a policy', async () => {
      const res = await combosPost(
        json('/api/combos', { slug: 'cheap-coder', name: 'Cheap coder' }),
      );

      expect(res.status).toBe(201);
      expect(listCombos().some((c) => c.slug === 'cheap-coder')).toBe(true);
    });

    it('rejects a duplicate slug with 409 rather than 500', async () => {
      await combosPost(json('/api/combos', { slug: 'dupe', name: 'First' }));
      const res = await combosPost(json('/api/combos', { slug: 'dupe', name: 'Second' }));

      expect(res.status).toBe(409);
    });

    it('rejects a slug with invalid characters', async () => {
      const res = await combosPost(json('/api/combos', { slug: 'Bad Slug!', name: 'x' }));
      expect(res.status).toBe(400);
    });

    it('patches a policy', async () => {
      ensureSeedCombos();
      const combo = listCombos()[0]!;

      const res = await comboPatch(
        json(`/api/combos/${combo.id}`, { strategy: 'fastest' }, { method: 'PATCH' }),
        params(combo.id),
      );

      expect(res.status).toBe(200);
      expect(((await res.json()) as { strategy: string }).strategy).toBe('fastest');
    });

    it('rejects an unknown strategy', async () => {
      ensureSeedCombos();
      const combo = listCombos()[0]!;

      const res = await comboPatch(
        json(`/api/combos/${combo.id}`, { strategy: 'vibes' }, { method: 'PATCH' }),
        params(combo.id),
      );
      expect(res.status).toBe(400);
    });

    it('replaces the member chain', async () => {
      ensureSeedCombos();
      const combo = listCombos()[0]!;
      const conn = createConnection({ providerId: 'groq' });

      const res = await membersPut(
        json(
          `/api/combos/${combo.id}/members`,
          {
            members: [
              { connectionId: conn.id, modelId: 'llama-3.1-8b-instant', order: 0, weight: 1, enabled: true },
            ],
          },
          { method: 'PUT' },
        ),
        params(combo.id),
      );

      expect(res.status).toBe(200);
      const updated = (await res.json()) as { members: unknown[] };
      expect(updated.members).toHaveLength(1);
    });

    it('deletes a policy', async () => {
      const created = (await (
        await combosPost(json('/api/combos', { slug: 'temp', name: 'Temp' }))
      ).json()) as { id: string };

      const res = await comboDelete(
        local(`/api/combos/${created.id}`, { method: 'DELETE' }),
        params(created.id),
      );

      expect(res.status).toBe(200);
      expect(listCombos().some((c) => c.slug === 'temp')).toBe(false);
    });

    it('404s when patching a policy that does not exist', async () => {
      const res = await comboPatch(
        json('/api/combos/nope', { name: 'x' }, { method: 'PATCH' }),
        params('nope'),
      );
      expect(res.status).toBe(404);
    });
  });

  // ── the simulator ─────────────────────────────────────────────────────────

  describe('policy simulation', () => {
    it('scores candidates without sending anything upstream', async () => {
      // The differentiating endpoint. If it ever reached a provider it would
      // cost money and defeat its own purpose, so the absence of a fetch stub
      // here is deliberate: a real call would fail the test by throwing.
      ensureSeedCombos();
      const combo = listCombos().find((c) => c.slug === 'auto')!;

      const conn = createConnection({ providerId: 'groq' });
      setCredential(conn.id, 'gsk_x');

      const res = await simulatePost(
        json(`/api/combos/${combo.id}/simulate`, { prompt: 'write a binary search' }),
        params(combo.id),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        strategy: string;
        weights: Record<string, number>;
        candidates: Array<Record<string, unknown>>;
        winner: Record<string, unknown> | null;
      };

      expect(body.strategy).toBe('free-first');
      expect(Object.keys(body.weights).length).toBe(8);
      expect(body.candidates.length).toBeGreaterThan(0);
      expect(body.winner).not.toBeNull();
    });

    it('decorates each candidate with the provider name and accent for the UI', async () => {
      ensureSeedCombos();
      const combo = listCombos().find((c) => c.slug === 'auto')!;
      const conn = createConnection({ providerId: 'groq' });
      setCredential(conn.id, 'gsk_x');

      const res = await simulatePost(
        json(`/api/combos/${combo.id}/simulate`, { prompt: 'hi' }),
        params(combo.id),
      );
      const body = (await res.json()) as { candidates: Array<Record<string, unknown>> };

      expect(body.candidates[0]?.providerName).toBeTruthy();
      expect(body.candidates[0]?.accent).toMatch(/^#/);
    });

    it('reports every score factor with a human-readable note', async () => {
      // The dashboard renders those notes verbatim; an empty one is a blank row.
      ensureSeedCombos();
      const combo = listCombos().find((c) => c.slug === 'auto')!;
      const conn = createConnection({ providerId: 'groq' });
      setCredential(conn.id, 'gsk_x');

      const res = await simulatePost(
        json(`/api/combos/${combo.id}/simulate`, { prompt: 'hi' }),
        params(combo.id),
      );
      const body = (await res.json()) as {
        candidates: Array<{ factors: Array<{ name: string; note: string }> }>;
      };

      const factors = body.candidates[0]!.factors;
      expect(factors).toHaveLength(8);
      expect(factors.every((f) => f.note.length > 0)).toBe(true);
    });

    it('lists exclusions with their reasons', async () => {
      ensureSeedCombos();
      const combo = listCombos().find((c) => c.slug === 'auto')!;

      // No credential, so every candidate on it should be excluded and say why.
      createConnection({ providerId: 'groq' });

      const res = await simulatePost(
        json(`/api/combos/${combo.id}/simulate`, { prompt: 'hi' }),
        params(combo.id),
      );
      const body = (await res.json()) as {
        excluded: Array<{ excludedReason: string }>;
      };

      expect(body.excluded.length).toBeGreaterThan(0);
      expect(body.excluded[0]?.excludedReason).toMatch(/API key/i);
    });

    it('404s for a policy that does not exist', async () => {
      const res = await simulatePost(
        json('/api/combos/nope/simulate', { prompt: 'hi' }),
        params('nope'),
      );
      expect(res.status).toBe(404);
    });
  });

  // ── keys ──────────────────────────────────────────────────────────────────

  describe('API keys', () => {
    it('returns the plaintext secret exactly once, on creation', async () => {
      const res = await keysPost(json('/api/keys', { name: 'laptop' }));

      expect(res.status).toBe(201);
      const body = (await res.json()) as { key: { id: string; prefix: string }; secret: string };
      expect(body.secret).toMatch(/^sb-live-/);

      // And never again from the list endpoint.
      const listed = await (await keysGet(local('/api/keys'))).text();
      expect(listed).not.toContain(body.secret);
    });

    it('reports month-to-date spend alongside each key', async () => {
      await keysPost(json('/api/keys', { name: 'metered', monthlyBudgetUsd: 10 }));

      const body = (await (await keysGet(local('/api/keys'))).json()) as {
        items: Array<Record<string, unknown>>;
      };

      expect(body.items[0]).toHaveProperty('spentThisMonthUsd');
    });

    it('patches a key', async () => {
      const created = (await (
        await keysPost(json('/api/keys', { name: 'k' }))
      ).json()) as { key: { id: string } };

      const res = await keyPatch(
        json(`/api/keys/${created.key.id}`, { enabled: false }, { method: 'PATCH' }),
        params(created.key.id),
      );

      expect(res.status).toBe(200);
      expect(((await res.json()) as { enabled: boolean }).enabled).toBe(false);
    });

    it('revokes a key', async () => {
      const created = (await (
        await keysPost(json('/api/keys', { name: 'k' }))
      ).json()) as { key: { id: string } };

      const res = await keyDelete(
        local(`/api/keys/${created.key.id}`, { method: 'DELETE' }),
        params(created.key.id),
      );

      expect(res.status).toBe(200);
      const body = (await (await keysGet(local('/api/keys'))).json()) as { items: unknown[] };
      expect(body.items).toHaveLength(0);
    });

    it('rejects an unknown onBudgetExceeded value', async () => {
      const res = await keysPost(
        json('/api/keys', { name: 'k', onBudgetExceeded: 'explode' }),
      );
      expect(res.status).toBe(400);
    });

    it('404s when patching a key that does not exist', async () => {
      const res = await keyPatch(
        json('/api/keys/nope', { enabled: false }, { method: 'PATCH' }),
        params('nope'),
      );
      expect(res.status).toBe(404);
    });
  });

  // ── settings ──────────────────────────────────────────────────────────────

  describe('settings', () => {
    it('returns the full settings object with defaults applied', async () => {
      const body = (await (await settingsGet(local('/api/settings'))).json()) as Record<
        string,
        unknown
      >;

      expect(body.defaultCombo).toBeTruthy();
      expect(typeof body.logRetentionDays).toBe('number');
      expect(typeof body.preferFreeTiers).toBe('boolean');
    });

    it('patches only the keys provided', async () => {
      const before = (await (await settingsGet(local('/api/settings'))).json()) as {
        logRetentionDays: number;
        defaultCombo: string;
      };

      const res = await settingsPatch(
        json('/api/settings', { logRetentionDays: 14 }, { method: 'PATCH' }),
      );
      const after = (await res.json()) as { logRetentionDays: number; defaultCombo: string };

      expect(after.logRetentionDays).toBe(14);
      expect(after.defaultCombo).toBe(before.defaultCombo);
    });

    it('rejects a retention value outside the allowed range', async () => {
      const res = await settingsPatch(
        json('/api/settings', { logRetentionDays: -5 }, { method: 'PATCH' }),
      );
      expect(res.status).toBe(400);
    });

    it('rejects an unknown theme', async () => {
      const res = await settingsPatch(
        json('/api/settings', { theme: 'neon' }, { method: 'PATCH' }),
      );
      expect(res.status).toBe(400);
    });
  });

  // ── status, health, logs, models ──────────────────────────────────────────

  describe('system endpoints', () => {
    it('reports connection counts by status', async () => {
      const conn = createConnection({ providerId: 'groq' });
      setCredential(conn.id, 'gsk_x');

      const body = (await (await statusGet(local('/api/system/status'))).json()) as {
        connections: Record<string, number>;
        today: Record<string, number>;
        version: string;
      };

      expect(body.connections.total).toBe(1);
      expect(body.version).toBeTruthy();
      expect(body.today).toHaveProperty('costUsd');
    });

    it('reports an overall health verdict', async () => {
      const body = (await (await healthGet(local('/api/health'))).json()) as {
        overall: string;
        items: unknown[];
        lockouts: unknown[];
      };

      expect(['operational', 'degraded', 'outage', 'unknown']).toContain(body.overall);
      expect(Array.isArray(body.items)).toBe(true);
      expect(Array.isArray(body.lockouts)).toBe(true);
    });

    it('annotates the provider catalog with what is already connected', async () => {
      createConnection({ providerId: 'groq' });

      const body = (await (await providersGet(local('/api/providers'))).json()) as {
        items: Array<{ id: string; connected: boolean; connectionCount: number }>;
      };

      const groq = body.items.find((p) => p.id === 'groq')!;
      const openai = body.items.find((p) => p.id === 'openai')!;

      expect(groq.connected).toBe(true);
      expect(groq.connectionCount).toBe(1);
      expect(openai.connected).toBe(false);
    });

    it('groups models by the providers that serve them', async () => {
      const groq = createConnection({ providerId: 'groq' });
      setCredential(groq.id, 'gsk_x');

      const body = (await (await modelsGet(local('/api/models'))).json()) as {
        items: Array<{ id: string; providerCount: number; offerings: unknown[] }>;
      };

      expect(body.items.length).toBeGreaterThan(0);
      expect(body.items[0]?.offerings.length).toBeGreaterThan(0);
    });

    it('filters the request log by status', async () => {
      insertRequestLog(
        {
          id: 'ok_1',
          ts: Date.now(),
          apiKeyId: null,
          modality: 'chat',
          requestedModel: 'auto',
          resolvedConnectionId: null,
          resolvedProviderId: 'groq',
          resolvedModelId: 'm',
          status: 'success',
          httpStatus: 200,
          durationMs: 10,
          ttftMs: null,
          streamed: false,
          usage: null,
          costUsd: 0,
          attemptCount: 1,
          error: null,
          clientIp: null,
          userAgent: null,
        },
        {},
      );

      const errors = (await (
        await logsGet(local('/api/logs?status=error'))
      ).json()) as { rows: unknown[]; total: number };
      expect(errors.total).toBe(0);

      const successes = (await (
        await logsGet(local('/api/logs?status=success'))
      ).json()) as { total: number };
      expect(successes.total).toBe(1);
    });

    it('clamps an absurd limit rather than trying to honour it', async () => {
      const res = await logsGet(local('/api/logs?limit=100000'));
      expect(res.status).toBe(200);
    });
  });
});
