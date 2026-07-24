import { statSync } from 'node:fs';
import { dataDir, dbPath } from '@/lib/db/client';
import { buildConnectionViews } from '@/lib/router';
import { usageTotals } from '@/lib/db/repos/usage';
import { listApiKeys } from '@/lib/db/repos/apiKeys';
import { listCombos } from '@/lib/db/repos/combos';
import { guard, handle, ok } from '@/lib/api/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BOOTED_AT = Date.now();

export function GET(req: Request): Promise<Response> {
  return handle(() => {
    const denied = guard(req);
    if (denied !== null) return denied;

    const views = buildConnectionViews();
    const counts = { healthy: 0, degraded: 0, down: 0, unconfigured: 0, disabled: 0 };
    for (const view of views) counts[view.status] += 1;

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const today = usageTotals(startOfDay.getTime());

    let dbSizeBytes = 0;
    try {
      dbSizeBytes = statSync(dbPath()).size;
    } catch {
      // The database file does not exist until the first write.
    }

    return ok({
      version: '0.1.0',
      uptimeMs: Date.now() - BOOTED_AT,
      port: Number(process.env.PORT ?? 7272),
      dataDir: dataDir(),
      dbSizeBytes,
      packaged: process.env.SWITCHBOARD_PACKAGED === '1',
      connections: { total: views.length, ...counts },
      combos: listCombos().length,
      apiKeys: listApiKeys().length,
      today,
    });
  });
}
