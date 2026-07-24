import { z } from 'zod';
import { createCombo, listCombos } from '@/lib/db/repos/combos';
import { guard, handle, ok, readBody, fail } from '@/lib/api/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const memberSchema = z.object({
  connectionId: z.string().min(1),
  modelId: z.string().min(1),
  order: z.number().int().min(0),
  weight: z.number().int().min(1).default(1),
  enabled: z.boolean().default(true),
});

const createSchema = z.object({
  slug: z
    .string()
    .min(1)
    .max(48)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'slug must be lowercase letters, numbers and dashes'),
  name: z.string().min(1).max(80),
  description: z.string().max(400).optional(),
  modality: z
    .enum(['chat', 'embeddings', 'images', 'audio.speech', 'audio.transcription', 'rerank', 'moderation'])
    .optional(),
  strategy: z
    .enum(['free-first', 'cost-optimized', 'fastest', 'quality-first', 'priority', 'round-robin', 'failover'])
    .optional(),
  requires: z.array(z.enum(['tools', 'vision', 'json_mode', 'reasoning', 'streaming', 'prefill'])).optional(),
  maxCostPerMTok: z.number().min(0).nullable().optional(),
  maxAttempts: z.number().int().min(1).max(10).optional(),
  timeoutMs: z.number().int().min(1_000).max(900_000).optional(),
  members: z.array(memberSchema).optional(),
});

export function GET(req: Request): Promise<Response> {
  return handle(() => {
    const denied = guard(req);
    if (denied !== null) return denied;
    return ok({ items: listCombos() });
  });
}

export function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const denied = guard(req);
    if (denied !== null) return denied;

    const parsed = await readBody(req, createSchema);
    if ('error' in parsed) return parsed.error;

    try {
      return ok(createCombo(parsed.data), 201);
    } catch (err) {
      // The repo throws on a duplicate slug; that is a client error, not a 500.
      return fail(409, err instanceof Error ? err.message : 'Could not create policy.');
    }
  });
}
