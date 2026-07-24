'use client';

import { Fragment, useMemo, useState } from 'react';
import { ChevronDown, Search } from 'lucide-react';
import { cn, formatMs } from '@/lib/utils';
import { Badge, Input, Select, Table, TBody, TD, TH, THead, TR } from '@/components/ui';

interface Offering {
  connectionId: string;
  label: string;
  providerName: string;
  accent: string;
  tier: string;
  inputCostPerMTok: number;
  outputCostPerMTok: number;
  status: string;
  p50LatencyMs: number | null;
  lockedOut: boolean;
}

export interface ModelGroup {
  id: string;
  name: string;
  modality: string;
  features: string[];
  contextWindow: number;
  maxOutput: number;
  providerCount: number;
  cheapestConnectionId: string | null;
  minInputCostPerMTok: number;
  minOutputCostPerMTok: number;
  bestTier: string;
  offerings: Offering[];
}

type SortKey = 'providers' | 'context' | 'input' | 'output' | 'name';

export function ModelsTable({ models }: { models: ModelGroup[] }): React.ReactElement {
  const [query, setQuery] = useState('');
  const [modality, setModality] = useState('all');
  const [freeOnly, setFreeOnly] = useState(false);
  const [feature, setFeature] = useState('all');
  const [sort, setSort] = useState<SortKey>('providers');
  const [expanded, setExpanded] = useState<string | null>(null);

  const modalities = useMemo(
    () => [...new Set(models.map((m) => m.modality))].sort(),
    [models],
  );

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = models.filter((model) => {
      if (q.length > 0 && !model.id.toLowerCase().includes(q) && !model.name.toLowerCase().includes(q)) {
        return false;
      }
      if (modality !== 'all' && model.modality !== modality) return false;
      if (freeOnly && model.bestTier !== 'free') return false;
      if (feature !== 'all' && !model.features.includes(feature)) return false;
      return true;
    });

    return filtered.sort((a, b) => {
      switch (sort) {
        case 'context':
          return b.contextWindow - a.contextWindow;
        case 'input':
          return a.minInputCostPerMTok - b.minInputCostPerMTok;
        case 'output':
          return a.minOutputCostPerMTok - b.minOutputCostPerMTok;
        case 'name':
          return a.id.localeCompare(b.id);
        default:
          return b.providerCount - a.providerCount || a.id.localeCompare(b.id);
      }
    });
  }, [models, query, modality, freeOnly, feature, sort]);

  const allFeatures = useMemo(
    () => [...new Set(models.flatMap((m) => m.features))].sort(),
    [models],
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-52 flex-1">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search models…"
            className="pl-8"
          />
        </div>
        <Select value={modality} onChange={(e) => setModality(e.target.value)} className="w-36">
          <option value="all">All modalities</option>
          {modalities.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </Select>
        <Select value={feature} onChange={(e) => setFeature(e.target.value)} className="w-32">
          <option value="all">Any feature</option>
          {allFeatures.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </Select>
        <Select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} className="w-40">
          <option value="providers">Most providers</option>
          <option value="input">Cheapest input</option>
          <option value="output">Cheapest output</option>
          <option value="context">Largest context</option>
          <option value="name">Name</option>
        </Select>
        <button
          type="button"
          onClick={() => setFreeOnly((v) => !v)}
          className={cn(
            'rounded-full border px-2.5 py-1.5 text-xs font-medium transition-colors',
            freeOnly
              ? 'border-accent-line bg-accent-soft text-accent'
              : 'border-line text-muted hover:text-ink',
          )}
        >
          Free only
        </button>
      </div>

      <div className="rounded-sb border border-line bg-surface">
        <Table>
          <THead>
            <TR>
              <TH>Model</TH>
              <TH>Served by</TH>
              <TH>Modality</TH>
              <TH align="right">Context</TH>
              <TH align="right">Input $/MTok</TH>
              <TH align="right">Output $/MTok</TH>
              <TH>Features</TH>
              <TH />
            </TR>
          </THead>
          <TBody>
            {rows.length === 0 ? (
              <TR>
                <TD colSpan={8} className="py-8 text-center text-xs text-faint">
                  No models match those filters.
                </TD>
              </TR>
            ) : (
              rows.map((model) => (
                <Fragment key={model.id}>
                  <TR
                    clickable
                    onClick={() => setExpanded(expanded === model.id ? null : model.id)}
                  >
                    <TD mono>{model.id}</TD>
                    <TD>
                      <div className="flex items-center gap-1">
                        {model.offerings.slice(0, 5).map((offering) => (
                          <span
                            key={offering.connectionId}
                            title={offering.label}
                            className="h-2.5 w-2.5 rounded-sm"
                            style={{ backgroundColor: offering.accent }}
                          />
                        ))}
                        {model.providerCount > 5 && (
                          <span className="text-[0.625rem] text-faint">+{model.providerCount - 5}</span>
                        )}
                      </div>
                    </TD>
                    <TD className="text-muted">{model.modality}</TD>
                    <TD align="right">{(model.contextWindow / 1000).toFixed(0)}K</TD>
                    <TD align="right">
                      {model.minInputCostPerMTok === 0 ? (
                        <span className="text-ok">free</span>
                      ) : (
                        <span className={model.providerCount > 1 ? 'text-accent' : undefined}>
                          ${model.minInputCostPerMTok.toFixed(2)}
                        </span>
                      )}
                    </TD>
                    <TD align="right">
                      {model.minOutputCostPerMTok === 0 ? (
                        <span className="text-ok">free</span>
                      ) : (
                        `$${model.minOutputCostPerMTok.toFixed(2)}`
                      )}
                    </TD>
                    <TD>
                      <div className="flex flex-wrap gap-1">
                        {model.features.slice(0, 3).map((f) => (
                          <Badge key={f} size="sm">
                            {f}
                          </Badge>
                        ))}
                      </div>
                    </TD>
                    <TD align="right">
                      <ChevronDown
                        size={13}
                        className={cn(
                          'text-faint transition-transform',
                          expanded === model.id && 'rotate-180',
                        )}
                      />
                    </TD>
                  </TR>

                  {expanded === model.id && (
                    <TR>
                      <TD colSpan={8} className="bg-surface-2 p-0">
                        <div className="px-4 py-3">
                          <p className="mb-2 text-xs text-muted">
                            {model.providerCount === 1
                              ? 'One provider serves this model — no fallback available.'
                              : `${model.providerCount} providers serve this model. The spread below is what you would pay for identical weights.`}
                          </p>
                          <div className="space-y-1">
                            {model.offerings.map((offering) => (
                              <div
                                key={offering.connectionId}
                                className={cn(
                                  'flex items-center gap-3 rounded-sb border px-3 py-1.5',
                                  offering.connectionId === model.cheapestConnectionId
                                    ? 'border-accent-line bg-accent-soft'
                                    : 'border-line bg-surface',
                                )}
                              >
                                <span
                                  className="h-2 w-2 shrink-0 rounded-sm"
                                  style={{ backgroundColor: offering.accent }}
                                />
                                <span className="min-w-0 flex-1 truncate text-xs text-ink">
                                  {offering.label}
                                </span>
                                <Badge size="sm" tone={offering.tier === 'free' ? 'ok' : 'neutral'}>
                                  {offering.tier}
                                </Badge>
                                {offering.lockedOut && (
                                  <Badge size="sm" tone="warn">
                                    locked out
                                  </Badge>
                                )}
                                <span className="w-20 text-right text-[0.6875rem] tabular text-muted">
                                  ${offering.inputCostPerMTok.toFixed(2)} in
                                </span>
                                <span className="w-20 text-right text-[0.6875rem] tabular text-muted">
                                  ${offering.outputCostPerMTok.toFixed(2)} out
                                </span>
                                <span className="w-14 text-right text-[0.6875rem] tabular text-faint">
                                  {formatMs(offering.p50LatencyMs)}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      </TD>
                    </TR>
                  )}
                </Fragment>
              ))
            )}
          </TBody>
        </Table>
      </div>
    </div>
  );
}
