'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Plus, Search } from 'lucide-react';
import type { ConnectionView, ProviderCatalogEntry } from '@/types/core';
import { cn, formatCompact, formatMs, formatUsd } from '@/lib/utils';
import { Badge, Button, Input, StatusDot } from '@/components/ui';
import { ConnectDialog } from './ConnectDialog';

type Filter = 'all' | 'free' | 'connected' | 'chat' | 'embeddings' | 'images';

const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'free', label: 'Free tier' },
  { value: 'connected', label: 'Connected' },
  { value: 'chat', label: 'Chat' },
  { value: 'embeddings', label: 'Embeddings' },
  { value: 'images', label: 'Images' },
];

export function ProviderGrid({
  connections,
  providers,
}: {
  connections: ConnectionView[];
  providers: ProviderCatalogEntry[];
}): React.ReactElement {
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [connecting, setConnecting] = useState<ProviderCatalogEntry | null>(null);

  const connectedIds = useMemo(
    () => new Set(connections.map((c) => c.providerId)),
    [connections],
  );

  const matches = (provider: ProviderCatalogEntry): boolean => {
    const q = query.trim().toLowerCase();
    if (q.length > 0 && !`${provider.name} ${provider.id} ${provider.blurb}`.toLowerCase().includes(q)) {
      return false;
    }
    switch (filter) {
      case 'free':
        return provider.freeTier !== null;
      case 'connected':
        return connectedIds.has(provider.id);
      case 'chat':
      case 'embeddings':
      case 'images':
        return provider.modalities.includes(filter);
      default:
        return true;
    }
  };

  const visibleConnections = connections.filter((c) => matches(c.provider));
  const available = providers.filter((p) => matches(p));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-52 flex-1">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search providers…"
            className="pl-8"
          />
        </div>
        <div className="inline-flex flex-wrap gap-1">
          {FILTERS.map((item) => (
            <button
              key={item.value}
              type="button"
              onClick={() => setFilter(item.value)}
              className={cn(
                'rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
                filter === item.value
                  ? 'border-accent-line bg-accent-soft text-accent'
                  : 'border-line text-muted hover:bg-surface-2 hover:text-ink',
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {visibleConnections.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-faint">Connected</h2>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {visibleConnections.map((connection) => (
              <Link
                key={connection.id}
                href={`/dashboard/providers/${connection.id}`}
                className="group relative overflow-hidden rounded-sb border border-line bg-surface transition-shadow hover:border-line-strong hover:shadow-sb"
              >
                <span
                  className="absolute inset-x-0 top-0 h-0.5"
                  style={{ backgroundColor: connection.provider.accent }}
                  aria-hidden="true"
                />
                <div className="p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-ink">{connection.label}</p>
                      <p className="mt-0.5 text-xs text-faint">{connection.provider.name}</p>
                    </div>
                    <StatusDot status={connection.status} />
                  </div>

                  <div className="mt-3 flex items-center gap-1.5">
                    <Badge tone={connection.tier === 'free' ? 'ok' : 'neutral'} size="sm">
                      {connection.tier}
                    </Badge>
                    {!connection.hasCredential && (
                      <Badge tone="warn" size="sm">
                        no key
                      </Badge>
                    )}
                    {connection.health.breaker === 'open' && (
                      <Badge tone="down" size="sm">
                        breaker open
                      </Badge>
                    )}
                  </div>

                  <dl className="mt-3 grid grid-cols-3 gap-2 border-t border-line pt-3 text-xs">
                    <Metric label="Requests" value={formatCompact(connection.usage.requests)} />
                    <Metric label="Spend" value={formatUsd(connection.usage.costUsd)} />
                    <Metric label="p50" value={formatMs(connection.health.p50LatencyMs)} />
                  </dl>
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}

      <section className="space-y-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-faint">
          Available ({available.length})
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {available.map((provider) => (
            <div
              key={provider.id}
              className="relative flex flex-col overflow-hidden rounded-sb border border-line bg-surface p-4"
            >
              <span
                className="absolute inset-x-0 top-0 h-0.5 opacity-40"
                style={{ backgroundColor: provider.accent }}
                aria-hidden="true"
              />
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-ink">{provider.name}</p>
                  <p className="mt-0.5 text-xs leading-relaxed text-muted">{provider.blurb}</p>
                </div>
                {connectedIds.has(provider.id) && (
                  <Badge tone="ok" size="sm">
                    linked
                  </Badge>
                )}
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                {provider.freeTier !== null && (
                  <Badge tone="accent" size="sm">
                    free tier
                  </Badge>
                )}
                {!provider.requiresKey && (
                  <Badge tone="info" size="sm">
                    local
                  </Badge>
                )}
                <span className="text-[0.6875rem] text-faint">
                  {provider.models.length} model{provider.models.length === 1 ? '' : 's'}
                </span>
              </div>

              {provider.freeTier !== null && (
                <p className="mt-2 text-[0.6875rem] leading-relaxed text-muted">
                  {provider.freeTier.summary}
                </p>
              )}

              <div className="mt-auto pt-3">
                <Button
                  variant="secondary"
                  size="sm"
                  leadingIcon={<Plus size={13} />}
                  onClick={() => setConnecting(provider)}
                  className="w-full"
                >
                  Connect
                </Button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <ConnectDialog
        provider={connecting}
        open={connecting !== null}
        onClose={() => setConnecting(null)}
      />
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div>
      <dt className="text-[0.625rem] text-faint">{label}</dt>
      <dd className="tabular text-ink">{value}</dd>
    </div>
  );
}
