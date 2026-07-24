'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Pause, Play, Search } from 'lucide-react';
import type { RequestLogEntry } from '@/types/core';
import { cn, formatCompact, formatMs, formatUsd, relativeTime } from '@/lib/utils';
import {
  Badge,
  Button,
  EmptyState,
  Input,
  Select,
  Skeleton,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from '@/components/ui';
import { useLive } from '@/components/shell/LiveProvider';

const PAGE_SIZE = 50;

export function RequestList({ accents }: { accents: Record<string, string> }): React.ReactElement {
  const { logs: liveLogs } = useLive();

  const [rows, setRows] = useState<RequestLogEntry[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [status, setStatus] = useState('all');
  const [search, setSearch] = useState('');
  const [following, setFollowing] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);

  const load = useCallback(async (): Promise<void> => {
    const params = new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String(page * PAGE_SIZE),
    });
    if (status !== 'all') params.set('status', status);
    if (search.trim().length > 0) params.set('search', search.trim());

    try {
      const res = await fetch(`/api/logs?${params.toString()}`);
      if (!res.ok) throw new Error('failed');
      const payload = (await res.json()) as { rows: RequestLogEntry[]; total: number };
      setRows(payload.rows);
      setTotal(payload.total);
    } catch {
      setRows([]);
    }
  }, [page, status, search]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 250);
    return () => clearTimeout(timer);
  }, [load]);

  // New rows only merge in while following, on the first page, and unfiltered —
  // splicing live traffic into a filtered or paged view would be a lie.
  useEffect(() => {
    if (!following || page !== 0 || status !== 'all' || search.length > 0) return;
    if (liveLogs.length === 0) return;

    setRows((current) => {
      if (current === null) return current;
      const seen = new Set(current.map((r) => r.id));
      const fresh = liveLogs.filter((r) => !seen.has(r.id));
      if (fresh.length === 0) return current;
      return [...fresh, ...current].slice(0, PAGE_SIZE);
    });
  }, [liveLogs, following, page, status, search]);

  // Scrolling away from the top pauses the feed. Auto-scrolling a log someone
  // is reading is hostile.
  const onScroll = (): void => {
    const node = scroller.current;
    if (node === null) return;
    if (node.scrollTop > 40 && following) setFollowing(false);
  };

  const pages = Math.ceil(total / PAGE_SIZE);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-52 flex-1">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
          <Input
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(0);
            }}
            placeholder="Search model or error…"
            className="pl-8"
          />
        </div>
        <Select
          value={status}
          onChange={(event) => {
            setStatus(event.target.value);
            setPage(0);
          }}
          className="w-32"
        >
          <option value="all">All status</option>
          <option value="success">Success</option>
          <option value="error">Error</option>
        </Select>
        <Button
          size="sm"
          variant={following ? 'primary' : 'secondary'}
          leadingIcon={following ? <Pause size={12} /> : <Play size={12} />}
          onClick={() => {
            setFollowing((v) => !v);
            if (!following) scroller.current?.scrollTo({ top: 0 });
          }}
        >
          {following ? 'Live' : 'Paused'}
        </Button>
      </div>

      <div className="rounded-sb border border-line bg-surface">
        <div ref={scroller} onScroll={onScroll} className="max-h-[calc(100vh-16rem)] overflow-y-auto">
          {rows === null ? (
            <div className="space-y-2 p-3">
              {Array.from({ length: 8 }, (_, i) => (
                <Skeleton key={i} className="h-8" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <EmptyState
              title="No requests logged"
              description="Every call through the gateway lands here with its full routing decision."
            />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Time</TH>
                  <TH>Model</TH>
                  <TH>Provider</TH>
                  <TH align="right">Latency</TH>
                  <TH align="right">TTFT</TH>
                  <TH align="right">Tokens</TH>
                  <TH align="right">Cost</TH>
                  <TH />
                </TR>
              </THead>
              <TBody>
                {rows.map((row) => (
                  <TR key={row.id} clickable>
                    <TD>
                      <Link href={`/dashboard/requests/${row.id}`} className="flex items-center gap-2">
                        <span
                          className={cn(
                            'status-dot shrink-0',
                            row.status === 'success' ? 'text-ok' : 'text-down',
                          )}
                        />
                        <span className="whitespace-nowrap text-[0.6875rem] text-muted">
                          {relativeTime(row.ts)}
                        </span>
                      </Link>
                    </TD>
                    <TD mono>
                      <Link href={`/dashboard/requests/${row.id}`} className="block truncate">
                        {row.resolvedModelId ?? row.requestedModel}
                      </Link>
                    </TD>
                    <TD>
                      {row.resolvedProviderId !== null && (
                        <span className="flex items-center gap-1.5">
                          <span
                            className="h-2 w-2 shrink-0 rounded-sm"
                            style={{ backgroundColor: accents[row.resolvedProviderId] ?? '#888' }}
                          />
                          <span className="text-xs text-muted">{row.resolvedProviderId}</span>
                        </span>
                      )}
                    </TD>
                    <TD align="right">{formatMs(row.durationMs)}</TD>
                    <TD align="right" className="text-muted">
                      {formatMs(row.ttftMs)}
                    </TD>
                    <TD align="right" className="text-muted">
                      {row.usage === null
                        ? '—'
                        : `${formatCompact(row.usage.promptTokens)}/${formatCompact(row.usage.completionTokens)}`}
                    </TD>
                    <TD align="right">
                      {row.costUsd === 0 ? <span className="text-ok">free</span> : formatUsd(row.costUsd)}
                    </TD>
                    <TD>
                      {row.attemptCount > 1 && (
                        <Badge tone="accent" size="sm">
                          ×{row.attemptCount}
                        </Badge>
                      )}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </div>

        {pages > 1 && (
          <div className="flex items-center justify-between border-t border-line px-4 py-2.5">
            <p className="text-xs text-muted tabular">
              {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total}
            </p>
            <div className="flex gap-1.5">
              <Button size="sm" variant="ghost" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                Previous
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={page >= pages - 1}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
