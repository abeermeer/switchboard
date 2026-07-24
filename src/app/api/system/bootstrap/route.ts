import { ensureMasterKey } from '@/lib/crypto/vault';
import { ensureSeedCombos } from '@/lib/db/repos/combos';
import { listConnections } from '@/lib/db/repos/connections';
import { listApiKeys } from '@/lib/db/repos/apiKeys';
import { guard, handle, ok } from '@/lib/api/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Idempotent first-run setup. Safe to call on every dashboard load. */
export function POST(req: Request): Promise<Response> {
  return handle(() => {
    const denied = guard(req);
    if (denied !== null) return denied;

    ensureMasterKey();
    ensureSeedCombos();

    const connections = listConnections();
    const keys = listApiKeys();

    return ok({
      ready: true,
      hasConnections: connections.length > 0,
      hasKeys: keys.length > 0,
    });
  });
}
