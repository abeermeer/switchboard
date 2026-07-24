import { getRequestLog } from '@/lib/db/repos/log';
import { fail, guard, handle, ok } from '@/lib/api/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export function GET(req: Request, ctx: Ctx): Promise<Response> {
  return handle(async () => {
    const denied = guard(req);
    if (denied !== null) return denied;

    const { id } = await ctx.params;
    const detail = getRequestLog(id);
    if (detail === null) return fail(404, 'Request not found.');

    return ok(detail);
  });
}
