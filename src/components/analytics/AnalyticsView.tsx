'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Download } from 'lucide-react';
import type { UsageBucket, UsageRollup } from '@/types/core';
import { cn, formatCompact, formatMs, formatPercent, formatUsd } from '@/lib/utils';
import {
  Button,
  EmptyState,
  Skeleton,
  Stat,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from '@/components/ui';

interface ProviderRow extends UsageRollup {
  connectionId: string;
  label: string;
  providerName: string;
  accent: string;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
}

interface ModelRow extends UsageRollup {
  connectionId: string;
  modelId: string;
  providerName: string;
  accent: string;
  costPerRequest: number;
}

interface Summary {
  days: number;
  totals: UsageRollup & { successRate: number };
  p50LatencyMs: number | null;
  series: UsageBucket[];
  providers: ProviderRow[];
  models: ModelRow[];
}

const RANGES = [1, 7, 30, 90];

export function AnalyticsView(): React.ReactElement {
  const [days, setDays] = useState(7);
  const [data, setData] = useState<Summary | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    void (async () => {
      try {
        const res = await fetch(`/api/analytics/summary?days=${days}`);
        if (!res.ok) throw new Error('failed');
        const payload = (await res.json()) as Summary;
        if (!cancelled) setData(payload);
      } catch {
        if (!cancelled) setData(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [days]);

  const chartData = useMemo(() => {
    if (data === null) return [];
    let cumulative = 0;
    return data.series.map((bucket) => {
      cumulative += bucket.costUsd;
      return {
        ts: bucket.ts,
        spend: bucket.costUsd,
        saved: bucket.savedUsd,
        cumulative,
        prompt: bucket.promptTokens,
        completion: bucket.completionTokens,
      };
    });
  }, [data]);

  const exportCsv = (): void => {
    if (data === null) return;
    const header = 'provider,connection,requests,successes,failures,prompt_tokens,completion_tokens,cost_usd,saved_usd';
    const rows = data.providers.map((p) =>
      [
        p.providerName,
        p.label,
        p.requests,
        p.successes,
        p.failures,
        p.promptTokens,
        p.completionTokens,
        p.costUsd.toFixed(6),
        p.savedUsd.toFixed(6),
      ].join(','),
    );
    // Built in the browser from data already loaded — no extra endpoint needed.
    const blob = new Blob([[header, ...rows].join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `switchboard-usage-${days}d.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const formatTs = (ts: number): string =>
    new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-ink">Analytics</h1>
          <p className="mt-0.5 text-sm text-muted">Where the money and the milliseconds go.</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="inline-flex gap-0.5 rounded-sb bg-surface-2 p-0.5">
            {RANGES.map((range) => (
              <button
                key={range}
                type="button"
                onClick={() => setDays(range)}
                className={cn(
                  'rounded px-2.5 py-1 text-xs font-medium transition-colors',
                  days === range ? 'bg-surface text-ink shadow-sb-sm' : 'text-faint hover:text-ink',
                )}
              >
                {range === 1 ? '24h' : `${range}d`}
              </button>
            ))}
          </div>
          <Button size="sm" variant="secondary" leadingIcon={<Download size={12} />} onClick={exportCsv}>
            CSV
          </Button>
        </div>
      </div>

      {data === null ? (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-24" />
            ))}
          </div>
          <Skeleton className="h-64" />
        </div>
      ) : data.totals.requests === 0 ? (
        <EmptyState
          title="No traffic in this window"
          description="Send a request through the gateway and the numbers start filling in immediately."
        />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
            <Stat label="Requests" value={formatCompact(data.totals.requests)} />
            <Stat label="Spend" value={formatUsd(data.totals.costUsd)} />
            <Stat label="Saved" value={formatUsd(data.totals.savedUsd)} tone="ok" />
            <Stat label="Success rate" value={formatPercent(data.totals.successRate)} />
            <Stat label="Median latency" value={formatMs(data.p50LatencyMs)} />
            <Stat
              label="Tokens"
              value={formatCompact(data.totals.promptTokens + data.totals.completionTokens)}
            />
          </div>

          <div className="rounded-sb border border-line bg-surface p-4">
            <h3 className="text-sm font-semibold text-ink">Spend over time</h3>
            <p className="mt-0.5 text-xs text-muted">Per-bucket spend with the running total</p>
            <div className="mt-3 h-64">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="2 4" vertical={false} />
                  <XAxis dataKey="ts" tickFormatter={formatTs} tickLine={false} axisLine={false} minTickGap={40} />
                  <YAxis
                    tickFormatter={(v: number) => `$${v.toFixed(2)}`}
                    tickLine={false}
                    axisLine={false}
                    width={56}
                  />
                  <Tooltip
                    content={({ active, payload }) => {
                      if (active !== true || payload === undefined || payload.length === 0) return null;
                      const point = payload[0]?.payload as (typeof chartData)[number] | undefined;
                      if (point === undefined) return null;
                      return (
                        <div className="rounded-sb border border-line bg-surface px-3 py-2 text-[0.6875rem] shadow-sb-lg">
                          <p className="font-medium text-ink">{formatTs(point.ts)}</p>
                          <p className="mt-1 text-muted">
                            Spend <span className="tabular text-ink">{formatUsd(point.spend)}</span>
                          </p>
                          <p className="text-muted">
                            Saved <span className="tabular text-ok">{formatUsd(point.saved)}</span>
                          </p>
                          <p className="text-muted">
                            Running <span className="tabular text-ink">{formatUsd(point.cumulative)}</span>
                          </p>
                        </div>
                      );
                    }}
                  />
                  <Bar dataKey="spend" fill="var(--sb-accent)" radius={[2, 2, 0, 0]} maxBarSize={28} />
                  <Line
                    type="monotone"
                    dataKey="cumulative"
                    stroke="var(--sb-info)"
                    strokeWidth={1.5}
                    dot={false}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-sb border border-line bg-surface p-4">
              <h3 className="text-sm font-semibold text-ink">Cost by model</h3>
              <p className="mt-0.5 text-xs text-muted">Top 10 by spend</p>
              <div className="mt-3 h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={data.models.slice(0, 10)}
                    layout="vertical"
                    margin={{ top: 0, right: 12, left: 0, bottom: 0 }}
                  >
                    <CartesianGrid strokeDasharray="2 4" horizontal={false} />
                    <XAxis
                      type="number"
                      tickFormatter={(v: number) => `$${v.toFixed(2)}`}
                      tickLine={false}
                      axisLine={false}
                    />
                    <YAxis
                      type="category"
                      dataKey="modelId"
                      width={130}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={(v: string) => (v.length > 20 ? `${v.slice(0, 19)}…` : v)}
                    />
                    <Tooltip
                      cursor={{ fill: 'var(--sb-surface-2)' }}
                      content={({ active, payload }) => {
                        if (active !== true || payload === undefined || payload.length === 0) return null;
                        const row = payload[0]?.payload as ModelRow | undefined;
                        if (row === undefined) return null;
                        return (
                          <div className="rounded-sb border border-line bg-surface px-3 py-2 text-[0.6875rem] shadow-sb-lg">
                            <p className="font-mono text-ink">{row.modelId}</p>
                            <p className="mt-1 text-muted">
                              {formatCompact(row.requests)} req · {formatUsd(row.costUsd)}
                            </p>
                            <p className="text-muted">
                              {formatUsd(row.costPerRequest)} per request
                            </p>
                          </div>
                        );
                      }}
                    />
                    <Bar dataKey="costUsd" radius={[0, 3, 3, 0]} maxBarSize={18}>
                      {data.models.slice(0, 10).map((row) => (
                        <Cell key={`${row.connectionId}:${row.modelId}`} fill={row.accent} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="rounded-sb border border-line bg-surface p-4">
              <h3 className="text-sm font-semibold text-ink">Latency by provider</h3>
              <p className="mt-0.5 text-xs text-muted">p50 and p95, time to first token</p>
              <ul className="mt-3 space-y-2.5">
                {data.providers
                  .filter((p) => p.p50LatencyMs !== null)
                  .map((provider) => {
                    const slowest = Math.max(
                      ...data.providers.map((p) => p.p95LatencyMs ?? p.p50LatencyMs ?? 0),
                      1,
                    );
                    const p50 = provider.p50LatencyMs ?? 0;
                    const p95 = provider.p95LatencyMs ?? p50;
                    return (
                      <li key={provider.connectionId}>
                        <div className="flex items-center justify-between text-xs">
                          <span className="truncate text-ink">{provider.label}</span>
                          <span className="tabular text-muted">
                            {formatMs(p50)} <span className="text-faint">/ {formatMs(p95)}</span>
                          </span>
                        </div>
                        <div className="relative mt-1 h-1.5 w-full rounded-full bg-surface-3">
                          <div
                            className="absolute h-full rounded-full opacity-30"
                            style={{ width: `${(p95 / slowest) * 100}%`, backgroundColor: provider.accent }}
                          />
                          <div
                            className="absolute h-full rounded-full"
                            style={{ width: `${(p50 / slowest) * 100}%`, backgroundColor: provider.accent }}
                          />
                        </div>
                      </li>
                    );
                  })}
              </ul>
            </div>
          </div>

          <div className="rounded-sb border border-line bg-surface">
            <div className="border-b border-line px-4 py-3">
              <h3 className="text-sm font-semibold text-ink">Savings breakdown</h3>
              <p className="mt-0.5 text-xs text-muted">
                Actual spend against what this traffic would cost at frontier pricing
              </p>
            </div>
            <Table>
              <THead>
                <TR>
                  <TH>Provider</TH>
                  <TH align="right">Requests</TH>
                  <TH align="right">Tokens</TH>
                  <TH align="right">Spend</TH>
                  <TH align="right">Baseline</TH>
                  <TH align="right">Saved</TH>
                </TR>
              </THead>
              <TBody>
                {data.providers.map((provider) => (
                  <TR key={provider.connectionId}>
                    <TD>
                      <div className="flex items-center gap-2">
                        <span
                          className="h-2 w-2 shrink-0 rounded-sm"
                          style={{ backgroundColor: provider.accent }}
                          aria-hidden="true"
                        />
                        <span className="truncate">{provider.label}</span>
                      </div>
                    </TD>
                    <TD align="right">{formatCompact(provider.requests)}</TD>
                    <TD align="right">
                      {formatCompact(provider.promptTokens + provider.completionTokens)}
                    </TD>
                    <TD align="right">{formatUsd(provider.costUsd)}</TD>
                    <TD align="right" className="text-faint">
                      {formatUsd(provider.costUsd + provider.savedUsd)}
                    </TD>
                    <TD align="right" className="text-ok">
                      {formatUsd(provider.savedUsd)}
                    </TD>
                  </TR>
                ))}
                <TR className="border-t-2 border-line-strong font-medium">
                  <TD>Total</TD>
                  <TD align="right">{formatCompact(data.totals.requests)}</TD>
                  <TD align="right">
                    {formatCompact(data.totals.promptTokens + data.totals.completionTokens)}
                  </TD>
                  <TD align="right">{formatUsd(data.totals.costUsd)}</TD>
                  <TD align="right" className="text-faint">
                    {formatUsd(data.totals.costUsd + data.totals.savedUsd)}
                  </TD>
                  <TD align="right" className="text-ok">
                    {formatUsd(data.totals.savedUsd)}
                  </TD>
                </TR>
              </TBody>
            </Table>
          </div>
        </>
      )}
    </div>
  );
}
