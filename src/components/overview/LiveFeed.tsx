'use client';

import Link from 'next/link';
import { cn, formatMs, formatUsd, relativeTime } from '@/lib/utils';
import { Badge, EmptyState } from '@/components/ui';
import { useLive } from '@/components/shell/LiveProvider';
import { Radio } from 'lucide-react';

export function LiveFeed({ accents }: { accents: Record<string, string> }): React.ReactElement {
  const { logs, connected } = useLive();
  const rows = logs.slice(0, 12);

  return (
    <div className="rounded-sb border border-line bg-surface">
      <div className="flex items-center justify-between px-4 pb-2 pt-4">
        <div>
          <h3 className="text-sm font-semibold text-ink">Live requests</h3>
          <p className="mt-0.5 text-xs text-muted">Streaming as they land</p>
        </div>
        <span
          className={cn('status-dot', connected ? 'text-ok' : 'text-faint')}
          data-live={connected ? 'true' : 'false'}
          title={connected ? 'Connected' : 'Reconnecting'}
        />
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon={<Radio size={16} />}
          title="Waiting for traffic"
          description="Requests will appear here the moment your first client calls the gateway."
        />
      ) : (
        <ul className="divide-y divide-line">
          {rows.map((row) => (
            <li key={row.id} className="animate-fade-up">
              <Link
                href={`/dashboard/requests/${row.id}`}
                className="flex items-center gap-3 px-4 py-2 transition-colors hover:bg-surface-2"
              >
                <span
                  className={cn(
                    'status-dot shrink-0',
                    row.status === 'success' ? 'text-ok' : 'text-down',
                  )}
                />

                <span className="w-14 shrink-0 text-[0.6875rem] tabular text-faint">
                  {relativeTime(row.ts)}
                </span>

                {row.resolvedProviderId !== null && (
                  <span
                    className="h-2 w-2 shrink-0 rounded-sm"
                    style={{ backgroundColor: accents[row.resolvedProviderId] ?? 'var(--sb-text-faint)' }}
                    aria-hidden="true"
                  />
                )}

                <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink">
                  {row.resolvedModelId ?? row.requestedModel}
                </span>

                {row.attemptCount > 1 && (
                  <Badge tone="accent" size="sm">
                    fell back ×{row.attemptCount - 1}
                  </Badge>
                )}

                <span className="w-14 shrink-0 text-right text-[0.6875rem] tabular text-muted">
                  {formatMs(row.ttftMs ?? row.durationMs)}
                </span>
                <span className="w-16 shrink-0 text-right text-[0.6875rem] tabular text-muted">
                  {row.costUsd === 0 ? (
                    <span className="text-ok">free</span>
                  ) : (
                    formatUsd(row.costUsd)
                  )}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
