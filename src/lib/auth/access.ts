import { isLocalRequest, isRemoteAccessAllowed, requireLocalOrToken } from './session';

/**
 * Request-level checks that do not depend on who the caller is, only on where
 * the request came from: the Host it was addressed to and the page that sent
 * it. They close the two ways a web page in the user's own browser could reach
 * a loopback-bound gateway, which the localhost check alone cannot see: both
 * arrive from 127.0.0.1.
 *
 * - DNS rebinding: a page on evil.example re-points its own name at 127.0.0.1
 *   and then reads the dashboard as same-origin. The Host header still says
 *   evil.example, so only names that cannot be rebound are accepted.
 * - Cross-site requests: a form or `fetch` with a simple content type reaches
 *   the server without a CORS preflight. The handlers parse the body regardless
 *   of content type, so a page could mint keys or spend credentials blind.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function csv(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

/**
 * Hostnames accepted on top of IP literals and localhost, for a gateway reached
 * through a reverse proxy or a LAN name. Exact names, ports ignored.
 */
export function allowedHosts(): string[] {
  return csv(process.env.SWITCHBOARD_ALLOWED_HOSTS).map((host) => host.toLowerCase());
}

/**
 * Origins allowed to call `/v1` from a browser.
 *
 * `*` was the old default and it was the wrong one. The gateway holds every
 * provider credential the user owns, and a wildcard means any page in that
 * browser can spend them the moment it learns a key — the same-origin policy
 * being the only thing that would otherwise have stopped it.
 *
 * The endpoint is designed for server-side SDK clients, which do not send an
 * `Origin` header and are unaffected by CORS at all. So the default is no
 * CORS, and a browser app opts in explicitly:
 *
 *     SWITCHBOARD_CORS_ORIGINS=http://localhost:3000,https://myapp.example
 *     SWITCHBOARD_CORS_ORIGINS=*        (the old behaviour, if you want it)
 */
export function allowedOrigins(): string[] {
  return csv(process.env.SWITCHBOARD_CORS_ORIGINS?.trim()).map((origin) => origin.replace(/\/$/, ''));
}

/** "Example.com:7272" → "example.com", "[::1]:7272" → "::1". */
function hostnameOf(host: string): string {
  const value = host.trim().toLowerCase();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(value);
  if (bracketed?.[1]) return bracketed[1];
  // A bare IPv6 literal has several colons and no port.
  if ((value.match(/:/g) ?? []).length > 1) return value;
  return value.replace(/:\d+$/, '');
}

function isIpLiteral(hostname: string): boolean {
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return true;
  return hostname.includes(':');
}

/**
 * Whether the Host header names something a rebinding attack cannot use.
 *
 * Rebinding needs a domain the attacker controls, so an IP literal is always
 * safe, and browsers resolve `localhost` and `*.localhost` themselves. Anything
 * else has to be listed. A request with no Host at all (HTTP/1.0, or a Request
 * built in a test) is not a browser and is let through.
 */
export function hostAllowed(req: Request): boolean {
  const raw = req.headers.get('host');
  if (raw === null || raw.trim() === '') return true;
  const hostname = hostnameOf(raw);
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  if (isIpLiteral(hostname)) return true;
  return allowedHosts().includes(hostname);
}

/** The host:port the request was addressed to. */
function requestHost(req: Request): string | null {
  const header = req.headers.get('host');
  if (header !== null && header.trim() !== '') return header.trim().toLowerCase();
  try {
    return new URL(req.url).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Whether a browser on some other origin sent this. A request with no Origin
 * header at all is a server-side client (the CLI, curl, an SDK); those are not
 * what CSRF is about.
 */
function fromOtherOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (origin === null) return false;
  if (origin === 'null') return true;
  try {
    const parsed = new URL(origin);
    if (parsed.host.toLowerCase() === requestHost(req)) return false;
    return !allowedHosts().includes(parsed.hostname.toLowerCase());
  } catch {
    return true;
  }
}

/**
 * A state-changing request that a page on another site sent. Sec-Fetch-Site
 * covers browsers that omit Origin; `same-site` counts too, because another app
 * on localhost:3000 is the same site as the dashboard on localhost:7272.
 */
export function crossSiteWrite(req: Request): boolean {
  if (SAFE_METHODS.has(req.method.toUpperCase())) return false;
  return crossSite(req);
}

/** Cross-site regardless of method, for endpoints that hand out a secret. */
export function crossSite(req: Request): boolean {
  const site = req.headers.get('sec-fetch-site');
  if (site === 'cross-site' || site === 'same-site') return true;
  return fromOtherOrigin(req);
}

/**
 * Whether a browser page may call `/v1`. Same rule as the CORS headers: if the
 * origin may not read the response, it may not spend money producing it either.
 */
export function gatewayOriginAllowed(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (origin === null) return true;
  if (!fromOtherOrigin(req)) return true;
  const allowed = allowedOrigins();
  return allowed.includes('*') || allowed.includes(origin.replace(/\/$/, ''));
}

export function forbidden(code: string, message: string, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: { message, type: 'forbidden', code } }), {
    status: 403,
    headers: { 'content-type': 'application/json', ...extra },
  });
}

export function hostDenied(): Response {
  return forbidden(
    'host_not_allowed',
    'This Host is not one Switchboard answers to. Use localhost or an IP address, or list ' +
      'the name in SWITCHBOARD_ALLOWED_HOSTS if a reverse proxy forwards it.',
  );
}

/**
 * The full gate for the dashboard and the management API: the Host has to be
 * one that cannot be rebound, a write has to come from the dashboard's own
 * origin, and the caller has to be local or hold the token.
 */
export function adminGate(req: Request): Response | null {
  if (!hostAllowed(req)) return hostDenied();
  if (crossSiteWrite(req)) {
    return forbidden(
      'cross_site_request',
      'Refused a state-changing request sent from another site.',
    );
  }
  return requireLocalOrToken(req);
}

/**
 * Stricter than `adminGate`: for endpoints that reveal or reset the dashboard
 * token itself. Holding the token or setting SWITCHBOARD_ALLOW_REMOTE is not
 * enough; only a shell on this machine qualifies.
 */
export function localOnlyGate(req: Request): Response | null {
  if (!hostAllowed(req)) return hostDenied();
  if (crossSite(req)) return forbidden('cross_site_request', 'Refused a request sent from another site.');
  if (!isLocalRequest(req)) {
    return forbidden('local_only', 'This endpoint only answers requests from the machine running Switchboard.');
  }
  return null;
}

/** Whether a gateway call with no API key configured may run open. */
export function mayRunOpen(req: Request): boolean {
  return isLocalRequest(req) || isRemoteAccessAllowed();
}
