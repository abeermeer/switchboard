import { z } from 'zod';
import { createApiKey, listApiKeys } from '@/lib/db/repos/apiKeys';
import { monthToDateCostForApiKey } from '@/lib/db/repos/usage';
import { guard, handle, ok, readBody } from '@/lib/api/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const createSchema = z.object({
  name: z.string().min(1).max(80),
  allowedCombos: z.array(z.string()).optional(),
  monthlyBudgetUsd: z.number().min(0).nullable().optional(),
  onBudgetExceeded: z.enum(['block', 'downgrade-to-free']).optional(),
  rateLimitPerMin: z.number().int().min(1).max(100_000).nullable().optional(),
  expiresAt: z.number().int().nullable().optional(),
});

export function GET(req: Request): Promise<Response> {
  return handle(() => {
    const denied = guard(req);
    if (denied !== null) return denied;

    return ok({
      items: listApiKeys().map((key) => ({
        ...key,
        spentThisMonthUsd: monthToDateCostForApiKey(key.id),
      })),
    });
  });
}

export function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const denied = guard(req);
    if (denied !== null) return denied;

    const parsed = await readBody(req, createSchema);
    if ('error' in parsed) return parsed.error;

    const { key, secret } = createApiKey(parsed.data);
    // The only time the plaintext exists outside the client's hands. The
    // database stores a hash, so this cannot be recovered later.
    return ok({ key, secret }, 201);
  });
}
