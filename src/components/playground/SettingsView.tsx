'use client';

import { useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Download } from 'lucide-react';
import type { Settings } from '@/types/core';
import { cn } from '@/lib/utils';
import {
  Button,
  CopyButton,
  Dialog,
  Input,
  Select,
  Switch,
  useToast,
} from '@/components/ui';
import { ThemeToggle } from '@/components/theme/ThemeToggle';

export function SettingsView({
  settings,
  comboSlugs,
  dataDir,
  dbSizeBytes,
}: {
  settings: Settings;
  comboSlugs: string[];
  dataDir: string;
  dbSizeBytes: number;
}): React.ReactElement {
  const router = useRouter();
  const { toast } = useToast();
  const [draft, setDraft] = useState<Settings>(settings);
  const [confirming, setConfirming] = useState<null | 'logs' | 'breakers'>(null);

  const save = async (patch: Partial<Settings>): Promise<void> => {
    const previous = draft;
    // Optimistic: the control moves immediately and reverts only if the write
    // actually fails, which keeps toggles from feeling laggy.
    setDraft((current) => ({ ...current, ...patch }));
    try {
      const res = await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? 'Save failed');
      toast({ title: 'Saved', tone: 'ok' });
      router.refresh();
    } catch (err) {
      setDraft(previous);
      toast({ title: 'Could not save', description: String(err), tone: 'down' });
    }
  };

  const clearLogs = async (): Promise<void> => {
    const res = await fetch('/api/logs', { method: 'DELETE' });
    const body = (await res.json()) as { deleted?: number };
    toast({ title: `Cleared ${body.deleted ?? 0} log entries`, tone: 'ok' });
    setConfirming(null);
    router.refresh();
  };

  const exportConfig = async (): Promise<void> => {
    const [connections, combos] = await Promise.all([
      fetch('/api/connections').then((r) => r.json() as Promise<{ items: unknown[] }>),
      fetch('/api/combos').then((r) => r.json() as Promise<{ items: unknown[] }>),
    ]);

    const payload = {
      exportedAt: new Date().toISOString(),
      note: 'API credentials are deliberately excluded from this export.',
      settings: draft,
      connections: connections.items,
      combos: combos.items,
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'switchboard-config.json';
    link.click();
    URL.revokeObjectURL(url);
    toast({ title: 'Config exported', description: 'Credentials were not included.', tone: 'ok' });
  };

  return (
    <div className="max-w-3xl space-y-5">
      <div>
        <h1 className="text-lg font-semibold tracking-tight text-ink">Settings</h1>
        <p className="mt-0.5 text-sm text-muted">Gateway behaviour, stored locally.</p>
      </div>

      <Section title="Routing">
        <Row label="Default policy" hint="Used when a client sends “auto” or a model nothing recognises.">
          <Select
            value={draft.defaultCombo}
            onChange={(event) => void save({ defaultCombo: event.target.value })}
            className="w-44"
          >
            {comboSlugs.map((slug) => (
              <option key={slug} value={slug}>
                {slug}
              </option>
            ))}
          </Select>
        </Row>
        <Row
          label="Prefer free tiers"
          hint="Applies the free-first ladder even when a policy does not ask for it."
        >
          <Switch
            checked={draft.preferFreeTiers}
            onCheckedChange={(v) => void save({ preferFreeTiers: v })}
            label="Prefer free tiers"
          />
        </Row>
        <Row label="Default timeout" hint="Per upstream attempt, in seconds.">
          <Input
            type="number"
            className="w-24"
            value={Math.round(draft.defaultTimeoutMs / 1000)}
            onChange={(event) =>
              setDraft({ ...draft, defaultTimeoutMs: Number(event.target.value) * 1000 })
            }
            onBlur={() => void save({ defaultTimeoutMs: draft.defaultTimeoutMs })}
          />
        </Row>
      </Section>

      <Section title="Resilience">
        <Row
          label="Failure threshold"
          hint="Consecutive failures before a provider's breaker opens and it is skipped."
        >
          <Input
            type="number"
            className="w-24"
            value={draft.breakerFailureThreshold}
            onChange={(event) =>
              setDraft({ ...draft, breakerFailureThreshold: Number(event.target.value) })
            }
            onBlur={() => void save({ breakerFailureThreshold: draft.breakerFailureThreshold })}
          />
        </Row>
        <Row label="Cooldown" hint="Base wait before retrying a failed provider. Doubles on repeat failures.">
          <Input
            type="number"
            className="w-24"
            value={Math.round(draft.breakerCooldownMs / 1000)}
            onChange={(event) =>
              setDraft({ ...draft, breakerCooldownMs: Number(event.target.value) * 1000 })
            }
            onBlur={() => void save({ breakerCooldownMs: draft.breakerCooldownMs })}
          />
        </Row>
        <Row label="Health probe interval" hint="Seconds between background checks. 0 turns probing off.">
          <Input
            type="number"
            className="w-24"
            value={draft.healthProbeIntervalSec}
            onChange={(event) =>
              setDraft({ ...draft, healthProbeIntervalSec: Number(event.target.value) })
            }
            onBlur={() => void save({ healthProbeIntervalSec: draft.healthProbeIntervalSec })}
          />
        </Row>
      </Section>

      <Section title="Logging">
        <Row
          label="Store request payloads"
          hint="Enables replay and the payload inspector. This writes your prompts to disk in plain text."
        >
          <Switch
            checked={draft.logPayloads}
            onCheckedChange={(v) => void save({ logPayloads: v })}
            label="Store payloads"
          />
        </Row>
        <Row label="Retention" hint="Days of history to keep. 0 keeps everything forever.">
          <Input
            type="number"
            className="w-24"
            value={draft.logRetentionDays}
            onChange={(event) => setDraft({ ...draft, logRetentionDays: Number(event.target.value) })}
            onBlur={() => void save({ logRetentionDays: draft.logRetentionDays })}
          />
        </Row>
      </Section>

      <Section title="Appearance">
        <Row label="Theme" hint="Light and dark are designed separately, not derived from each other.">
          <ThemeToggle />
        </Row>
      </Section>

      <Section title="Data">
        <Row label="Data directory" hint="Where the database, key vault and logs live.">
          <div className="flex items-center gap-1.5">
            <code className="max-w-64 truncate font-mono text-[0.6875rem] text-muted">{dataDir}</code>
            <CopyButton value={dataDir} size={11} />
          </div>
        </Row>
        <Row label="Database size">
          <span className="text-xs tabular text-muted">
            {(dbSizeBytes / 1024 / 1024).toFixed(2)} MB
          </span>
        </Row>
        <Row label="Export configuration" hint="Providers, policies and settings as JSON. Credentials are excluded.">
          <Button size="sm" variant="secondary" leadingIcon={<Download size={12} />} onClick={() => void exportConfig()}>
            Export
          </Button>
        </Row>
      </Section>

      <div className="rounded-sb border border-down/30 bg-surface">
        <div className="border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold text-down">Danger zone</h2>
        </div>
        <div className="divide-y divide-line">
          <Row label="Clear request log" hint="Deletes every logged request and its stored payloads.">
            <Button size="sm" variant="danger" onClick={() => setConfirming('logs')}>
              Clear log
            </Button>
          </Row>
          <Row label="Reset all breakers" hint="Marks every provider healthy again and clears cooldowns.">
            <Button
              size="sm"
              variant="secondary"
              onClick={async () => {
                const res = await fetch('/api/health');
                const body = (await res.json()) as { items: Array<{ connectionId: string }> };
                await Promise.all(
                  body.items.map((item) =>
                    fetch(`/api/health/${item.connectionId}/reset`, { method: 'POST' }),
                  ),
                );
                toast({ title: 'All breakers reset', tone: 'ok' });
                router.refresh();
              }}
            >
              Reset breakers
            </Button>
          </Row>
        </div>
      </div>

      <Dialog
        open={confirming === 'logs'}
        onClose={() => setConfirming(null)}
        title="Clear the request log?"
        description="Every logged request, decision trace and stored payload is deleted. Usage totals are kept."
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setConfirming(null)}>
              Cancel
            </Button>
            <Button variant="danger" size="sm" onClick={() => void clearLogs()}>
              Delete everything
            </Button>
          </>
        }
      >
        <p className="text-xs text-muted">This cannot be undone.</p>
      </Dialog>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }): React.ReactElement {
  return (
    <div className="rounded-sb border border-line bg-surface">
      <div className="border-b border-line px-4 py-3">
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
      </div>
      <div className="divide-y divide-line">{children}</div>
    </div>
  );
}

function Row({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <div className={cn('flex items-center justify-between gap-6 px-4 py-3', className)}>
      <div className="min-w-0">
        <p className="text-xs font-medium text-ink">{label}</p>
        {hint !== undefined && <p className="mt-0.5 text-[0.6875rem] leading-relaxed text-muted">{hint}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
