import { z } from 'zod';
import { deleteCombo, getCombo, updateCombo } from '@/lib/db/repos/combos';
import { fail, guard, handle, ok, readBody } from '@/lib/api/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const patchSchema = z.object({
  slug: z
    .string()
    .min(1)
    .max(48)
    .regex(/^[a-z0-9][a-z0-9-]*$/)
    .optional(),
  name: z.string().min(1).max(80).optional(),
  description: z.string().max(400).optional(),
  strategy: z
    .enum(['free-first', 'cost-optimized', 'fastest', 'quality-first', 'priority', 'round-robin', 'failover'])
    .optional(),
  modality: z
    .enum(['chat', 'embeddings', 'images', 'audio.speech', 'audio.transcription', 'rerank', 'moderation'])
    .optional(),
  requires: z.array(z.enum(['tools', 'vision', 'json_mode', 'reasoning', 'streaming', 'prefill'])).optional(),
  maxCostPerMTok: z.number().min(0).nullable().optional(),
  maxAttempts: z.number().int().min(1).max(10).optional(),
  timeoutMs: z.number().int().min(1_000).max(900_000).optional(),
  enabled: z.boolean().optional(),
  isDefault: z.boolean().optional(),
});

type Ctx = { params: Promise<{ id: string }> };

export function GET(req: Request, ctx: Ctx): Promise<Response> {
  return handle(async () => {
    const denied = guard(req);
    if (denied !== null) return denied;

    const { id } = await ctx.params;
    const combo = getCombo(id);
    if (combo === null) return fail(404, 'Policy not found.');
    return ok(combo);
  });
}

export function PATCH(req: Request, ctx: Ctx): Promise<Response> {
  return handle(async () => {
    const denied = guard(req);
    if (denied !== null) return denied;

    const { id } = await ctx.params;
    const parsed = await readBody(req, patchSchema);
    if ('error' in parsed) return parsed.error;

    const updated = updateCombo(id, parsed.data);
    if (updated === null) return fail(404, 'Policy not found.');
    return ok(updated);
  });
}

export function DELETE(req: Request, ctx: Ctx): Promise<Response> {
  return handle(async () => {
    const denied = guard(req);
    if (denied !== null) return denied;

    const { id } = await ctx.params;
    if (!deleteCombo(id)) return fail(404, 'Policy not found.');
    return ok({ deleted: true });
  });
}
