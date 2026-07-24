import {
  usageByConnection,
  usageByModel,
  usageSeries,
  usageTotals,
} from '@/lib/db/repos/usage';
import { listConnections } from '@/lib/db/repos/connections';
import { snapshotAll } from '@/lib/resilience/breaker';
import { getProvider } from '@/lib/providers/registry';
import { guard, handle, intParam, ok, searchParams } from '@/lib/api/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export function GET(req: Request): Promise<Response> {
  return handle(() => {
    const denied = guard(req);
    if (denied !== null) return denied;

    const days = Math.min(365, Math.max(1, intParam(searchParams(req), 'days', 7)));
    const since = Date.now() - days * DAY;

    const totals = usageTotals(since);
    const byConnection = usageByConnection(since);
    const byModel = usageByModel(since);
    const health = snapshotAll();

    const connections = listConnections();
    const labels = new Map(connections.map((c) => [c.id, c]));

    // Per-day granularity keeps a 90-day view readable; anything finer belongs
    // in the series endpoint where the caller picks the bucket.
    const series = usageSeries(since, days <= 2 ? HOUR : DAY);

    const providers = Object.entries(byConnection)
      .map(([connectionId, rollup]) => {
        const connection = labels.get(connectionId);
        const provider = connection === undefined ? null : getProvider(connection.providerId);
        const snapshot = health[connectionId] ?? null;
        return {
          connectionId,
          label: connection?.label ?? connectionId,
          providerId: connection?.providerId ?? 'unknown',
          providerName: provider?.name ?? 'Unknown',
          accent: provider?.accent ?? '#888888',
          p50LatencyMs: snapshot?.p50LatencyMs ?? null,
          p95LatencyMs: snapshot?.p95LatencyMs ?? null,
          ...rollup,
        };
      })
      .sort((a, b) => b.requests - a.requests);

    const models = byModel
      .map((row) => {
        const connection = labels.get(row.connectionId);
        const provider = connection === undefined ? null : getProvider(connection.providerId);
        return {
          ...row,
          providerId: connection?.providerId ?? 'unknown',
          providerName: provider?.name ?? 'Unknown',
          accent: provider?.accent ?? '#888888',
          costPerRequest: row.requests > 0 ? row.costUsd / row.requests : 0,
        };
      })
      .sort((a, b) => b.costUsd - a.costUsd);

    const successRate = totals.requests > 0 ? totals.successes / totals.requests : 1;

    // Fleet latency is the request-weighted mean of per-connection p50s: a
    // provider serving 90% of traffic should dominate the headline number.
    let weighted = 0;
    let weight = 0;
    for (const p of providers) {
      if (p.p50LatencyMs === null || p.requests === 0) continue;
      weighted += p.p50LatencyMs * p.requests;
      weight += p.requests;
    }

    return ok({
      days,
      since,
      totals: { ...totals, successRate },
      p50LatencyMs: weight > 0 ? Math.round(weighted / weight) : null,
      series,
      providers,
      models: models.slice(0, 25),
    });
  });
}
