import Link from 'next/link';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { ensureSeedCombos } from '@/lib/db/repos/combos';
import { ensureMasterKey } from '@/lib/crypto/vault';
import { usageSeries, usageTotals } from '@/lib/db/repos/usage';
import { listLockouts } from '@/lib/db/repos/health';
import { buildConnectionViews } from '@/lib/router';
import { listProviders } from '@/lib/providers/registry';
import { formatCompact, formatMs, formatPercent, formatUsd } from '@/lib/utils';
import { Badge, Stat } from '@/components/ui';
import { FirstRun } from '@/components/overview/FirstRun';
import { LiveFeed } from '@/components/overview/LiveFeed';
import { ProviderSpectrum } from '@/components/overview/ProviderSpectrum';
import { TrafficChart } from '@/components/overview/TrafficChart';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export default function OverviewPage(): React.ReactElement {
  // First render of a fresh install does the one-time setup, so the dashboard
  // is never looking at a database without its seed policies.
  ensureMasterKey();
  ensureSeedCombos();

  const views = buildConnectionViews();

  if (views.length === 0) {
    const free = listProviders()
      .filter((p) => p.freeTier !== null && p.requiresKey)
      .map((p) => p.name);
    return <FirstRun freeProviders={free} />;
  }

  const since = Date.now() - DAY;
  const totals = usageTotals(since);
  const series = usageSeries(since, HOUR);

  const requestSeries = series.map((b) => b.requests);
  const costSeries = series.map((b) => b.costUsd);
  const savedSeries = series.map((b) => b.savedUsd);

  const healthy = views.filter((v) => v.status === 'healthy').length;
  const freeRequests = views
    .filter((v) => v.tier === 'free')
    .reduce((sum, v) => sum + v.usage.requests, 0);
  const freeShare = totals.requests > 0 ? freeRequests / totals.requests : 0;

  const latencies = views
    .map((v) => v.health.p50LatencyMs)
    .filter((v): v is number => v !== null);
  const medianLatency =
    latencies.length === 0
      ? null
      : latencies.sort((a, b) => a - b)[Math.floor(latencies.length / 2)] ?? null;

  const accents = Object.fromEntries(listProviders().map((p) => [p.id, p.accent]));

  const spectrum = views.map((view) => ({
    connectionId: view.id,
    label: view.label,
    providerName: view.provider.name,
    accent: view.provider.accent,
    requests: view.usage.requests,
    costUsd: view.usage.costUsd,
    p50LatencyMs: view.health.p50LatencyMs,
    status: view.status,
  }));

  const attention = [
    ...views
      .filter((v) => v.health.breaker === 'open')
      .map((v) => ({
        key: `breaker-${v.id}`,
        tone: 'down' as const,
        text: `${v.label} — circuit breaker open`,
        detail: v.health.lastError ?? 'Repeated upstream failures',
        href: `/dashboard/providers/${v.id}`,
      })),
    ...views
      .filter((v) => v.status === 'unconfigured' && v.enabled)
      .map((v) => ({
        key: `nokey-${v.id}`,
        tone: 'warn' as const,
        text: `${v.label} — no API key`,
        detail: 'This connection is enabled but cannot serve traffic',
        href: `/dashboard/providers/${v.id}`,
      })),
    ...listLockouts().map((lock) => ({
      key: `lock-${lock.connectionId}-${lock.modelId}`,
      tone: 'warn' as const,
      text: `${lock.modelId} — rate limited`,
      detail: lock.reason,
      href: '/dashboard/health',
    })),
  ];

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Requests (24h)"
          value={formatCompact(totals.requests)}
          hint={`${formatPercent(totals.requests > 0 ? totals.successes / totals.requests : 1, 1)} succeeded`}
          series={requestSeries}
          tone="info"
        />
        <Stat
          label="Spend (24h)"
          value={formatUsd(totals.costUsd)}
          hint={`${formatCompact(totals.promptTokens + totals.completionTokens)} tokens`}
          series={costSeries}
          tone="muted"
        />
        <Stat
          label="Saved vs. premium"
          value={formatUsd(totals.savedUsd)}
          hint="What this traffic would have cost at frontier prices"
          series={savedSeries}
          tone="ok"
        />
        <Stat
          label="Median latency"
          value={formatMs(medianLatency)}
          hint="Time to first token, across healthy providers"
          tone="muted"
        />
      </div>

      <p className="text-xs text-muted">
        <span className="font-medium text-ink">{views.length}</span> provider
        {views.length === 1 ? '' : 's'} configured,{' '}
        <span className="font-medium text-ink">{healthy}</span> healthy
        {totals.requests > 0 && (
          <>
            , routing{' '}
            <span className="font-medium text-accent">{formatPercent(freeShare, 0)}</span> of traffic
            to free tiers
          </>
        )}
        .
      </p>

      <div className="grid gap-4 xl:grid-cols-3">
        <div className="xl:col-span-2">
          <TrafficChart />
        </div>
        <LiveFeed accents={accents} />
      </div>

      <div className="rounded-sb border border-line bg-surface p-4">
        <div className="mb-3">
          <h3 className="text-sm font-semibold text-ink">Provider spectrum</h3>
          <p className="mt-0.5 text-xs text-muted">
            Share of the last 24 hours of traffic, by connection
          </p>
        </div>
        <ProviderSpectrum segments={spectrum} />
      </div>

      <div className="rounded-sb border border-line bg-surface p-4">
        <h3 className="mb-3 text-sm font-semibold text-ink">Needs attention</h3>
        {attention.length === 0 ? (
          <p className="flex items-center gap-2 text-xs text-muted">
            <CheckCircle2 size={14} className="text-ok" />
            All systems nominal — no open breakers, missing keys or rate limits.
          </p>
        ) : (
          <ul className="space-y-2">
            {attention.map((item) => (
              <li key={item.key}>
                <Link
                  href={item.href}
                  className="flex items-start gap-2.5 rounded-sb border border-line px-3 py-2 transition-colors hover:bg-surface-2"
                >
                  <AlertTriangle
                    size={14}
                    className={item.tone === 'down' ? 'mt-0.5 text-down' : 'mt-0.5 text-warn'}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-ink">{item.text}</p>
                    <p className="mt-0.5 truncate text-[0.6875rem] text-muted">{item.detail}</p>
                  </div>
                  <Badge tone={item.tone} size="sm">
                    {item.tone === 'down' ? 'down' : 'warning'}
                  </Badge>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
