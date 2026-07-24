import { randomBytes, timingSafeEqual } from 'node:crypto';
import { getDb, parseJson } from '@/lib/db/client';
import { asRow, str } from '@/lib/db/rows';

/**
 * Dashboard auth.
 *
 * Switchboard binds to 127.0.0.1 by default, so anything that can reach the
 * dashboard already has the user's shell and there is nothing left to protect.
 * Auth only exists for the case where the operator deliberately exposes the
 * port, and it is a single bearer token rather than accounts because there is
 * exactly one user.
 */

const TOKEN_KEY = 'dashboard_token';
const TOKEN_BYTES = 24;
const TOKEN_HEADER = 'x-switchboard-token';

export function isRemoteAccessAllowed(): boolean {
  const raw = process.env.SWITCHBOARD_ALLOW_REMOTE?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/**
 * Stored in the settings table so it survives restarts and can be rotated from
 * the UI. Values there are JSON-encoded, matching the settings repo's format.
 */
export function getDashboardToken(): string {
  const row = asRow(getDb().prepare('SELECT value FROM settings WHERE key = ?').get(TOKEN_KEY));
  if (row) {
    const decoded = parseJson<unknown>(row.value, str(row.value));
    if (typeof decoded === 'string' && decoded.trim() !== '') return decoded;
  }
  return writeToken();
}

export function rotateDashboardToken(): string {
  return writeToken();
}

function writeToken(): string {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  getDb()
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(TOKEN_KEY, JSON.stringify(token));
  return token;
}

/**
 * The address the request came from, or null when nothing claims one.
 *
 * Next.js route handlers get a WHATWG Request with no socket attached, so the
 * forwarded header is the only signal available. Its absence means no proxy
 * touched the request, which for a loopback-bound server means it is local.
 */
export function clientAddress(req: Request): string | null {
  const forwarded = req.headers.get('x-forwarded-for');
  if (!forwarded) return null;
  const first = forwarded.split(',')[0]?.trim();
  return first ? first : null;
}

export function isLocalRequest(req: Request): boolean {
  const address = clientAddress(req);
  return address === null || isLoopback(address);
}

function isLoopback(address: string): boolean {
  let host = address.trim().toLowerCase();

  // "[::1]:8787" and "127.0.0.1:8787" both show up behind proxies.
  const bracketed = /^\[(.+)\](?::\d+)?$/.exec(host);
  const ipv4WithPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(host);
  if (bracketed?.[1]) host = bracketed[1];
  else if (ipv4WithPort?.[1]) host = ipv4WithPort[1];

  // IPv4-mapped IPv6, e.g. "::ffff:127.0.0.1".
  if (host.startsWith('::ffff:')) host = host.slice(7);

  if (host === 'localhost' || host === '::1' || host === '::') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** Bearer header, dedicated header, or ?token= for EventSource, which cannot set headers. */
function presentedToken(req: Request): string | null {
  const header = req.headers.get(TOKEN_HEADER);
  if (header?.trim()) return header.trim();

  const authorization = req.headers.get('authorization');
  if (authorization) {
    const match = /^bearer\s+(.+)$/i.exec(authorization.trim());
    if (match?.[1]) return match[1].trim();
  }

  try {
    const query = new URL(req.url).searchParams.get('token');
    if (query?.trim()) return query.trim();
  } catch {
    // Relative or malformed URL: nothing to read, fall through to null.
  }

  return null;
}

function tokenMatches(presented: string): boolean {
  const expected = Buffer.from(getDashboardToken(), 'utf8');
  const actual = Buffer.from(presented, 'utf8');
  // timingSafeEqual throws on length mismatch, which is itself a length oracle,
  // but token length is fixed and public so there is nothing to hide there.
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * Gate for every dashboard/admin route. Returns null to proceed, or the 403 to
 * return as-is.
 */
export function requireLocalOrToken(req: Request): Response | null {
  if (isLocalRequest(req)) return null;

  const presented = presentedToken(req);
  if (presented !== null && tokenMatches(presented)) return null;

  // Setting SWITCHBOARD_ALLOW_REMOTE is the operator saying they have their own
  // front door (a reverse proxy, a tunnel, a private network) and want the
  // dashboard reachable without Switchboard's token.
  if (isRemoteAccessAllowed()) return null;

  return new Response(
    JSON.stringify({
      error: {
        message:
          'Switchboard only serves the dashboard to localhost. Send the dashboard token in ' +
          `the ${TOKEN_HEADER} header, or set SWITCHBOARD_ALLOW_REMOTE=1 if this host is ` +
          'already behind your own authentication.',
        type: 'forbidden',
        code: 'remote_access_denied',
      },
    }),
    { status: 403, headers: { 'content-type': 'application/json' } },
  );
}
