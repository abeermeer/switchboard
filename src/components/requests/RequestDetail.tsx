'use client';

import { useState } from 'react';
import { RotateCw, Terminal } from 'lucide-react';
import type { RequestLogDetail } from '@/types/core';
import { cn, formatCompact, formatMs, formatUsd, relativeTime } from '@/lib/utils';
import {
  Badge,
  Button,
  CopyButton,
  Tabs,
  Tooltip,
  useToast,
} from '@/components/ui';

export function RequestDetail({
  detail,
  accents,
}: {
  detail: RequestLogDetail;
  accents: Record<string, string>;
}): React.ReactElement {
  const { toast } = useToast();
  const [tab, setTab] = useState('trace');
  const [replaying, setReplaying] = useState(false);
  const [replay, setReplay] = useState<Record<string, unknown> | null>(null);

  const decision = detail.decision;

  const runReplay = async (): Promise<void> => {
    setReplaying(true);
    try {
      const res = await fetch(`/api/logs/${detail.id}/replay`, { method: 'POST' });
      const body = (await res.json()) as { error?: string; replay?: Record<string, unknown> };
      if (!res.ok) throw new Error(body.error ?? 'Replay failed');
      setReplay(body.replay ?? null);
      toast({ title: 'Replayed', tone: 'ok' });
    } catch (err) {
      toast({ title: 'Replay failed', description: String(err), tone: 'down' });
    } finally {
      setReplaying(false);
    }
  };

  const asCurl = (): string => {
    const body = detail.requestBody === null ? {} : detail.requestBody;
    const path =
      detail.modality === 'chat'
        ? '/v1/chat/completions'
        : detail.modality === 'embeddings'
          ? '/v1/embeddings'
          : detail.modality === 'images'
            ? '/v1/images/generations'
            : '/v1/chat/completions';
    const origin = typeof window === 'undefined' ? 'http://127.0.0.1:7272' : window.location.origin;
    return `curl ${origin}${path} \\
  -H "Authorization: Bearer sb-live-your-key" \\
  -H "Content-Type: application/json" \\
  -d '${JSON.stringify(body, null, 2)}'`;
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <h1 className="font-mono text-sm text-ink">{detail.id}</h1>
            <Badge tone={detail.status === 'success' ? 'ok' : 'down'} dot>
              {detail.status} {detail.httpStatus}
            </Badge>
            {detail.attemptCount > 1 && (
              <Badge tone="accent">fell back ×{detail.attemptCount - 1}</Badge>
            )}
          </div>
          <p className="mt-1 text-xs text-muted">
            {relativeTime(detail.ts)} · {new Date(detail.ts).toLocaleString()}
          </p>
        </div>
        <div className="flex gap-2">
          <Tooltip content="Re-issue this request through the router as configured now">
            <Button size="sm" leadingIcon={<RotateCw size={12} />} loading={replaying} onClick={() => void runReplay()}>
              Replay
            </Button>
          </Tooltip>
          <Button
            size="sm"
            variant="secondary"
            leadingIcon={<Terminal size={12} />}
            onClick={() => {
              void navigator.clipboard.writeText(asCurl());
              toast({ title: 'cURL copied', tone: 'ok' });
            }}
          >
            Copy as cURL
          </Button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Field label="Requested" value={detail.requestedModel} mono />
        <Field label="Resolved" value={detail.resolvedModelId ?? '—'} mono />
        <Field label="Duration" value={formatMs(detail.durationMs)} />
        <Field label="TTFT" value={formatMs(detail.ttftMs)} />
        <Field
          label="Cost"
          value={detail.costUsd === 0 ? 'free' : formatUsd(detail.costUsd)}
          accent={detail.costUsd === 0}
        />
      </div>

      {replay !== null && (
        <div className="rounded-sb border border-accent-line bg-accent-soft p-4">
          <h3 className="text-xs font-semibold text-accent">Replay result</h3>
          <div className="mt-2 grid gap-3 text-xs sm:grid-cols-4">
            <Compare
              label="Provider"
              before={detail.resolvedProviderId ?? '—'}
              after={String(replay['resolvedProviderId'] ?? '—')}
            />
            <Compare
              label="Model"
              before={detail.resolvedModelId ?? '—'}
              after={String(replay['resolvedModelId'] ?? '—')}
            />
            <Compare
              label="Duration"
              before={formatMs(detail.durationMs)}
              after={formatMs(Number(replay['durationMs'] ?? 0))}
            />
            <Compare
              label="Cost"
              before={formatUsd(detail.costUsd)}
              after={formatUsd(Number(replay['costUsd'] ?? 0))}
            />
          </div>
        </div>
      )}

      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { value: 'trace', label: 'Decision trace' },
          { value: 'request', label: 'Request' },
          { value: 'response', label: 'Response' },
        ]}
      />

      {tab === 'trace' &&
        (decision === null ? (
          <p className="rounded-sb border border-line bg-surface px-4 py-8 text-center text-xs text-faint">
            No decision trace was stored for this request.
          </p>
        ) : (
          <div className="space-y-4">
            <div className="rounded-sb border border-line bg-surface p-4">
              <h3 className="text-sm font-semibold text-ink">Attempts</h3>
              <p className="mt-0.5 text-xs text-muted">
                {decision.attempts.length} upstream call
                {decision.attempts.length === 1 ? '' : 's'} under the{' '}
                <span className="text-accent">{decision.strategy}</span> strategy
              </p>

              <ol className="mt-3 space-y-2">
                {decision.attempts.map((attempt, index) => {
                  const longest = Math.max(...decision.attempts.map((a) => a.durationMs), 1);
                  return (
                    <li
                      key={`${attempt.connectionId}-${index}`}
                      className={cn(
                        'rounded-sb border p-3',
                        attempt.status === 'success'
                          ? 'border-ok/30 bg-ok-soft'
                          : 'border-line bg-surface',
                      )}
                    >
                      <div className="flex items-center gap-2.5">
                        <span className="w-5 shrink-0 text-[0.625rem] tabular text-faint">
                          {index + 1}
                        </span>
                        <span
                          className="h-2.5 w-2.5 shrink-0 rounded-sm"
                          style={{ backgroundColor: accents[attempt.providerId] ?? '#888' }}
                        />
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-mono text-xs text-ink">{attempt.modelId}</p>
                          <p className="text-[0.625rem] text-faint">{attempt.providerId}</p>
                        </div>
                        <Badge
                          size="sm"
                          tone={attempt.status === 'success' ? 'ok' : 'down'}
                        >
                          {attempt.status}
                          {attempt.httpStatus !== null && ` ${attempt.httpStatus}`}
                        </Badge>
                        <span className="w-16 shrink-0 text-right text-[0.6875rem] tabular text-muted">
                          {formatMs(attempt.durationMs)}
                        </span>
                      </div>

                      <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-surface-3">
                        <div
                          className={cn(
                            'h-full rounded-full',
                            attempt.status === 'success' ? 'bg-ok' : 'bg-down',
                          )}
                          style={{ width: `${(attempt.durationMs / longest) * 100}%` }}
                        />
                      </div>

                      {attempt.fallbackReason !== null && (
                        <p className="mt-1.5 text-[0.6875rem] text-down">→ {attempt.fallbackReason}</p>
                      )}
                    </li>
                  );
                })}
              </ol>
            </div>

            <div className="rounded-sb border border-line bg-surface p-4">
              <h3 className="text-sm font-semibold text-ink">Candidate ranking</h3>
              <p className="mt-0.5 text-xs text-muted">
                {decision.candidates.filter((c) => c.excludedReason === null).length} eligible,{' '}
                {decision.candidates.filter((c) => c.excludedReason !== null).length} excluded
              </p>

              <ul className="mt-3 space-y-1.5">
                {decision.candidates.slice(0, 20).map((candidate, index) => (
                  <li
                    key={`${candidate.connectionId}:${candidate.modelId}:${index}`}
                    className={cn(
                      'flex items-center gap-2.5 rounded-sb border px-3 py-2',
                      candidate.excludedReason === null ? 'border-line' : 'border-line opacity-50',
                    )}
                  >
                    <span
                      className="h-2 w-2 shrink-0 rounded-sm"
                      style={{ backgroundColor: accents[candidate.providerId] ?? '#888' }}
                    />
                    <span className="min-w-0 flex-1 truncate font-mono text-[0.6875rem] text-ink">
                      {candidate.modelId}
                    </span>
                    {candidate.excludedReason === null ? (
                      <>
                        <div className="hidden gap-1 sm:flex">
                          {candidate.factors.slice(0, 4).map((factor) => (
                            <Tooltip key={factor.name} content={factor.note}>
                              <span className="cursor-help rounded border border-line px-1 py-0.5 text-[0.5625rem] text-faint">
                                {factor.name[0]?.toUpperCase()}
                                {(factor.value * factor.weight).toFixed(2)}
                              </span>
                            </Tooltip>
                          ))}
                        </div>
                        <span className="w-11 shrink-0 text-right text-[0.6875rem] tabular font-medium text-ink">
                          {candidate.score.toFixed(3)}
                        </span>
                      </>
                    ) : (
                      <span className="truncate text-[0.6875rem] text-faint">
                        {candidate.excludedReason}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ))}

      {tab === 'request' && <Payload title="Request body" value={detail.requestBody} />}
      {tab === 'response' && <Payload title="Response body" value={detail.responseBody} />}

      {detail.error !== null && (
        <div className="rounded-sb bg-down-soft px-4 py-3">
          <p className="text-xs font-medium text-down">Error</p>
          <p className="mt-1 font-mono text-[0.6875rem] text-down">{detail.error}</p>
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  mono = false,
  accent = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
  accent?: boolean;
}): React.ReactElement {
  return (
    <div className="rounded-sb border border-line bg-surface px-3 py-2.5">
      <p className="text-[0.625rem] text-faint">{label}</p>
      <p
        className={cn(
          'mt-1 truncate text-xs tabular',
          mono && 'font-mono',
          accent ? 'text-ok' : 'text-ink',
        )}
      >
        {value}
      </p>
    </div>
  );
}

function Compare({
  label,
  before,
  after,
}: {
  label: string;
  before: string;
  after: string;
}): React.ReactElement {
  const changed = before !== after;
  return (
    <div>
      <p className="text-[0.625rem] text-faint">{label}</p>
      <p className="mt-0.5 truncate font-mono text-[0.6875rem] text-muted line-through">{before}</p>
      <p className={cn('truncate font-mono text-[0.6875rem]', changed ? 'text-accent' : 'text-ink')}>
        {after}
      </p>
    </div>
  );
}

/**
 * Redacts anything that looks like a credential before rendering. Stored
 * payloads can carry an upstream authorization header when a client sent one.
 */
function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = /authorization|api[-_]?key|token|secret|password/i.test(key)
        ? '«redacted»'
        : redact(inner);
    }
    return out;
  }
  return value;
}

function Payload({ title, value }: { title: string; value: unknown }): React.ReactElement {
  if (value === null || value === undefined) {
    return (
      <p className="rounded-sb border border-line bg-surface px-4 py-8 text-center text-xs text-faint">
        No payload stored. Enable payload logging in Settings to capture future requests.
      </p>
    );
  }

  const json = JSON.stringify(redact(value), null, 2);

  return (
    <div className="relative rounded-sb border border-line bg-surface">
      <div className="flex items-center justify-between border-b border-line px-4 py-2">
        <p className="text-xs font-medium text-ink">{title}</p>
        <CopyButton value={json} />
      </div>
      <pre className="max-h-96 overflow-auto px-4 py-3 font-mono text-[0.6875rem] leading-relaxed text-ink">
        {json}
      </pre>
    </div>
  );
}
