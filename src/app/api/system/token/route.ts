import { getDashboardToken, rotateDashboardToken } from '@/lib/auth/session';
import { localOnlyGate } from '@/lib/auth/access';
import { handle, ok } from '@/lib/api/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The dashboard token, for `sb token`.
 *
 * Remote access has always accepted a token, but nothing ever showed it to the
 * user, so the only working way in was SWITCHBOARD_ALLOW_REMOTE with no auth at
 * all. Only a shell on this machine may read or reset it: holding the old token
 * must not be a way to learn the new one.
 */
export function GET(req: Request): Promise<Response> {
  return handle(() => {
    const denied = localOnlyGate(req);
    if (denied !== null) return denied;
    return ok({ token: getDashboardToken() });
  });
}

/** Rotates the token, signing out every browser that holds the old one. */
export function POST(req: Request): Promise<Response> {
  return handle(() => {
    const denied = localOnlyGate(req);
    if (denied !== null) return denied;
    return ok({ token: rotateDashboardToken() });
  });
}
