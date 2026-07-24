import { snapshotAll } from '@/lib/resilience/breaker';
import { listConnections } from '@/lib/db/repos/connections';
import { listLockouts } from '@/lib/db/repos/health';
import { getProvider } from '@/lib/providers/registry';
import { guard, handle, ok } from '@/lib/api/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(req: Request): Promise<Response> {
  return handle(() => {
    const denied = guard(req);
    if (denied !== null) return denied;

    const health = snapshotAll();

    const items = listConnections().map((connection) => {
      const provider = getProvider(connection.providerId);
      return {
        connectionId: connection.id,
        label: connection.label,
        providerId: connection.providerId,
        providerName: provider?.name ?? connection.providerId,
        accent: provider?.accent ?? '#888888',
        enabled: connection.enabled,
        health: health[connection.id] ?? null,
      };
    });

    const statuses = items
      .filter((item) => item.enabled && item.health !== null)
      .map((item) => item.health!.status);

    const overall =
      statuses.length === 0
        ? 'unknown'
        : statuses.every((s) => s === 'healthy')
          ? 'operational'
          : statuses.some((s) => s === 'healthy')
            ? 'degraded'
            : 'outage';

    return ok({ overall, items, lockouts: listLockouts() });
  });
}
