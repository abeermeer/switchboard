'use client';

import { useEffect, useState } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { UsageBucket } from '@/types/core';
import { cn, formatCompact, formatUsd } from '@/lib/utils';
import { Skeleton } from '@/components/ui';

const RANGES = [
  { label: '24h', days: 1 },
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
] as const;

interface Point {
  ts: number;
  requests: number;
  tokens: number;
  costUsd: number;
  savedUsd: number;
}

export function TrafficChart(): React.ReactElement {
  const [days, setDays] = useState<number>(1);
  const [points, setPoints] = useState<Point[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPoints(null);

    void (async () => {
      try {
        const res = await fetch(`/api/analytics/series?days=${days}`);
        if (!res.ok) throw new Error('failed');
        const payload = (await res.json()) as { series: UsageBucket[] };
        if (cancelled) return;
        setPoints(
          payload.series.map((bucket) => ({
            ts: bucket.ts,
            requests: bucket.requests,
            tokens: bucket.promptTokens + bucket.completionTokens,
            costUsd: bucket.costUsd,
            savedUsd: bucket.savedUsd,
          })),
        );
      } catch {
        if (!cancelled) setPoints([]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [days]);

  const formatTs = (ts: number): string => {
    const date = new Date(ts);
    return days <= 1
      ? date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
      : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };

  return (
    <div className="rounded-sb border border-line bg-surface">
      <div className="flex items-center justify-between px-4 pb-2 pt-4">
        <div>
          <h3 className="text-sm font-semibold text-ink">Traffic</h3>
          <p className="mt-0.5 text-xs text-muted">Requests and tokens over time</p>
        </div>
        <div className="inline-flex gap-0.5 rounded-sb bg-surface-2 p-0.5">
          {RANGES.map((range) => (
            <button
              key={range.label}
              type="button"
              onClick={() => setDays(range.days)}
              className={cn(
                'rounded px-2 py-1 text-xs font-medium transition-colors',
                days === range.days ? 'bg-surface text-ink shadow-sb-sm' : 'text-faint hover:text-ink',
              )}
            >
              {range.label}
            </button>
          ))}
        </div>
      </div>

      <div className="h-56 px-2 pb-3">
        {points === null ? (
          <Skeleton className="m-2 h-[12.5rem] w-[calc(100%-1rem)]" />
        ) : points.every((p) => p.requests === 0) ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-xs text-faint">No traffic in this window.</p>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={points} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="sb-req" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--sb-accent)" stopOpacity={0.28} />
                  <stop offset="100%" stopColor="var(--sb-accent)" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="2 4" vertical={false} />
              <XAxis
                dataKey="ts"
                tickFormatter={formatTs}
                tickLine={false}
                axisLine={false}
                minTickGap={40}
              />
              <YAxis
                tickFormatter={(v: number) => formatCompact(v)}
                tickLine={false}
                axisLine={false}
                width={44}
              />
              <Tooltip
                cursor={{ stroke: 'var(--sb-border-strong)', strokeWidth: 1 }}
                content={({ active, payload }) => {
                  if (active !== true || payload === undefined || payload.length === 0) return null;
                  const point = payload[0]?.payload as Point | undefined;
                  if (point === undefined) return null;
                  return (
                    <div className="rounded-sb border border-line bg-surface px-3 py-2 shadow-sb-lg">
                      <p className="text-xs font-medium text-ink">{formatTs(point.ts)}</p>
                      <dl className="mt-1.5 space-y-0.5 text-[0.6875rem]">
                        <Row label="Requests" value={formatCompact(point.requests)} />
                        <Row label="Tokens" value={formatCompact(point.tokens)} />
                        <Row label="Spend" value={formatUsd(point.costUsd)} />
                        <Row label="Saved" value={formatUsd(point.savedUsd)} accent />
                      </dl>
                    </div>
                  );
                }}
              />
              <Area
                type="monotone"
                dataKey="requests"
                stroke="var(--sb-accent)"
                strokeWidth={1.75}
                fill="url(#sb-req)"
                animationDuration={300}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  accent = false,
}: {
  label: string;
  value: string;
  accent?: boolean;
}): React.ReactElement {
  return (
    <div className="flex justify-between gap-6">
      <dt className="text-faint">{label}</dt>
      <dd className={cn('tabular', accent ? 'text-accent' : 'text-ink')}>{value}</dd>
    </div>
  );
}
