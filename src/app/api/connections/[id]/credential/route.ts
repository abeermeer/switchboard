import { z } from 'zod';
import { getConnection } from '@/lib/db/repos/connections';
import { deleteCredential, getCredentialHint, setCredential } from '@/lib/db/repos/credentials';
import { fail, guard, handle, ok, readBody } from '@/lib/api/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const putSchema = z.object({ apiKey: z.string().min(1, 'apiKey is required') });

type Ctx = { params: Promise<{ id: string }> };

export function PUT(req: Request, ctx: Ctx): Promise<Response> {
  return handle(async () => {
    const denied = guard(req);
    if (denied !== null) return denied;

    const { id } = await ctx.params;
    if (getConnection(id) === null) return fail(404, 'Connection not found.');

    const parsed = await readBody(req, putSchema);
    if ('error' in parsed) return parsed.error;

    setCredential(id, parsed.data.apiKey.trim());
    // Only the hint ever leaves the server — the plaintext is sealed at rest
    // and there is no endpoint that returns it.
    return ok({ saved: true, hint: getCredentialHint(id) });
  });
}

export function DELETE(req: Request, ctx: Ctx): Promise<Response> {
  return handle(async () => {
    const denied = guard(req);
    if (denied !== null) return denied;

    const { id } = await ctx.params;
    deleteCredential(id);
    return ok({ deleted: true });
  });
}
