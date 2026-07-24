'use client';

import { useEffect, useState } from 'react';
import { Play } from 'lucide-react';
import type { RouteCandidate } from '@/types/core';
import { cn, formatUsd } from '@/lib/utils';
import { Badge, Button, Skeleton, Textarea, Tooltip } from '@/components/ui';

interface Decorated extends RouteCandidate {
  providerName: string;
  accent: string;
}

interface Simulation {
  strategy: string;
  weights: Record<string, number>;
  inputTokens: number;
  winner: Decorated | null;
  candidates: Decorated[];
  excluded: Decorated[];
  hardError: string | null;
}

/**
 * A dry run of the policy: the exact expand-and-score path a live request takes,
 * stopped short of sending anything upstream.
 *
 * It re-runs on every config change so the ranking visibly reshuffles as the
 * user drags members or moves the cost ceiling. Routing stops being a black box
 * the moment you can watch it change its mind.
 */
export function DecisionTrace({
  comboId,
  revision,
}: {
  comboId: string;
  /** Bumped by the parent whenever the policy changes, to force a re-run. */
  revision: number;
}): React.ReactElement {
  const [prompt, setPrompt] = useState('Write a binary search function in Rust.');
  const [result, setResult] = useState<Simulation | null>(null);
  const [loading, setLoading] = useState(false);
  const [showExcluded, setShowExcluded] = useState(false);

  const run = async (value: string): Promise<void> => {
    setLoading(true);
    try {
      const res = await fetch(`/api/combos/${comboId}/simulate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: value }),
      });
      if (!res.ok) throw new Error('simulate failed');
      setResult((await res.json()) as Simulation);
    } catch {
      setResult(null);
    } finally {
      setLoading(false);
    }
  };

  // Debounced so dragging a slider does not fire a request per frame.
  useEffect(() => {
    const timer = setTimeout(() => void run(prompt), 400);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prompt, comboId, revision]);

  return (
    <div className="space-y-3">
      <div className="rounded-sb border border-line bg-surface p-4">
        <div className="mb-2 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-ink">Decision trace</h3>
            <p className="mt-0.5 text-xs text-muted">
              How this policy would route, without sending anything upstream
            </p>
          </div>
          <Button
            size="sm"
            variant="secondary"
            leadingIcon={<Play size={12} />}
            loading={loading}
            onClick={() => void run(prompt)}
          >
            Simulate
          </Button>
        </div>

        <Textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          rows={2}
          placeholder="Type a prompt to size the request…"
          className="text-xs"
        />

        {result !== null && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[0.6875rem] text-faint">
            <Badge size="sm" tone="accent">
              {result.strategy}
            </Badge>
            <span>~{result.inputTokens} input tokens</span>
            <span>·</span>
            <span>{result.candidates.length} eligible</span>
            {result.excluded.length > 0 && (
              <>
                <span>·</span>
                <span>{result.excluded.length} excluded</span>
              </>
            )}
          </div>
        )}
      </div>

      {loading && result === null ? (
        <div className="space-y-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : result === null ? (
        <p className="rounded-sb border border-line bg-surface px-4 py-6 text-center text-xs text-faint">
          Could not simulate this policy.
        </p>
      ) : result.hardError !== null ? (
        <p className="rounded-sb bg-down-soft px-4 py-3 text-xs text-down">{result.hardError}</p>
      ) : result.candidates.length === 0 ? (
        <p className="rounded-sb border border-line bg-surface px-4 py-6 text-center text-xs text-faint">
          No provider currently satisfies this policy. Check the excluded list below.
        </p>
      ) : (
        <ol className="space-y-2">
          {result.candidates.map((candidate, index) => (
            <CandidateRow
              key={`${candidate.connectionId}:${candidate.modelId}`}
              candidate={candidate}
              rank={index + 1}
              best={result.candidates[0]?.score ?? 1}
            />
          ))}
        </ol>
      )}

      {result !== null && result.excluded.length > 0 && (
        <div className="rounded-sb border border-line bg-surface">
          <button
            type="button"
            onClick={() => setShowExcluded((v) => !v)}
            className="flex w-full items-center justify-between px-4 py-2.5 text-xs text-muted transition-colors hover:text-ink"
          >
            <span>{result.excluded.length} candidates excluded</span>
            <span className="text-faint">{showExcluded ? 'hide' : 'show'}</span>
          </button>
          {showExcluded && (
            <ul className="divide-y divide-line border-t border-line">
              {result.excluded.map((candidate) => (
                <li
                  key={`${candidate.connectionId}:${candidate.modelId}`}
                  className="flex items-start gap-2.5 px-4 py-2"
                >
                  <span
                    className="mt-1 h-2 w-2 shrink-0 rounded-sm opacity-40"
                    style={{ backgroundColor: candidate.accent }}
                    aria-hidden="true"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-mono text-[0.6875rem] text-muted">
                      {candidate.providerName} / {candidate.modelId}
                    </p>
                    <p className="mt-0.5 text-[0.6875rem] text-faint">{candidate.excludedReason}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function CandidateRow({
  candidate,
  rank,
  best,
}: {
  candidate: Decorated;
  rank: number;
  best: number;
}): React.ReactElement {
  const relative = best > 0 ? candidate.score / best : 0;

  return (
    <li
      className={cn(
        'rounded-sb border bg-surface p-3',
        rank === 1 ? 'border-accent-line bg-accent-soft' : 'border-line',
      )}
    >
      <div className="flex items-center gap-2.5">
        <span
          className={cn(
            'flex h-5 w-5 shrink-0 items-center justify-center rounded text-[0.625rem] font-semibold tabular',
            rank === 1 ? 'bg-accent text-on-accent' : 'bg-surface-2 text-muted',
          )}
        >
          {rank}
        </span>
        <span
          className="h-2.5 w-2.5 shrink-0 rounded-sm"
          style={{ backgroundColor: candidate.accent }}
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-xs text-ink">{candidate.modelId}</p>
          <p className="text-[0.6875rem] text-faint">{candidate.providerName}</p>
        </div>
        <Badge size="sm" tone={candidate.tier === 'free' ? 'ok' : 'neutral'}>
          {candidate.tier}
        </Badge>
        <span className="w-16 shrink-0 text-right text-[0.6875rem] tabular text-muted">
          {candidate.projectedCostUsd === 0 ? (
            <span className="text-ok">free</span>
          ) : (
            formatUsd(candidate.projectedCostUsd)
          )}
        </span>
        <span className="w-10 shrink-0 text-right text-xs font-semibold tabular text-ink">
          {candidate.score.toFixed(3)}
        </span>
      </div>

      <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-surface-3">
        <div
          className={cn('h-full rounded-full', rank === 1 ? 'bg-accent' : 'bg-line-strong')}
          style={{ width: `${relative * 100}%` }}
        />
      </div>

      <div className="mt-2 flex flex-wrap gap-1">
        {candidate.factors.map((factor) => {
          const contribution = factor.value * factor.weight;
          return (
            <Tooltip key={factor.name} content={factor.note}>
              <span
                className={cn(
                  'inline-flex cursor-help items-center gap-1 rounded border border-line px-1.5 py-0.5',
                  'text-[0.625rem] text-muted',
                )}
              >
                <span
                  className="h-1 rounded-full bg-accent"
                  style={{ width: `${Math.max(2, contribution * 40)}px` }}
                  aria-hidden="true"
                />
                {factor.name}
              </span>
            </Tooltip>
          );
        })}
      </div>
    </li>
  );
}
