import { z } from 'zod';
import { getSettings, updateSettings } from '@/lib/db/repos/settings';
import { guard, handle, ok, readBody } from '@/lib/api/admin';
import { startHealthScheduler } from '@/lib/health/probe';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const patchSchema = z.object({
  defaultCombo: z.string().min(1).optional(),
  preferFreeTiers: z.boolean().optional(),
  logPayloads: z.boolean().optional(),
  logRetentionDays: z.number().int().min(0).max(3650).optional(),
  healthProbeIntervalSec: z.number().int().min(0).max(86_400).optional(),
  breakerFailureThreshold: z.number().int().min(1).max(50).optional(),
  breakerCooldownMs: z.number().int().min(1_000).max(3_600_000).optional(),
  defaultTimeoutMs: z.number().int().min(1_000).max(900_000).optional(),
  theme: z.enum(['light', 'dark', 'system']).optional(),
});

export function GET(req: Request): Promise<Response> {
  return handle(() => {
    const denied = guard(req);
    if (denied !== null) return denied;
    return ok(getSettings());
  });
}

export function PATCH(req: Request): Promise<Response> {
  return handle(async () => {
    const denied = guard(req);
    if (denied !== null) return denied;

    const parsed = await readBody(req, patchSchema);
    if ('error' in parsed) return parsed.error;

    const updated = updateSettings(parsed.data);
    // Picks up a changed probe interval immediately; 0 stops the loop. An
    // unchanged interval is a no-op.
    if (parsed.data.healthProbeIntervalSec !== undefined) startHealthScheduler();
    return ok(updated);
  });
}
