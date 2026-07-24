'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { GripVertical, Plus, Trash2, X } from 'lucide-react';
import type { ChatFeature, Combo, ComboMember, ConnectionView, RoutingStrategy } from '@/types/core';
import { cn } from '@/lib/utils';
import {
  Badge,
  Button,
  Dialog,
  Field,
  Input,
  Select,
  Switch,
  Textarea,
  useToast,
} from '@/components/ui';
import { DecisionTrace } from './DecisionTrace';

const STRATEGIES: Array<{ value: RoutingStrategy; label: string; blurb: string }> = [
  {
    value: 'free-first',
    label: 'Free first',
    blurb: 'Exhaust free tiers before spending anything. Trades some latency for cost.',
  },
  {
    value: 'cost-optimized',
    label: 'Cost optimised',
    blurb: 'Lowest projected price per request, free or not.',
  },
  {
    value: 'fastest',
    label: 'Fastest',
    blurb: 'Lowest observed time to first token. Ignores price almost entirely.',
  },
  {
    value: 'quality-first',
    label: 'Quality first',
    blurb: 'Prefers stronger, pricier models. Use when the answer matters more than the bill.',
  },
  {
    value: 'priority',
    label: 'Priority order',
    blurb: 'Strictly your chain order. Predictable, but ignores live health signals.',
  },
  {
    value: 'round-robin',
    label: 'Round robin',
    blurb: 'Spreads load evenly across healthy members to stretch rate limits.',
  },
  {
    value: 'failover',
    label: 'Failover',
    blurb: 'Always the first member; others only when it fails outright.',
  },
];

const FEATURES: ChatFeature[] = ['tools', 'vision', 'json_mode', 'reasoning', 'streaming'];

