import { z } from 'zod';
import { deleteApiKey, updateApiKey } from '@/lib/db/repos/apiKeys';
import { fail, guard, handle, ok, readBody } from '@/lib/api/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const patchSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  allowedCombos: z.array(z.string()).optional(),
  monthlyBudgetUsd: z.number().min(0).nullable().optional(),
  onBudgetExceeded: z.enum(['block', 'downgrade-to-free']).optional(),
  rateLimitPerMin: z.number().int().min(1).max(100_000).nullable().optional(),
  enabled: z.boolean().optional(),
  expiresAt: z.number().int().nullable().optional(),
});

type Ctx = { params: Promise<{ id: string }> };

export function PATCH(req: Request, ctx: Ctx): Promise<Response> {
  return handle(async () => {
    const denied = guard(req);
    if (denied !== null) return denied;

    const { id } = await ctx.params;
    const parsed = await readBody(req, patchSchema);
    if ('error' in parsed) return parsed.error;

    const updated = updateApiKey(id, parsed.data);
    if (updated === null) return fail(404, 'API key not found.');
    return ok(updated);
  });
}

export function DELETE(req: Request, ctx: Ctx): Promise<Response> {
  return handle(async () => {
    const denied = guard(req);
    if (denied !== null) return denied;

    const { id } = await ctx.params;
    if (!deleteApiKey(id)) return fail(404, 'API key not found.');
    return ok({ deleted: true });
  });
}
