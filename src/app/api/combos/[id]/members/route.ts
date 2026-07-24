import { z } from 'zod';
import { getCombo, setComboMembers } from '@/lib/db/repos/combos';
import { fail, guard, handle, ok, readBody } from '@/lib/api/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  members: z.array(
    z.object({
      connectionId: z.string().min(1),
      modelId: z.string().min(1),
      order: z.number().int().min(0),
      weight: z.number().int().min(1).default(1),
      enabled: z.boolean().default(true),
    }),
  ),
});

type Ctx = { params: Promise<{ id: string }> };

export function PUT(req: Request, ctx: Ctx): Promise<Response> {
  return handle(async () => {
    const denied = guard(req);
    if (denied !== null) return denied;

    const { id } = await ctx.params;
    if (getCombo(id) === null) return fail(404, 'Policy not found.');

    const parsed = await readBody(req, bodySchema);
    if ('error' in parsed) return parsed.error;

    setComboMembers(id, parsed.data.members);
    return ok(getCombo(id));
  });
}
