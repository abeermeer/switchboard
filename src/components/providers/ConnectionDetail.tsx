'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { RefreshCw, Trash2, Zap } from 'lucide-react';
import type { CatalogModel, ConnectionView, ModelLockout } from '@/types/core';
import { cn, formatMs, formatPercent, formatUsd, relativeTime } from '@/lib/utils';
import {
  Badge,
  Button,
  Dialog,
  Field,
  Input,
  Meter,
  StatusDot,
  Switch,
  Table,
  Tabs,
  TBody,
  TD,
  TH,
  THead,
  TR,
  useToast,
} from '@/components/ui';

interface Props {
  connection: ConnectionView;
  models: CatalogModel[];
  lockouts: ModelLockout[];
  monthToDateUsd: number;
}

export function ConnectionDetail({
  connection,
  models,
  lockouts,
  monthToDateUsd,
}: Props): React.ReactElement {
  const router = useRouter();
  const { toast } = useToast();

  const [tab, setTab] = useState('models');
  const [busy, setBusy] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [confirmText, setConfirmText] = useState('');
  const [confirming, setConfirming] = useState(false);

  const lockedIds = new Set(lockouts.map((l) => l.modelId));

  const patch = async (body: Record<string, unknown>, message: string): Promise<void> => {
    setBusy(true);
    try {
      const res = await fetch(`/api/connections/${connection.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? 'Update failed');
      toast({ title: message, tone: 'ok' });
      router.refresh();
    } catch (err) {
      toast({ title: 'Could not save', description: String(err), tone: 'down' });
    } finally {
      setBusy(false);
    }
  };

  const probe = async (): Promise<void> => {
    setBusy(true);
    try {
      const res = await fetch(`/api/connections/${connection.id}/test`, { method: 'POST' });
      const result = (await res.json()) as { ok: boolean; latencyMs: number; error: string | null };
      toast({
        title: result.ok ? `Responded in ${formatMs(result.latencyMs)}` : 'Probe failed',
        description: result.error ?? undefined,
        tone: result.ok ? 'ok' : 'down',
      });
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  const resetBreaker = async (): Promise<void> => {
    await fetch(`/api/health/${connection.id}/reset`, { method: 'POST' });
    toast({ title: 'Breaker reset', tone: 'ok' });
    router.refresh();
  };

  const saveKey = async (): Promise<void> => {
    setBusy(true);
    try {
      const res = await fetch(`/api/connections/${connection.id}/credential`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apiKey: newKey.trim() }),
      });
      if (!res.ok) throw new Error('Could not save the key');
      toast({ title: 'API key replaced', tone: 'ok' });
      setReplacing(false);
      setNewKey('');
      router.refresh();
    } catch (err) {
      toast({ title: 'Failed', description: String(err), tone: 'down' });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    await fetch(`/api/connections/${connection.id}`, { method: 'DELETE' });
    toast({ title: `${connection.label} removed`, tone: 'ok' });
    router.push('/dashboard/providers');
  };

  const refreshModels = async (): Promise<void> => {
    setBusy(true);
    try {
      const res = await fetch(`/api/connections/${connection.id}/models`, { method: 'POST' });
      const body = (await res.json()) as { discovered?: number; error?: string };
      if (!res.ok) throw new Error(body.error ?? 'Refresh failed');
      toast({ title: `Discovered ${body.discovered ?? 0} models`, tone: 'ok' });
      router.refresh();
    } catch (err) {
      toast({ title: 'Could not refresh', description: String(err), tone: 'down' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="relative overflow-hidden rounded-sb border border-line bg-surface">
        <span
          className="absolute inset-x-0 top-0 h-1"
          style={{ backgroundColor: connection.provider.accent }}
          aria-hidden="true"
        />
        <div className="p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2.5">
                <h1 className="text-lg font-semibold tracking-tight text-ink">{connection.label}</h1>
                <StatusDot status={connection.status} withLabel />
              </div>
              <p className="mt-1 text-sm text-muted">
                {connection.provider.name} ·{' '}
                <code className="font-mono text-xs">
                  {connection.baseUrlOverride ?? connection.provider.baseUrl}
                </code>
              </p>
            </div>

            <div className="flex items-center gap-2">
              <Button size="sm" leadingIcon={<Zap size={13} />} onClick={() => void probe()} loading={busy}>
                Probe now
              </Button>
              {connection.health.breaker !== 'closed' && (
                <Button size="sm" variant="secondary" onClick={() => void resetBreaker()}>
                  Reset breaker
                </Button>
              )}
            </div>
          </div>

          <div className="mt-5 grid gap-4 border-t border-line pt-4 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <p className="text-xs text-faint">Enabled</p>
              <div className="mt-1.5">
                <Switch
                  checked={connection.enabled}
                  onCheckedChange={(v) => void patch({ enabled: v }, v ? 'Connection enabled' : 'Connection disabled')}
                  label="Enabled"
                />
              </div>
            </div>

            <div>
              <p className="text-xs text-faint">Credential</p>
              <div className="mt-1.5 flex items-center gap-2">
                {connection.hasCredential ? (
                  <>
                    <code className="font-mono text-xs text-ink">sb-…{connection.provider.id.slice(0, 2)}••</code>
                    <button
                      type="button"
                      onClick={() => setReplacing(true)}
                      className="text-[0.6875rem] text-accent underline underline-offset-2"
                    >
                      replace
                    </button>
                  </>
                ) : (
                  <Button size="sm" variant="secondary" onClick={() => setReplacing(true)}>
                    Add key
                  </Button>
                )}
              </div>
            </div>

            <div>
              <p className="text-xs text-faint">Priority</p>
              <p className="mt-1.5 text-sm tabular text-ink">{connection.priority}</p>
            </div>

            <div>
              <Meter
                label="This month"
                value={monthToDateUsd}
                limit={connection.monthlyBudgetUsd}
                currency
              />
            </div>
          </div>
        </div>
      </div>

      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { value: 'models', label: 'Models', count: models.length },
          { value: 'health', label: 'Health' },
          { value: 'usage', label: 'Usage' },
        ]}
      />

      {tab === 'models' && (
        <div className="rounded-sb border border-line bg-surface">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <p className="text-xs text-muted">Catalog pricing, per 1M tokens</p>
            <Button size="sm" variant="ghost" leadingIcon={<RefreshCw size={12} />} onClick={() => void refreshModels()} loading={busy}>
              Refresh from provider
            </Button>
          </div>
          <Table>
            <THead>
              <TR>
                <TH>Model</TH>
                <TH>Modality</TH>
                <TH align="right">Context</TH>
                <TH align="right">Input</TH>
                <TH align="right">Output</TH>
                <TH>Features</TH>
              </TR>
            </THead>
            <TBody>
              {models.map((model) => (
                <TR key={model.id}>
                  <TD mono>
                    <div className="flex items-center gap-2">
                      <span>{model.id}</span>
                      {lockedIds.has(model.id) && (
                        <Badge tone="warn" size="sm">
                          locked out
                        </Badge>
                      )}
                    </div>
                  </TD>
                  <TD className="text-muted">{model.modality}</TD>
                  <TD align="right">{(model.contextWindow / 1000).toFixed(0)}K</TD>
                  <TD align="right">
                    {model.inputCostPerMTok === 0 ? (
                      <span className="text-ok">free</span>
                    ) : (
                      `$${model.inputCostPerMTok.toFixed(2)}`
                    )}
                  </TD>
                  <TD align="right">
                    {model.outputCostPerMTok === 0 ? (
                      <span className="text-ok">free</span>
                    ) : (
                      `$${model.outputCostPerMTok.toFixed(2)}`
                    )}
                  </TD>
                  <TD>
                    <div className="flex flex-wrap gap-1">
                      {model.features.map((feature) => (
                        <Badge key={feature} size="sm">
                          {feature}
                        </Badge>
                      ))}
                    </div>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      )}

      {tab === 'health' && (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-3 rounded-sb border border-line bg-surface p-4">
            <h3 className="text-sm font-semibold text-ink">Circuit state</h3>
            <dl className="space-y-2 text-xs">
              <DetailRow label="Breaker" value={connection.health.breaker} />
              <DetailRow label="Success rate" value={formatPercent(connection.health.successRate)} />
              <DetailRow label="Consecutive failures" value={String(connection.health.consecutiveFailures)} />
              <DetailRow label="p50 latency" value={formatMs(connection.health.p50LatencyMs)} />
              <DetailRow label="p95 latency" value={formatMs(connection.health.p95LatencyMs)} />
              <DetailRow label="Last checked" value={relativeTime(connection.health.lastCheckedAt)} />
              {connection.health.cooldownUntil !== null && (
                <DetailRow label="Cooldown ends" value={relativeTime(connection.health.cooldownUntil)} />
              )}
            </dl>
          </div>

          <div className="space-y-3 rounded-sb border border-line bg-surface p-4">
            <h3 className="text-sm font-semibold text-ink">Last error</h3>
            {connection.health.lastError === null ? (
              <p className="text-xs text-muted">No errors recorded.</p>
            ) : (
              <pre className="overflow-x-auto rounded-sb bg-surface-2 p-3 font-mono text-[0.6875rem] leading-relaxed text-down">
                {connection.health.lastError}
              </pre>
            )}
          </div>
        </div>
      )}

      {tab === 'usage' && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <UsageTile label="Requests (24h)" value={String(connection.usage.requests)} />
          <UsageTile label="Successes" value={String(connection.usage.successes)} />
          <UsageTile label="Spend (24h)" value={formatUsd(connection.usage.costUsd)} />
          <UsageTile label="Saved (24h)" value={formatUsd(connection.usage.savedUsd)} accent />
        </div>
      )}

      <div className="rounded-sb border border-down/30 bg-surface p-4">
        <h3 className="text-sm font-semibold text-down">Danger zone</h3>
        <p className="mt-1 text-xs text-muted">
          Removing this connection deletes its stored credential and drops it from every routing
          policy. Usage history is kept.
        </p>
        <Button
          variant="danger"
          size="sm"
          className="mt-3"
          leadingIcon={<Trash2 size={13} />}
          onClick={() => setConfirming(true)}
        >
          Remove connection
        </Button>
      </div>

      <Dialog
        open={replacing}
        onClose={() => setReplacing(false)}
        title={connection.hasCredential ? 'Replace API key' : 'Add API key'}
        description={`This key is sealed with AES-256-GCM before it touches disk.`}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setReplacing(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={busy}
              disabled={newKey.trim().length === 0}
              onClick={() => void saveKey()}
            >
              Save key
            </Button>
          </>
        }
      >
        <Field label="API key" required>
          {(id) => (
            <Input
              id={id}
              mono
              type="password"
              value={newKey}
              onChange={(event) => setNewKey(event.target.value)}
              autoComplete="off"
            />
          )}
        </Field>
      </Dialog>

      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title={`Remove ${connection.label}?`}
        description="Type the connection label to confirm. This cannot be undone."
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              disabled={confirmText !== connection.label}
              onClick={() => void remove()}
            >
              Remove permanently
            </Button>
          </>
        }
      >
        <Field label={`Type "${connection.label}"`}>
          {(id) => (
            <Input
              id={id}
              value={confirmText}
              onChange={(event) => setConfirmText(event.target.value)}
              placeholder={connection.label}
            />
          )}
        </Field>
      </Dialog>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div className="flex justify-between gap-4 border-b border-line pb-2 last:border-0">
      <dt className="text-muted">{label}</dt>
      <dd className={cn('tabular text-ink')}>{value}</dd>
    </div>
  );
}

function UsageTile({
  label,
  value,
  accent = false,
}: {
  label: string;
  value: string;
  accent?: boolean;
}): React.ReactElement {
  return (
    <div className="rounded-sb border border-line bg-surface p-4">
      <p className="text-xs text-muted">{label}</p>
      <p className={cn('mt-1.5 text-xl font-semibold tabular', accent ? 'text-ok' : 'text-ink')}>
        {value}
      </p>
    </div>
  );
}
