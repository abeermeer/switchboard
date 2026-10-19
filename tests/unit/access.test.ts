import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import {
  adminGate,
  crossSiteWrite,
  gatewayOriginAllowed,
  hostAllowed,
  localOnlyGate,
} from '@/lib/auth/access';
import { getDashboardToken, isLocalRequest, requireLocalOrToken, TOKEN_COOKIE } from '@/lib/auth/session';
import { authenticate } from '@/lib/api/respond';
import { createApiKey } from '@/lib/db/repos/apiKeys';
import { proxy } from '@/proxy';
import { dropDb, freshDb } from '../helpers/db';

const BASE = 'http://127.0.0.1:7272';

function req(path: string, headers: Record<string, string> = {}, method = 'GET'): Request {
  return new Request(`${BASE}${path}`, { method, headers });
}

/** What server.mjs hands the app for a caller at `peer`. */
function stamped(path: string, verdict: 'local' | 'remote', headers: Record<string, string> = {}, method = 'GET'): Request {
  return req(path, { 'x-switchboard-client': verdict, 'x-switchboard-peer': verdict === 'local' ? '127.0.0.1' : '192.0.2.50', ...headers }, method);
}

describe('access control', () => {
  let dir: string;
  const saved = { ...process.env };

  beforeEach(() => {
    dir = freshDb();
    delete process.env.SWITCHBOARD_SERVER;
    delete process.env.SWITCHBOARD_ALLOW_REMOTE;
    delete process.env.SWITCHBOARD_ALLOWED_HOSTS;
    delete process.env.SWITCHBOARD_CORS_ORIGINS;
  });

  afterEach(() => {
    for (const key of ['SWITCHBOARD_SERVER', 'SWITCHBOARD_ALLOW_REMOTE', 'SWITCHBOARD_ALLOWED_HOSTS', 'SWITCHBOARD_CORS_ORIGINS']) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    dropDb(dir);
  });

  // ── the localhost decision ────────────────────────────────────────────────

  describe('behind server.mjs', () => {
    beforeEach(() => {
      process.env.SWITCHBOARD_SERVER = '1';
    });

    it('trusts the verdict the server read off the socket', () => {
      expect(isLocalRequest(stamped('/api/keys', 'local'))).toBe(true);
      expect(isLocalRequest(stamped('/api/keys', 'remote'))).toBe(false);
    });

    it('ignores a spoofed X-Forwarded-For entirely', () => {
      // The exact request that used to be full admin from anywhere on the network.
      const spoofed = stamped('/api/keys', 'remote', { 'x-forwarded-for': '127.0.0.1' });
      expect(isLocalRequest(spoofed)).toBe(false);
      expect(requireLocalOrToken(spoofed)?.status).toBe(403);
    });

    it('treats a request with no verdict as remote rather than guessing', () => {
      expect(isLocalRequest(req('/api/keys'))).toBe(false);
    });
  });

  describe('without server.mjs (next dev, tests)', () => {
    it('falls back to the forwarded header', () => {
      expect(isLocalRequest(req('/api/keys'))).toBe(true);
      expect(isLocalRequest(req('/api/keys', { 'x-forwarded-for': '203.0.113.9' }))).toBe(false);
    });

    it('fails closed in production, where only server.mjs is supported', () => {
      // A hand-written unit running bare `next start` listens on every
      // interface, and the header fallback would let anyone claim to be local.
      const env = process.env as Record<string, string | undefined>;
      const saved = env.NODE_ENV;
      env.NODE_ENV = 'production';
      try {
        expect(isLocalRequest(req('/api/keys'))).toBe(false);
        expect(isLocalRequest(req('/api/keys', { 'x-forwarded-for': '127.0.0.1' }))).toBe(false);
      } finally {
        env.NODE_ENV = saved;
      }
    });

    it('no longer counts the unspecified address :: as loopback', () => {
      expect(isLocalRequest(req('/api/keys', { 'x-forwarded-for': '::' }))).toBe(false);
    });
  });

  // ── DNS rebinding ─────────────────────────────────────────────────────────

  describe('hostAllowed', () => {
    it.each([
      ['127.0.0.1:7272'],
      ['localhost:7272'],
      ['app.localhost'],
      ['[::1]:7272'],
      ['192.168.1.20:7272'],
    ])('accepts %s', (host) => {
      expect(hostAllowed(req('/', { host }))).toBe(true);
    });

    it('refuses a name that could be rebound to 127.0.0.1', () => {
      expect(hostAllowed(req('/', { host: 'evil.example:7272' }))).toBe(false);
    });

    it('accepts a name the operator listed', () => {
      process.env.SWITCHBOARD_ALLOWED_HOSTS = 'switchboard.lan, Gateway.Example';
      expect(hostAllowed(req('/', { host: 'switchboard.lan:7272' }))).toBe(true);
      expect(hostAllowed(req('/', { host: 'gateway.example' }))).toBe(true);
    });

    it('refuses a foreign Host on the admin gate even from loopback', () => {
      const res = adminGate(req('/api/keys', { host: 'evil.example:7272' }));
      expect(res?.status).toBe(403);
    });
  });

  // ── cross-site requests ───────────────────────────────────────────────────

  describe('crossSiteWrite', () => {
    it('refuses a write from another origin', () => {
      const r = req('/api/keys', { origin: 'https://evil.example', host: '127.0.0.1:7272' }, 'POST');
      expect(crossSiteWrite(r)).toBe(true);
      expect(adminGate(r)?.status).toBe(403);
    });

    it('refuses a same-site write, which another app on localhost would be', () => {
      expect(crossSiteWrite(req('/api/keys', { 'sec-fetch-site': 'same-site' }, 'POST'))).toBe(true);
    });

    it('refuses an opaque origin', () => {
      expect(crossSiteWrite(req('/api/keys', { origin: 'null' }, 'POST'))).toBe(true);
    });

    it('allows the dashboard writing to its own origin', () => {
      const r = req('/api/keys', { origin: 'http://127.0.0.1:7272', host: '127.0.0.1:7272' }, 'POST');
      expect(crossSiteWrite(r)).toBe(false);
      expect(adminGate(r)).toBeNull();
    });

    it('allows a client that sends no Origin at all (the CLI, curl)', () => {
      expect(crossSiteWrite(req('/api/keys', {}, 'POST'))).toBe(false);
    });

    it('does not apply to reads', () => {
      expect(crossSiteWrite(req('/api/keys', { origin: 'https://evil.example' }))).toBe(false);
    });
  });

  // ── the gateway ───────────────────────────────────────────────────────────

  describe('gateway', () => {
    it('refuses a browser origin that is not allowlisted', () => {
      expect(gatewayOriginAllowed(req('/v1/models', { origin: 'https://evil.example' }))).toBe(false);
      const auth = authenticate(req('/v1/models', { origin: 'https://evil.example' }));
      expect(auth.error?.status).toBe(403);
    });

    it('allows an allowlisted origin, and * when the operator chose it', () => {
      process.env.SWITCHBOARD_CORS_ORIGINS = 'http://localhost:3000';
      expect(gatewayOriginAllowed(req('/v1/models', { origin: 'http://localhost:3000' }))).toBe(true);
      process.env.SWITCHBOARD_CORS_ORIGINS = '*';
      expect(gatewayOriginAllowed(req('/v1/models', { origin: 'https://anything.example' }))).toBe(true);
    });

    it('runs open with no keys for this machine only', () => {
      process.env.SWITCHBOARD_SERVER = '1';
      expect(authenticate(stamped('/v1/models', 'local')).error).toBeNull();

      const remote = authenticate(stamped('/v1/models', 'remote'));
      expect(remote.error?.status).toBe(401);
    });

    it('runs open for a remote caller once the operator opts in', () => {
      process.env.SWITCHBOARD_SERVER = '1';
      process.env.SWITCHBOARD_ALLOW_REMOTE = '1';
      expect(authenticate(stamped('/v1/models', 'remote')).error).toBeNull();
    });

    it('still requires a key from everyone once one exists', () => {
      createApiKey({ name: 'k' });
      expect(authenticate(req('/v1/models')).error?.status).toBe(401);
    });
  });

  // ── the dashboard token ───────────────────────────────────────────────────

  describe('dashboard token', () => {
    beforeEach(() => {
      process.env.SWITCHBOARD_SERVER = '1';
    });

    it('admits a remote browser holding the token cookie', () => {
      const token = getDashboardToken();
      const r = stamped('/api/keys', 'remote', { cookie: `other=1; ${TOKEN_COOKIE}=${token}` });
      expect(requireLocalOrToken(r)).toBeNull();
    });

    it('refuses a wrong cookie', () => {
      const r = stamped('/api/keys', 'remote', { cookie: `${TOKEN_COOKIE}=nope` });
      expect(requireLocalOrToken(r)?.status).toBe(403);
    });

    it('only reveals the token to this machine, whatever else the caller holds', () => {
      const token = getDashboardToken();
      process.env.SWITCHBOARD_ALLOW_REMOTE = '1';
      expect(localOnlyGate(stamped('/api/system/token', 'remote', { 'x-switchboard-token': token }))?.status).toBe(403);
      expect(localOnlyGate(stamped('/api/system/token', 'local'))).toBeNull();
    });
  });

  // ── src/proxy.ts ──────────────────────────────────────────────────────────

  describe('proxy', () => {
    beforeEach(() => {
      process.env.SWITCHBOARD_SERVER = '1';
    });

    function next(path: string, verdict: 'local' | 'remote', headers: Record<string, string> = {}): NextRequest {
      return new NextRequest(`${BASE}${path}`, {
        headers: { host: '127.0.0.1:7272', 'x-switchboard-client': verdict, ...headers },
      });
    }

    it('refuses a remote caller on a dashboard page, which used to render freely', async () => {
      const res = proxy(next('/dashboard/keys', 'remote'));
      expect(res.status).toBe(403);
      expect(res.headers.get('content-type')).toContain('text/html');
    });

    it('lets this machine through', () => {
      expect(proxy(next('/dashboard/keys', 'local')).headers.get('x-middleware-next')).toBe('1');
    });

    it('swaps a valid ?token= for an HttpOnly cookie and strips it from the URL', () => {
      const token = getDashboardToken();
      const res = proxy(next(`/dashboard/keys?token=${token}`, 'remote'));
      expect(res.status).toBe(307);
      expect(res.headers.get('location')).not.toContain('token=');
      const cookie = res.headers.get('set-cookie') ?? '';
      expect(cookie).toContain(`${TOKEN_COOKIE}=${token}`);
      expect(cookie.toLowerCase()).toContain('httponly');
      // Lax so a link from email or chat still carries it; writes from other
      // sites are refused by the Origin check instead.
      expect(cookie.toLowerCase()).toContain('samesite=lax');
    });

    it('does not swap a wrong token', () => {
      expect(proxy(next('/dashboard/keys?token=wrong', 'remote')).status).toBe(403);
    });

    it('leaves /v1 to its own handlers but still refuses a rebinding Host', () => {
      expect(proxy(next('/v1/models', 'remote')).headers.get('x-middleware-next')).toBe('1');
      expect(proxy(next('/v1/models', 'local', { host: 'evil.example:7272' })).status).toBe(403);
    });
  });
});
