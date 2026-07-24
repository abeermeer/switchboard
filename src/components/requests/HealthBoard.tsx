'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { RefreshCw, Zap } from 'lucide-react';
import type { HealthSnapshot, ModelLockout } from '@/types/core';
import { cn, formatMs, formatPercent, relativeTime } from '@/lib/utils';
import { Badge, Button, StatusDot, useToast } from '@/components/ui';
import { useLive } from '@/components/shell/LiveProvider';

interface Item {
  connectionId: string;
  label: string;
  providerId: string;
  providerName: string;
  accent: string;
  enabled: boolean;
  health: HealthSnapshot | null;
}

export function HealthBoard({
  items,
  lockouts,
  uptime,
}: {
  items: Item[];
  lockouts: ModelLockout[];
  /** 96 fifteen-minute success-rate cells per connection, oldest first. */
  uptime: Record<string, Array<number | null>>;
}): React.ReactElement {
  const router = useRouter();
  const { toast } = useToast();
  const { health: liveHealth } = useLive();
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // Cooldown counters have to actually tick, or "wait 30s" is a static lie.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  const merged = items.map((item) => ({
    ...item,
    health: liveHealth[item.connectionId] ?? item.health,
  }));

  const active = merged.filter((item) => item.enabled && item.health !== null);
  const overall =
    active.length === 0
      ? 'unknown'
      : active.every((i) => i.health?.status === 'healthy')
        ? 'operational'
        : active.some((i) => i.health?.status === 'healthy')
          ? 'degraded'
          : 'outage';

  const probeAll = async (): Promise<void> => {
    setBusy(true);
    try {
      await fetch('/api/health/probe', { method: 'POST' });
      toast({ title: 'Probed every provider', tone: 'ok' });
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  const reset = async (connectionId: string): Promise<void> => {
    await fetch(`/api/health/${connectionId}/reset`, { method: 'POST' });
    toast({ title: 'Breaker reset', tone: 'ok' });
    router.refresh();
  };

  const probe = async (connectionId: string): Promise<void> => {
    const res = await fetch(`/api/connections/${connectionId}/test`, { method: 'POST' });
    const body = (await res.json()) as { ok: boolean; latencyMs: number; error: string | null };
    toast({
      title: body.ok ? `Responded in ${formatMs(body.latencyMs)}` : 'Probe failed',
      description: body.error ?? undefined,
      tone: body.ok ? 'ok' : 'down',
    });
    router.refresh();
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-ink">Health</h1>
          <p className="mt-0.5 text-sm text-muted">Live provider status and circuit state.</p>
        </div>
        <Button size="sm" leadingIcon={<RefreshCw size={12} />} loading={busy} onClick={() => void probeAll()}>
          Probe all
        </Button>
      </div>

      <div
        className={cn(
          'rounded-sb border px-4 py-3.5',
          overall === 'operational'
            ? 'border-ok/30 bg-ok-soft'
            : overall === 'degraded'
              ? 'border-warn/30 bg-warn-soft'
              : overall === 'outage'
                ? 'border-down/30 bg-down-soft'
                : 'border-line bg-surface',
        )}
      >
        <p
          className={cn(
            'text-sm font-semibold',
            overall === 'operational'
              ? 'text-ok'
              : overall === 'degraded'
                ? 'text-warn'
                : overall === 'outage'
                  ? 'text-down'
                  : 'text-muted',
          )}
        >
          {overall === 'operational'
            ? 'All systems operational'
            : overall === 'degraded'
              ? 'Partial degradation'
              : overall === 'outage'
                ? 'Full outage — no provider is currently healthy'
                : 'No providers configured'}
        </p>
        <p className="mt-0.5 text-xs text-muted">
          {active.filter((i) => i.health?.status === 'healthy').length} of {active.length} providers
          healthy
        </p>
      </div>

      <div className="space-y-2">
        {merged.map((item) => {
          const health = item.health;
          const cells = uptime[item.connectionId] ?? [];
          const cooldownLeft =
            health?.cooldownUntil == null ? 0 : Math.max(0, health.cooldownUntil - now);

          return (
            <div key={item.connectionId} className="rounded-sb border border-line bg-surface p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2.5">
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-sm"
                    style={{ backgroundColor: item.accent }}
                  />
                  <Link
                    href={`/dashboard/providers/${item.connectionId}`}
                    className="truncate text-sm font-medium text-ink hover:text-accent"
                  >
                    {item.label}
                  </Link>
                  {health !== null && <StatusDot status={health.status} />}
                  {health?.breaker !== 'closed' && health !== null && (
                    <Badge tone={health.breaker === 'open' ? 'down' : 'warn'} size="sm">
                      breaker {health.breaker}
                    </Badge>
                  )}
                </div>

                <div className="flex items-center gap-3 text-xs">
                  {health !== null && (
                    <>
                      <span className="tabular text-muted">
                        {formatPercent(health.successRate)} ok
                      </span>
                      <span className="tabular text-muted">
                        {formatMs(health.p50LatencyMs)}
                        <span className="text-faint"> / {formatMs(health.p95LatencyMs)}</span>
                      </span>
                    </>
                  )}
                  <Button size="sm" variant="ghost" leadingIcon={<Zap size={11} />} onClick={() => void probe(item.connectionId)}>
                    Probe
                  </Button>
                  {health?.breaker !== 'closed' && (
                    <Button size="sm" variant="ghost" onClick={() => void reset(item.connectionId)}>
                      Reset
                    </Button>
                  )}
                </div>
              </div>

              {cells.length > 0 && (
                <div className="mt-3 flex h-6 gap-px" title="Last 24 hours, 15-minute buckets">
                  {cells.map((rate, index) => (
                    <span
                      key={index}
                      className={cn(
                        'flex-1 rounded-[1px]',
                        rate === null
                          ? 'bg-surface-3'
                          : rate >= 0.99
                            ? 'bg-ok'
                            : rate >= 0.9
                              ? 'bg-warn'
                              : 'bg-down',
                      )}
                    />
                  ))}
                </div>
              )}

              {cooldownLeft > 0 && (
                <p className="mt-2 text-[0.6875rem] text-warn tabular">
                  Cooling down — retrying in {Math.ceil(cooldownLeft / 1000)}s
                </p>
              )}

              {health?.lastError != null && (
                <p className="mt-2 truncate font-mono text-[0.6875rem] text-down">
                  {health.lastError}
                </p>
              )}

              {health?.lastCheckedAt != null && (
                <p className="mt-1 text-[0.625rem] text-faint">
                  Last checked {relativeTime(health.lastCheckedAt)}
                </p>
              )}
            </div>
          );
        })}
      </div>

      {lockouts.length > 0 && (
        <div className="rounded-sb border border-line bg-surface p-4">
          <h3 className="text-sm font-semibold text-ink">Model lockouts</h3>
          <p className="mt-0.5 text-xs text-muted">
            Rate-limited models, skipped by the router until they expire.
          </p>
          <ul className="mt-3 space-y-1.5">
            {lockouts.map((lock) => (
              <li
                key={`${lock.connectionId}:${lock.modelId}`}
                className="flex items-center justify-between rounded-sb border border-line px-3 py-2"
              >
                <span className="truncate font-mono text-xs text-ink">{lock.modelId}</span>
                <span className="shrink-0 text-[0.6875rem] tabular text-warn">
                  {Math.max(0, Math.ceil((lock.until - now) / 1000))}s left
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
