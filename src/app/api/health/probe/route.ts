import { probeAll, probeConnection } from '@/lib/health/probe';
import { getConnection } from '@/lib/db/repos/connections';
import { fail, guard, handle, ok, searchParams } from '@/lib/api/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const denied = guard(req);
    if (denied !== null) return denied;

    const id = searchParams(req).get('id');

    if (id !== null) {
      if (getConnection(id) === null) return fail(404, 'Connection not found.');
      return ok({ results: { [id]: await probeConnection(id) } });
    }

    return ok({ results: await probeAll() });
  });
}
