import type { ApiKey } from '@/types/core';
import { listApiKeys, touchApiKey, verifyApiKey } from '@/lib/db/repos/apiKeys';
import { getComboBySlug } from '@/lib/db/repos/combos';
import { checkRateLimit } from '@/lib/auth/rateLimit';
import { allowedOrigins, gatewayOriginAllowed, hostAllowed, mayRunOpen } from '@/lib/auth/access';
import { clientAddress } from '@/lib/auth/session';

const CORS_BASE: Record<string, string> = {
  'access-control-allow-headers': 'authorization, content-type, x-api-key, openai-organization',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-max-age': '86400',
};

/**
 * Reflects the caller's origin when it is allowed, rather than echoing `*`.
 * Reflection is required for a credentialed request and is what lets several
 * distinct origins be permitted without widening the policy to everyone.
 */
export function corsHeaders(req?: Request): Record<string, string> {
  const allowed = allowedOrigins();
  if (allowed.length === 0) return { ...CORS_BASE };

  if (allowed.includes('*')) {
    return { ...CORS_BASE, 'access-control-allow-origin': '*' };
  }

  const origin = req?.headers.get('origin')?.replace(/\/$/, '');
  if (origin !== undefined && origin !== null && allowed.includes(origin)) {
    return {
      ...CORS_BASE,
      'access-control-allow-origin': origin,
      // Without this a shared cache could hand one origin's response to
      // another, defeating the allowlist.
      vary: 'Origin',
    };
  }

  return { ...CORS_BASE, vary: 'Origin' };
}

/**
 * Static header set for paths that do not have the request in hand.
 * Prefer `corsHeaders(req)`; this exists so older call sites keep compiling.
 */
export const CORS_HEADERS: Record<string, string> = CORS_BASE;

/**
 * The OpenAI error envelope, byte for byte — clients parse this shape.
 *
 * `req` is optional but worth passing: without it an allowed browser origin
 * gets the error status but cannot read the body explaining it, because the
 * response carries no `Access-Control-Allow-Origin`.
 */
export function jsonError(
  status: number,
  message: string,
  type = 'invalid_request_error',
  code: string | null = null,
  extraHeaders: Record<string, string> = {},
  req?: Request,
): Response {
  return new Response(
    JSON.stringify({ error: { message, type, param: null, code } }),
    {
      status,
      headers: { 'content-type': 'application/json', ...corsHeaders(req), ...extraHeaders },
    },
  );
}

export function preflight(req?: Request): Response {
  return new Response(null, { status: 204, headers: corsHeaders(req) });
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
 * When no API key has been created yet the gateway runs open, for this
 * machine only. A fresh local install has to be usable the moment it boots;
 * requiring a key before the first request would mean the user cannot test
 * anything until they have visited the dashboard, which defeats the point of a
 * local tool. That reasoning covers a shell on this machine, not every device
 * on the network, so a remote caller needs a key unless the operator has set
 * SWITCHBOARD_ALLOW_REMOTE to say their own front door handles it.
 */
export function authenticate(req: Request): AuthResult {
  if (!hostAllowed(req)) {
    return {
      key: null,
      error: jsonError(
        403,
        'This Host is not one Switchboard answers to. Use localhost or an IP address, or list ' +
          'the name in SWITCHBOARD_ALLOWED_HOSTS.',
        'permission_error',
        'host_not_allowed',
      ),
    };
  }

  if (!gatewayOriginAllowed(req)) {
    return {
      key: null,
      error: jsonError(
        403,
        'Browser requests from this origin are not allowed. Add it to SWITCHBOARD_CORS_ORIGINS ' +
          'to permit it.',
        'permission_error',
        'origin_not_allowed',
      ),
    };
  }

  const secret = bearer(req);
  const configured = listApiKeys();

  if (configured.length === 0) {
    if (mayRunOpen(req)) return { key: null, error: null };
    return {
      key: null,
      error: jsonError(
        401,
        'No API key exists yet, so the gateway only answers this machine. Create one with ' +
          '`sb keys new <name>` and send it as "Authorization: Bearer sb-live-...".',
        'authentication_error',
        'missing_api_key',
        {},
        req,
      ),
    };
  }

  if (secret === null) {
    return {
      key: null,
      error: jsonError(
        401,
        'Missing API key. Pass it as "Authorization: Bearer sb-live-...".',
        'authentication_error',
        'missing_api_key',
        {},
        req,
      ),
    };
  }

  const key = verifyApiKey(secret);
  if (key === null) {
    return {
      key: null,
      error: jsonError(401, 'Invalid API key.', 'authentication_error', 'invalid_api_key', {}, req),
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
        req,
      ),
    };
  }

  touchApiKey(key.id);
  return { key, error: null };
}

/**
 * A key limited to named policies may only ask for those policies.
 *
 * The dashboard has offered "Allowed policies" since the first release and
 * stored it on every key, but nothing ever read it, so a key restricted to
 * `free-only` could still request `quality` or name a paid model directly.
 * The rule is exact: anything other than an allowed slug (a bare model id, a
 * provider pin, another policy) is refused, because each of those would
 * route around the restriction.
 */
export function policyDenied(key: ApiKey | null, requestedModel: string, req?: Request): Response | null {
  if (key === null || key.allowedCombos.length === 0) return null;
  if (!key.allowedCombos.includes(requestedModel)) {
    return jsonError(
      403,
      `This API key may only use: ${key.allowedCombos.join(', ')}. "${requestedModel}" is not one of them.`,
      'permission_error',
      'model_not_allowed',
      {},
      req,
    );
  }

  // The slug has to still name an enabled policy. Once a policy is disabled,
  // deleted or renamed, its old slug no longer matches anything and the router
  // treats it as an unknown model, served by the default policy with no cost
  // ceiling. That turned a key restricted to free-only into an unrestricted
  // one with a single click in the dashboard.
  const combo = getComboBySlug(requestedModel);
  if (combo === null || !combo.enabled) {
    return jsonError(
      403,
      `The policy "${requestedModel}" this key is limited to is disabled or no longer exists. ` +
        'Re-enable it, or edit the key to allow another policy.',
      'permission_error',
      'policy_unavailable',
      {},
      req,
    );
  }
  return null;
}

export function clientMeta(req: Request): { ip: string | null; userAgent: string | null } {
  return { ip: clientAddress(req), userAgent: req.headers.get('user-agent') };
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
    case 'unavailable':
      // 503, not 404: the model exists and will be served once a breaker
      // closes or a lockout lapses, and SDKs retry a 503 on their own.
      return 503;
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