export function PolicyEditor({
  combo,
  connections,
}: {
  combo: Combo;
  connections: ConnectionView[];
}): React.ReactElement {
  const router = useRouter();
  const { toast } = useToast();

  const [draft, setDraft] = useState<Combo>(combo);
  const [members, setMembers] = useState<ComboMember[]>(combo.members);
  const [revision, setRevision] = useState(0);
  const [picking, setPicking] = useState(false);
  const [dragging, setDragging] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const byConnection = new Map(connections.map((c) => [c.id, c]));

  const patch = async (body: Partial<Combo>): Promise<void> => {
    setDraft((current) => ({ ...current, ...body }));
    setBusy(true);
    try {
      const res = await fetch(`/api/combos/${combo.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? 'Save failed');
      setRevision((r) => r + 1);
      router.refresh();
    } catch (err) {
      toast({ title: 'Could not save', description: String(err), tone: 'down' });
      setDraft(combo);
    } finally {
      setBusy(false);
    }
  };

  const saveMembers = async (next: ComboMember[]): Promise<void> => {
    const ordered = next.map((member, index) => ({ ...member, order: index }));
    setMembers(ordered);
    try {
      const res = await fetch(`/api/combos/${combo.id}/members`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ members: ordered }),
      });
      if (!res.ok) throw new Error('Could not save the chain');
      setRevision((r) => r + 1);
      router.refresh();
    } catch (err) {
      toast({ title: 'Could not save chain', description: String(err), tone: 'down' });
    }
  };

  const move = (from: number, to: number): void => {
    if (to < 0 || to >= members.length) return;
    const next = [...members];
    const [item] = next.splice(from, 1);
    if (item === undefined) return;
    next.splice(to, 0, item);
    void saveMembers(next);
  };

  return (
    <div className="grid gap-5 xl:grid-cols-2">
      <div className="space-y-4">
        <div className="space-y-3 rounded-sb border border-line bg-surface p-4">
          <Field label="Name">
            {(id) => (
              <Input
                id={id}
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                onBlur={() => void patch({ name: draft.name })}
              />
            )}
          </Field>

          <Field
            label="Slug"
            hint={`Clients send this as the model: "${draft.slug}"`}
          >
            {(id) => (
              <Input
                id={id}
                mono
                value={draft.slug}
                onChange={(event) => setDraft({ ...draft, slug: event.target.value })}
                onBlur={() => void patch({ slug: draft.slug })}
              />
            )}
          </Field>

          <Field label="Description">
            {(id) => (
              <Textarea
                id={id}
                rows={2}
                value={draft.description}
                onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                onBlur={() => void patch({ description: draft.description })}
              />
            )}
          </Field>
        </div>

        <div className="space-y-2 rounded-sb border border-line bg-surface p-4">
          <p className="text-xs font-medium text-ink">Strategy</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {STRATEGIES.map((strategy) => (
              <button
                key={strategy.value}
                type="button"
                onClick={() => void patch({ strategy: strategy.value })}
                className={cn(
                  'rounded-sb border p-2.5 text-left transition-colors',
                  draft.strategy === strategy.value
                    ? 'border-accent-line bg-accent-soft'
                    : 'border-line hover:bg-surface-2',
                )}
              >
                <p
                  className={cn(
                    'text-xs font-medium',
                    draft.strategy === strategy.value ? 'text-accent' : 'text-ink',
                  )}
                >
                  {strategy.label}
                </p>
                <p className="mt-0.5 text-[0.6875rem] leading-relaxed text-muted">{strategy.blurb}</p>
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-3 rounded-sb border border-line bg-surface p-4">
          <p className="text-xs font-medium text-ink">Constraints</p>

          <div>
            <p className="mb-1.5 text-xs text-muted">Required capabilities</p>
            <div className="flex flex-wrap gap-1.5">
              {FEATURES.map((feature) => {
                const on = draft.requires.includes(feature);
                return (
                  <button
                    key={feature}
                    type="button"
                    onClick={() =>
                      void patch({
                        requires: on
                          ? draft.requires.filter((f) => f !== feature)
                          : [...draft.requires, feature],
                      })
                    }
                    className={cn(
                      'rounded-full border px-2.5 py-1 text-[0.6875rem] font-medium transition-colors',
                      on
                        ? 'border-accent-line bg-accent-soft text-accent'
                        : 'border-line text-muted hover:text-ink',
                    )}
                  >
                    {feature}
                  </button>
                );
              })}
            </div>
          </div>

          <Field
            label="Cost ceiling (USD per 1M tokens)"
            hint="Candidates priced above this are excluded. Set 0 to allow only free models."
          >
            {(id) => (
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={0}
                  max={50}
                  step={0.5}
                  value={draft.maxCostPerMTok ?? 50}
                  onChange={(event) =>
                    setDraft({ ...draft, maxCostPerMTok: Number(event.target.value) })
                  }
                  onMouseUp={() => void patch({ maxCostPerMTok: draft.maxCostPerMTok })}
                  onTouchEnd={() => void patch({ maxCostPerMTok: draft.maxCostPerMTok })}
                  className="h-1 flex-1 cursor-pointer appearance-none rounded-full bg-surface-3 accent-[var(--sb-accent)]"
                />
                <Input
                  id={id}
                  type="number"
                  className="w-20"
                  value={draft.maxCostPerMTok ?? ''}
                  placeholder="none"
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      maxCostPerMTok: event.target.value === '' ? null : Number(event.target.value),
                    })
                  }
                  onBlur={() => void patch({ maxCostPerMTok: draft.maxCostPerMTok })}
                />
              </div>
            )}
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Max attempts">
              {(id) => (
                <Select
                  id={id}
                  value={String(draft.maxAttempts)}
                  onChange={(event) => void patch({ maxAttempts: Number(event.target.value) })}
                >
                  {[1, 2, 3, 4, 5, 6, 8, 10].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Timeout (seconds)">
              {(id) => (
                <Input
                  id={id}
                  type="number"
                  value={Math.round(draft.timeoutMs / 1000)}
                  onChange={(event) =>
                    setDraft({ ...draft, timeoutMs: Number(event.target.value) * 1000 })
                  }
                  onBlur={() => void patch({ timeoutMs: draft.timeoutMs })}
                />
              )}
            </Field>
          </div>

          <div className="flex items-center justify-between border-t border-line pt-3">
            <div>
              <p className="text-xs font-medium text-ink">Default policy</p>
              <p className="text-[0.6875rem] text-muted">
                Used when a client sends &quot;auto&quot; or an unknown model.
              </p>
            </div>
            <Switch
              checked={draft.isDefault}
              onCheckedChange={(v) => void patch({ isDefault: v })}
              label="Default policy"
            />
          </div>
        </div>

        <div className="rounded-sb border border-line bg-surface">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <div>
              <p className="text-xs font-medium text-ink">Member chain</p>
              <p className="text-[0.6875rem] text-muted">
                {members.length === 0
                  ? 'Empty — every eligible connection is considered.'
                  : 'Tried in this order under priority and failover strategies.'}
              </p>
            </div>
            <Button size="sm" variant="secondary" leadingIcon={<Plus size={12} />} onClick={() => setPicking(true)}>
              Add
            </Button>
          </div>

          {members.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-faint">
              No members pinned. The router will consider every connection that can serve this
              modality.
            </p>
          ) : (
            <ul className="divide-y divide-line">
              {members.map((member, index) => {
                const connection = byConnection.get(member.connectionId);
                return (
                  <li
                    key={`${member.connectionId}:${member.modelId}`}
                    draggable
                    onDragStart={() => setDragging(index)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={() => {
                      if (dragging !== null && dragging !== index) move(dragging, index);
                      setDragging(null);
                    }}
                    className={cn(
                      'flex items-center gap-2 px-3 py-2',
                      dragging === index && 'opacity-40',
                    )}
                  >
                    <GripVertical size={13} className="shrink-0 cursor-grab text-faint" />
                    <span className="w-5 shrink-0 text-[0.625rem] tabular text-faint">{index + 1}</span>
                    <span
                      className="h-2 w-2 shrink-0 rounded-sm"
                      style={{ backgroundColor: connection?.provider.accent ?? '#888' }}
                      aria-hidden="true"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-mono text-xs text-ink">{member.modelId}</p>
                      <p className="text-[0.625rem] text-faint">{connection?.label ?? 'missing connection'}</p>
                    </div>
                    {/* Keyboard reordering: a drag-only list is unusable without a mouse. */}
                    <button
                      type="button"
                      aria-label="Move up"
                      onClick={() => move(index, index - 1)}
                      disabled={index === 0}
                      className="rounded p-1 text-faint transition-colors hover:text-ink disabled:opacity-30"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      aria-label="Move down"
                      onClick={() => move(index, index + 1)}
                      disabled={index === members.length - 1}
                      className="rounded p-1 text-faint transition-colors hover:text-ink disabled:opacity-30"
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      aria-label="Remove"
                      onClick={() => void saveMembers(members.filter((_, i) => i !== index))}
                      className="rounded p-1 text-faint transition-colors hover:text-down"
                    >
                      <X size={13} />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <DeleteSection comboId={combo.id} name={combo.name} />
      </div>

      <div className="xl:sticky xl:top-4 xl:self-start">
        <DecisionTrace comboId={combo.id} revision={revision} />
      </div>

      <MemberPicker
        open={picking}
        onClose={() => setPicking(false)}
        connections={connections}
        existing={members}
        onAdd={(member) => void saveMembers([...members, member])}
      />
    </div>
  );
}

function MemberPicker({
  open,
  onClose,
  connections,
  existing,
  onAdd,
}: {
  open: boolean;
  onClose: () => void;
  connections: ConnectionView[];
  existing: ComboMember[];
  onAdd: (member: ComboMember) => void;
}): React.ReactElement {
  const [query, setQuery] = useState('');
  const taken = new Set(existing.map((m) => `${m.connectionId}:${m.modelId}`));

  const options = connections.flatMap((connection) =>
    connection.provider.models
      .filter((model) => {
        if (taken.has(`${connection.id}:${model.id}`)) return false;
        const q = query.trim().toLowerCase();
        return q.length === 0 || `${connection.label} ${model.id}`.toLowerCase().includes(q);
      })
      .map((model) => ({ connection, model })),
  );

  return (
    <Dialog open={open} onClose={onClose} title="Add to chain" size="md">
      <Input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Filter by provider or model…"
        className="mb-3"
      />
      <div className="max-h-80 space-y-1 overflow-y-auto">
        {options.length === 0 ? (
          <p className="py-6 text-center text-xs text-faint">Nothing left to add.</p>
        ) : (
          options.map(({ connection, model }) => (
            <button
              key={`${connection.id}:${model.id}`}
              type="button"
              onClick={() => {
                onAdd({
                  connectionId: connection.id,
                  modelId: model.id,
                  order: existing.length,
                  weight: 1,
                  enabled: true,
                });
                onClose();
              }}
              className="flex w-full items-center gap-2 rounded-sb px-2.5 py-2 text-left transition-colors hover:bg-surface-2"
            >
              <span
                className="h-2 w-2 shrink-0 rounded-sm"
                style={{ backgroundColor: connection.provider.accent }}
                aria-hidden="true"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono text-xs text-ink">{model.id}</p>
                <p className="text-[0.625rem] text-faint">{connection.label}</p>
              </div>
              <Badge size="sm" tone={model.inputCostPerMTok === 0 ? 'ok' : 'neutral'}>
                ${model.inputCostPerMTok.toFixed(2)}
              </Badge>
            </button>
          ))
        )}
      </div>
    </Dialog>
  );
}

function DeleteSection({ comboId, name }: { comboId: string; name: string }): React.ReactElement {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button variant="ghost" size="sm" leadingIcon={<Trash2 size={13} />} onClick={() => setOpen(true)}>
        Delete this policy
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={`Delete "${name}"?`}
        description="Clients still sending this slug will fall back to the default policy."
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={async () => {
                await fetch(`/api/combos/${comboId}`, { method: 'DELETE' });
                toast({ title: 'Policy deleted', tone: 'ok' });
                router.push('/dashboard/routing');
              }}
            >
              Delete
            </Button>
          </>
        }
      >
        <p className="text-xs text-muted">This cannot be undone.</p>
      </Dialog>
    </>
  );
}
