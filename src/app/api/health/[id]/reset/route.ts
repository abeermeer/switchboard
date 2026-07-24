import { resetBreaker, snapshot } from '@/lib/resilience/breaker';
import { getConnection } from '@/lib/db/repos/connections';
import { fail, guard, handle, ok } from '@/lib/api/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export function POST(req: Request, ctx: Ctx): Promise<Response> {
  return handle(async () => {
    const denied = guard(req);
    if (denied !== null) return denied;

    const { id } = await ctx.params;
    if (getConnection(id) === null) return fail(404, 'Connection not found.');

    resetBreaker(id);
    return ok({ reset: true, health: snapshot(id) });
  });
}
