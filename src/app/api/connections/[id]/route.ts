import { z } from 'zod';
import { deleteConnection, getConnection, updateConnection } from '@/lib/db/repos/connections';
import { buildConnectionViews } from '@/lib/router';
import { fail, guard, handle, ok, readBody } from '@/lib/api/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const patchSchema = z.object({
  label: z.string().min(1).max(80).optional(),
  enabled: z.boolean().optional(),
  priority: z.number().int().min(0).max(999).optional(),
  baseUrlOverride: z.string().url().nullable().optional(),
  monthlyBudgetUsd: z.number().min(0).nullable().optional(),
  tierOverride: z.enum(['free', 'cheap', 'standard', 'premium']).nullable().optional(),
});

type Ctx = { params: Promise<{ id: string }> };

export function GET(req: Request, ctx: Ctx): Promise<Response> {
  return handle(async () => {
    const denied = guard(req);
    if (denied !== null) return denied;

    const { id } = await ctx.params;
    const view = buildConnectionViews().find((v) => v.id === id);
    if (view === undefined) return fail(404, 'Connection not found.');
    return ok(view);
  });
}

export function PATCH(req: Request, ctx: Ctx): Promise<Response> {
  return handle(async () => {
    const denied = guard(req);
    if (denied !== null) return denied;

    const { id } = await ctx.params;
    if (getConnection(id) === null) return fail(404, 'Connection not found.');

    const parsed = await readBody(req, patchSchema);
    if ('error' in parsed) return parsed.error;

    const updated = updateConnection(id, parsed.data);
    if (updated === null) return fail(404, 'Connection not found.');
    return ok(updated);
  });
}

export function DELETE(req: Request, ctx: Ctx): Promise<Response> {
  return handle(async () => {
    const denied = guard(req);
    if (denied !== null) return denied;

    const { id } = await ctx.params;
    if (!deleteConnection(id)) return fail(404, 'Connection not found.');
    return ok({ deleted: true });
  });
}
