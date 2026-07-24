import { z } from 'zod';
import { requireLocalOrToken } from '@/lib/auth/session';

/** Shared plumbing for the management API, so each handler stays declarative. */

export function guard(req: Request): Response | null {
  return requireLocalOrToken(req);
}

export function ok<T>(data: T, status = 200): Response {
  return Response.json(data as unknown as Record<string, unknown>, { status });
}

export function fail(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

/**
 * Parses and validates a JSON body. Returns a Response on failure so callers
 * can `if ('error' in parsed) return parsed.error`.
 */
export async function readBody<T>(
  req: Request,
  schema: z.ZodType<T>,
): Promise<{ data: T } | { error: Response }> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return { error: fail(400, 'Request body must be valid JSON.') };
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue === undefined ? '' : issue.path.join('.');
    const message =
      issue === undefined
        ? 'Invalid request body.'
        : path.length > 0
          ? `${path}: ${issue.message}`
          : issue.message;
    return { error: fail(400, message) };
  }

  return { data: parsed.data };
}

/**
 * Wraps a handler so an unexpected throw becomes a clean 500 instead of a
 * stack trace on the wire. The detail still reaches the server console, which
 * is where the operator can actually act on it.
 */
export async function handle(fn: () => Promise<Response> | Response): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    console.error('[switchboard] management API error:', err);
    const message = err instanceof Error ? err.message : 'Unexpected server error.';
    return fail(500, message);
  }
}

export function searchParams(req: Request): URLSearchParams {
  return new URL(req.url).searchParams;
}

export function intParam(params: URLSearchParams, key: string, fallback: number): number {
  const raw = params.get(key);
  if (raw === null) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}
