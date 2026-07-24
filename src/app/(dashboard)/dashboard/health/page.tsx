import { listConnections } from '@/lib/db/repos/connections';
import { listLockouts } from '@/lib/db/repos/health';
import { usageSeries } from '@/lib/db/repos/usage';
import { snapshotAll } from '@/lib/resilience/breaker';
import { getProvider } from '@/lib/providers/registry';
import { EmptyState } from '@/components/ui';
import { HealthBoard } from '@/components/requests/HealthBoard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CELL_MS = 15 * 60 * 1000;
const CELLS = 96;

export default function HealthPage(): React.ReactElement {
  const connections = listConnections();
  const health = snapshotAll();

  const items = connections.map((connection) => {
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

  // Usage buckets are hourly, so each hour paints the four cells it covers.
  // Coarser than a true 15-minute strip, but honest about what was recorded.
  const since = Date.now() - CELLS * CELL_MS;
  const buckets = usageSeries(since, 60 * 60 * 1000);

  const uptime: Record<string, Array<number | null>> = {};
  for (const connection of connections) {
    const cells: Array<number | null> = new Array<number | null>(CELLS).fill(null);
    for (const bucket of buckets) {
      if (bucket.requests === 0) continue;
      const rate = bucket.successes / bucket.requests;
      const start = Math.floor((bucket.ts - since) / CELL_MS);
      for (let offset = 0; offset < 4; offset += 1) {
        const index = start + offset;
        if (index >= 0 && index < CELLS) cells[index] = rate;
      }
    }
    uptime[connection.id] = cells;
  }

  if (items.length === 0) {
    return (
      <EmptyState
        title="No providers to monitor"
        description="Connect a provider and its health, latency and circuit state appear here."
      />
    );
  }

  return <HealthBoard items={items} lockouts={listLockouts()} uptime={uptime} />;
}
