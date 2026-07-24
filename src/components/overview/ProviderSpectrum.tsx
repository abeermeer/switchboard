'use client';

import { useState } from 'react';
import Link from 'next/link';
import { cn, formatCompact, formatMs, formatUsd } from '@/lib/utils';

export interface SpectrumSegment {
  connectionId: string;
  label: string;
  providerName: string;
  accent: string;
  requests: number;
  costUsd: number;
  p50LatencyMs: number | null;
  status: string;
}

/**
 * Traffic share across the whole fleet as one continuous band.
 *
 * Width is share of requests, colour is the provider's brand, and opacity
 * carries health — so a provider that is both busy and failing reads as a wide
 * washed-out block, which is exactly the thing worth noticing.
 */
export function ProviderSpectrum({ segments }: { segments: SpectrumSegment[] }): React.ReactElement {
  const [hovered, setHovered] = useState<string | null>(null);

  const total = segments.reduce((sum, s) => sum + s.requests, 0);

  if (total === 0) {
    return (
      <div className="space-y-2">
        <div className="h-9 w-full rounded-sb border border-dashed border-line-strong" />
        <p className="text-xs text-faint">No traffic yet — the spectrum fills in as requests flow.</p>
      </div>
    );
  }

  const visible = segments.filter((s) => s.requests > 0);
  const active = hovered === null ? null : visible.find((s) => s.connectionId === hovered) ?? null;

  return (
    <div className="space-y-3">
      <div className="relative">
        <div className="flex h-9 w-full overflow-hidden rounded-sb border border-line">
          {visible.map((segment) => {
            const share = segment.requests / total;
            const dimmed = segment.status === 'down' || segment.status === 'degraded';
            return (
              <Link
                key={segment.connectionId}
                href={`/dashboard/providers/${segment.connectionId}`}
                onMouseEnter={() => setHovered(segment.connectionId)}
                onMouseLeave={() => setHovered(null)}
                onFocus={() => setHovered(segment.connectionId)}
                onBlur={() => setHovered(null)}
                aria-label={`${segment.label}: ${segment.requests} requests`}
                className={cn(
                  'group relative block h-full transition-[filter,opacity] duration-150',
                  hovered !== null && hovered !== segment.connectionId && 'opacity-40',
                )}
                style={{
                  width: `${share * 100}%`,
                  backgroundColor: segment.accent,
                  opacity: dimmed ? 0.55 : 1,
                }}
              >
                {share > 0.08 && (
                  <span className="absolute inset-0 flex items-center justify-center px-1 text-[0.625rem] font-medium text-white mix-blend-luminosity">
                    {(share * 100).toFixed(0)}%
                  </span>
                )}
              </Link>
            );
          })}
        </div>

        {active !== null && (
          <div className="pointer-events-none absolute -top-2 left-1/2 z-20 -translate-x-1/2 -translate-y-full rounded-sb border border-line bg-surface px-3 py-2 shadow-sb-lg animate-fade-up">
            <p className="text-xs font-medium text-ink">{active.label}</p>
            <p className="mt-0.5 text-[0.6875rem] text-faint">{active.providerName}</p>
            <div className="mt-1.5 flex gap-3 text-[0.6875rem] tabular">
              <span className="text-muted">
                {formatCompact(active.requests)} <span className="text-faint">req</span>
              </span>
              <span className="text-muted">{formatUsd(active.costUsd)}</span>
              <span className="text-muted">{formatMs(active.p50LatencyMs)}</span>
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        {visible.slice(0, 8).map((segment) => (
          <div key={segment.connectionId} className="flex items-center gap-1.5">
            <span
              className="h-2 w-2 shrink-0 rounded-sm"
              style={{ backgroundColor: segment.accent }}
              aria-hidden="true"
            />
            <span className="text-[0.6875rem] text-muted">{segment.label}</span>
            <span className="text-[0.6875rem] tabular text-faint">
              {((segment.requests / total) * 100).toFixed(0)}%
            </span>
          </div>
        ))}
        {visible.length > 8 && (
          <span className="text-[0.6875rem] text-faint">+{visible.length - 8} more</span>
        )}
      </div>
    </div>
  );
}
