import { z } from 'zod';
import { createConnection } from '@/lib/db/repos/connections';
import { setCredential } from '@/lib/db/repos/credentials';
import { getProvider } from '@/lib/providers/registry';
import { buildConnectionViews } from '@/lib/router';
import { fail, guard, handle, ok, readBody } from '@/lib/api/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const createSchema = z.object({
  providerId: z.string().min(1),
  label: z.string().min(1).max(80).optional(),
  apiKey: z.string().min(1).optional(),
  priority: z.number().int().min(0).max(999).optional(),
  baseUrlOverride: z.string().url().nullable().optional(),
  monthlyBudgetUsd: z.number().min(0).nullable().optional(),
  tierOverride: z.enum(['free', 'cheap', 'standard', 'premium']).nullable().optional(),
});

export function GET(req: Request): Promise<Response> {
  return handle(() => {
    const denied = guard(req);
    if (denied !== null) return denied;
    return ok({ items: buildConnectionViews() });
  });
}

export function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const denied = guard(req);
    if (denied !== null) return denied;

    const parsed = await readBody(req, createSchema);
    if ('error' in parsed) return parsed.error;

    const provider = getProvider(parsed.data.providerId);
    if (provider === null) return fail(404, `Unknown provider: ${parsed.data.providerId}`);

    const connection = createConnection({
      providerId: parsed.data.providerId,
      label: parsed.data.label,
      priority: parsed.data.priority,
      baseUrlOverride: parsed.data.baseUrlOverride ?? null,
      monthlyBudgetUsd: parsed.data.monthlyBudgetUsd ?? null,
      tierOverride: parsed.data.tierOverride ?? null,
    });

    if (parsed.data.apiKey !== undefined) {
      setCredential(connection.id, parsed.data.apiKey);
    }

    return ok(connection, 201);
  });
}
