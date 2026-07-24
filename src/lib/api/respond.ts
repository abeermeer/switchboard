import type { ApiKey } from '@/types/core';
import { listApiKeys, touchApiKey, verifyApiKey } from '@/lib/db/repos/apiKeys';
import { checkRateLimit } from '@/lib/auth/rateLimit';

export const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type, x-api-key, openai-organization',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-max-age': '86400',
};

/** The OpenAI error envelope, byte for byte — clients parse this shape. */
export function jsonError(
  status: number,
  message: string,
  type = 'invalid_request_error',
  code: string | null = null,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(
    JSON.stringify({ error: { message, type, param: null, code } }),
    {
      status,
      headers: { 'content-type': 'application/json', ...CORS_HEADERS, ...extraHeaders },
    },
  );
}

export function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export interface AuthResult {
  key: ApiKey | null;
  error: Response | null;
}

function bearer(req: Request): string | null {
  const header = req.headers.get('authorization');
  if (header !== null && header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim();
  }
  // Anthropic-style clients send the credential in x-api-key instead.
  const alt = req.headers.get('x-api-key');
  return alt === null || alt.length === 0 ? null : alt;
}

/**
 * Authenticates a gateway request.
 *
 * When no API key has been created yet the gateway runs open. A fresh local
 * install has to be usable the moment it boots — requiring a key before the
 * first request would mean the user cannot test anything until they have
 * visited the dashboard, which defeats the point of a local tool.
 */
export function authenticate(req: Request): AuthResult {
  const secret = bearer(req);
  const configured = listApiKeys();

  if (configured.length === 0) return { key: null, error: null };

  if (secret === null) {
    return {
      key: null,
      error: jsonError(
        401,
        'Missing API key. Pass it as "Authorization: Bearer sb-live-...".',
        'authentication_error',
        'missing_api_key',
      ),
    };
  }

  const key = verifyApiKey(secret);
  if (key === null) {
    return {
      key: null,
      error: jsonError(401, 'Invalid API key.', 'authentication_error', 'invalid_api_key'),
    };
  }

  const limit = checkRateLimit(key.id, key.rateLimitPerMin);
  if (!limit.allowed) {
    return {
      key,
      error: jsonError(
        429,
        `Rate limit of ${key.rateLimitPerMin}/min exceeded for this key.`,
        'rate_limit_error',
        'rate_limit_exceeded',
        { 'retry-after': String(limit.retryAfterSec) },
      ),
    };
  }

  touchApiKey(key.id);
  return { key, error: null };
}

export function clientMeta(req: Request): { ip: string | null; userAgent: string | null } {
  const forwarded = req.headers.get('x-forwarded-for');
  const ip = forwarded === null ? null : (forwarded.split(',')[0]?.trim() ?? null);
  return { ip, userAgent: req.headers.get('user-agent') };
}

/** Maps a normalized adapter failure onto the HTTP status a client expects. */
export function statusForErrorKind(kind: string): number {
  switch (kind) {
    case 'auth':
      return 401;
    case 'rate_limit':
      return 429;
    case 'quota_exceeded':
      return 429;
    case 'context_length':
    case 'bad_request':
      return 400;
    case 'unsupported':
      return 404;
    case 'timeout':
      return 504;
    default:
      return 502;
  }
}

export function typeForErrorKind(kind: string): string {
  switch (kind) {
    case 'auth':
      return 'authentication_error';
    case 'rate_limit':
    case 'quota_exceeded':
      return 'rate_limit_error';
    case 'bad_request':
    case 'context_length':
      return 'invalid_request_error';
    default:
      return 'api_error';
  }
}
