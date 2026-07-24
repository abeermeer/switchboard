'use client';

import { useRef, useState } from 'react';
import { RotateCcw, Send, Trophy } from 'lucide-react';
import type { TokenUsage } from '@/types/core';
import { cn, formatCompact, formatMs, formatUsd } from '@/lib/utils';
import { Badge, Button, Field, Input, Textarea } from '@/components/ui';
import { Markdown } from './Markdown';

interface ModelOption {
  id: string;
  label: string;
  accent: string;
  free: boolean;
}

interface Column {
  model: string;
  text: string;
  resolvedModel: string | null;
  providerId: string | null;
  ttftMs: number | null;
  durationMs: number | null;
  usage: TokenUsage | null;
  costUsd: number;
  error: string | null;
  done: boolean;
}

const MAX_COLUMNS = 4;

export function Playground({
  models,
  combos,
}: {
  models: ModelOption[];
  combos: Array<{ slug: string; name: string }>;
}): React.ReactElement {
  const [selected, setSelected] = useState<string[]>(
    models.length > 0 ? [models[0]!.id] : [],
  );
  const [system, setSystem] = useState('');
  const [prompt, setPrompt] = useState('');
  const [temperature, setTemperature] = useState(0.7);
  const [maxTokens, setMaxTokens] = useState(1024);
  const [running, setRunning] = useState(false);
  const [columns, setColumns] = useState<Column[]>([]);
  const abort = useRef<AbortController | null>(null);

  const toggle = (id: string): void => {
    setSelected((current) =>
      current.includes(id)
        ? current.filter((m) => m !== id)
        : current.length >= MAX_COLUMNS
          ? current
          : [...current, id],
    );
  };

  const run = async (): Promise<void> => {
    if (prompt.trim().length === 0 || selected.length === 0) return;

    setRunning(true);
    setColumns(
      selected.map((model) => ({
        model,
        text: '',
        resolvedModel: null,
        providerId: null,
        ttftMs: null,
        durationMs: null,
        usage: null,
        costUsd: 0,
        error: null,
        done: false,
      })),
    );

    const controller = new AbortController();
    abort.current = controller;

    const messages = [
      ...(system.trim().length > 0 ? [{ role: 'system', content: system.trim() }] : []),
      { role: 'user', content: prompt },
    ];

    try {
      const res = await fetch('/api/playground', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ models: selected, messages, temperature, maxTokens }),
        signal: controller.signal,
      });

      if (res.body === null) throw new Error('No response stream');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        // The tail may be a partial line; carry it into the next read.
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.trim().length === 0) continue;
          let frame: Record<string, unknown>;
          try {
            frame = JSON.parse(line) as Record<string, unknown>;
          } catch {
            continue;
          }

          const model = String(frame['model'] ?? '');
          setColumns((current) =>
            current.map((column) => {
              if (column.model !== model) return column;
              switch (frame['event']) {
                case 'routed':
                  return {
                    ...column,
                    resolvedModel: (frame['resolvedModel'] as string | null) ?? null,
                    providerId: (frame['providerId'] as string | null) ?? null,
                  };
                case 'ttft':
                  return { ...column, ttftMs: Number(frame['ttftMs'] ?? 0) };
                case 'delta':
                  return { ...column, text: column.text + String(frame['delta'] ?? '') };
                case 'done':
                  return {
                    ...column,
                    done: true,
                    usage: (frame['usage'] as TokenUsage | null) ?? null,
                    costUsd: Number(frame['costUsd'] ?? 0),
                    durationMs: Number(frame['durationMs'] ?? 0),
                  };
                case 'error':
                  return {
                    ...column,
                    done: true,
                    error: String(frame['error'] ?? 'Failed'),
                    durationMs: Number(frame['durationMs'] ?? 0),
                  };
                default:
                  return column;
              }
            }),
          );
        }
      }
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        setColumns((current) =>
          current.map((c) => (c.done ? c : { ...c, done: true, error: String(err) })),
        );
      }
    } finally {
      setRunning(false);
      abort.current = null;
    }
  };

  const finished = columns.filter((c) => c.done && c.error === null && c.durationMs !== null);
  const winner =
    finished.length > 1
      ? finished.reduce((best, c) => ((c.durationMs ?? 0) < (best.durationMs ?? 0) ? c : best))
      : null;
  const totalCost = columns.reduce((sum, c) => sum + c.costUsd, 0);

  return (
    <div className="grid gap-4 lg:grid-cols-[18rem_1fr]">
      <aside className="space-y-4">
        <div className="rounded-sb border border-line bg-surface p-4">
          <div className="mb-2 flex items-baseline justify-between">
            <p className="text-xs font-medium text-ink">Models</p>
            <span className="text-[0.625rem] text-faint">
              {selected.length}/{MAX_COLUMNS}
            </span>
          </div>
          <p className="mb-2 text-[0.6875rem] leading-relaxed text-muted">
            Pick up to four and they race side by side.
          </p>
          <div className="max-h-64 space-y-0.5 overflow-y-auto">
            {combos.map((combo) => (
              <ModelRow
                key={`combo-${combo.slug}`}
                id={combo.slug}
                label={`${combo.name} (policy)`}
                accent="var(--sb-accent)"
                free={false}
                checked={selected.includes(combo.slug)}
                disabled={!selected.includes(combo.slug) && selected.length >= MAX_COLUMNS}
                onToggle={() => toggle(combo.slug)}
              />
            ))}
            {models.map((model) => (
              <ModelRow
                key={model.id}
                id={model.id}
                label={model.id}
                accent={model.accent}
                free={model.free}
                checked={selected.includes(model.id)}
                disabled={!selected.includes(model.id) && selected.length >= MAX_COLUMNS}
                onToggle={() => toggle(model.id)}
              />
            ))}
          </div>
        </div>

        <div className="space-y-3 rounded-sb border border-line bg-surface p-4">
          <Field label="System prompt">
            {(id) => (
              <Textarea
                id={id}
                rows={3}
                value={system}
                onChange={(event) => setSystem(event.target.value)}
                placeholder="Optional"
                className="text-xs"
              />
            )}
          </Field>
          <Field label={`Temperature — ${temperature.toFixed(2)}`}>
            {() => (
              <input
                type="range"
                min={0}
                max={2}
                step={0.05}
                value={temperature}
                onChange={(event) => setTemperature(Number(event.target.value))}
                className="h-1 w-full cursor-pointer appearance-none rounded-full bg-surface-3 accent-[var(--sb-accent)]"
              />
            )}
          </Field>
          <Field label="Max tokens">
            {(id) => (
              <Input
                id={id}
                type="number"
                value={maxTokens}
                onChange={(event) => setMaxTokens(Number(event.target.value))}
              />
            )}
          </Field>
        </div>
      </aside>

      <div className="space-y-3">
        <div className="rounded-sb border border-line bg-surface p-3">
          <Textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void run();
            }}
            rows={3}
            placeholder="Ask something… (⌘↵ to send)"
          />
          <div className="mt-2 flex items-center justify-between">
            <p className="text-[0.6875rem] text-faint">
              {selected.length === 0
                ? 'Select at least one model'
                : `${selected.length} model${selected.length === 1 ? '' : 's'} selected`}
            </p>
            <div className="flex gap-2">
              {columns.length > 0 && (
                <Button
                  size="sm"
                  variant="ghost"
                  leadingIcon={<RotateCcw size={12} />}
                  onClick={() => setColumns([])}
                >
                  Clear
                </Button>
              )}
              <Button
                size="sm"
                variant="primary"
                leadingIcon={<Send size={12} />}
                loading={running}
                disabled={prompt.trim().length === 0 || selected.length === 0}
                onClick={() => void run()}
              >
                Run
              </Button>
            </div>
          </div>
        </div>

        {columns.length > 0 && (
          <>
            <div
              className={cn(
                'grid gap-3',
                columns.length === 1
                  ? 'grid-cols-1'
                  : columns.length === 2
                    ? 'grid-cols-1 md:grid-cols-2'
                    : 'grid-cols-1 md:grid-cols-2 2xl:grid-cols-4',
              )}
            >
              {columns.map((column) => (
                <div
                  key={column.model}
                  className={cn(
                    'flex flex-col rounded-sb border bg-surface',
                    winner?.model === column.model ? 'border-accent-line' : 'border-line',
                  )}
                >
                  <div className="flex items-center gap-2 border-b border-line px-3 py-2">
                    <span className="min-w-0 flex-1 truncate font-mono text-[0.6875rem] text-ink">
                      {column.resolvedModel ?? column.model}
                    </span>
                    {winner?.model === column.model && (
                      <Trophy size={12} className="shrink-0 text-accent" />
                    )}
                    {!column.done && <span className="status-dot text-accent" data-live="true" />}
                  </div>

                  <div className="min-h-40 flex-1 overflow-y-auto px-3 py-2">
                    {column.error !== null ? (
                      <p className="text-xs text-down">{column.error}</p>
                    ) : column.text.length === 0 ? (
                      <p className="text-xs text-faint">
                        {column.done ? 'Empty response' : 'Waiting…'}
                      </p>
                    ) : (
                      <Markdown text={column.text} />
                    )}
                  </div>

                  <div className="grid grid-cols-4 gap-1 border-t border-line px-3 py-2 text-[0.625rem]">
                    <Metric label="TTFT" value={formatMs(column.ttftMs)} />
                    <Metric label="Total" value={formatMs(column.durationMs)} />
                    <Metric
                      label="Tokens"
                      value={
                        column.usage === null ? '—' : formatCompact(column.usage.completionTokens)
                      }
                    />
                    <Metric
                      label="Cost"
                      value={column.costUsd === 0 ? 'free' : formatUsd(column.costUsd)}
                      accent={column.costUsd === 0}
                    />
                  </div>
                </div>
              ))}
            </div>

            {columns.length > 1 && finished.length > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-sb border border-line bg-surface px-4 py-2.5">
                <p className="text-xs text-muted">
                  {winner !== null && (
                    <>
                      <span className="font-medium text-accent">
                        {winner.resolvedModel ?? winner.model}
                      </span>{' '}
                      finished first at {formatMs(winner.durationMs)}.
                    </>
                  )}
                </p>
                <p className="text-xs tabular text-muted">
                  Total for this comparison:{' '}
                  <span className="font-medium text-ink">{formatUsd(totalCost)}</span>
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function ModelRow({
  label,
  accent,
  free,
  checked,
  disabled,
  onToggle,
}: {
  id: string;
  label: string;
  accent: string;
  free: boolean;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      className={cn(
        'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left transition-colors',
        checked ? 'bg-accent-soft' : 'hover:bg-surface-2',
        disabled && 'cursor-not-allowed opacity-40',
      )}
    >
      <span
        className={cn(
          'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border',
          checked ? 'border-accent bg-accent text-on-accent' : 'border-line-strong',
        )}
      >
        {checked && <span className="text-[0.5rem] leading-none">✓</span>}
      </span>
      <span className="h-2 w-2 shrink-0 rounded-sm" style={{ backgroundColor: accent }} />
      <span className={cn('min-w-0 flex-1 truncate font-mono text-[0.6875rem]', checked ? 'text-accent' : 'text-ink')}>
        {label}
      </span>
      {free && (
        <Badge size="sm" tone="ok">
          free
        </Badge>
      )}
    </button>
  );
}

function Metric({
  label,
  value,
  accent = false,
}: {
  label: string;
  value: string;
  accent?: boolean;
}): React.ReactElement {
  return (
    <div>
      <p className="text-faint">{label}</p>
      <p className={cn('tabular', accent ? 'text-ok' : 'text-ink')}>{value}</p>
    </div>
  );
}
