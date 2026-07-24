'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { KeyRound, Plus, Trash2 } from 'lucide-react';
import type { ApiKey } from '@/types/core';
import { cn, relativeTime } from '@/lib/utils';
import {
  Badge,
  Button,
  CopyButton,
  Dialog,
  EmptyState,
  Field,
  Input,
  Meter,
  Select,
  Switch,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  useToast,
} from '@/components/ui';

type KeyRow = ApiKey & { spentThisMonthUsd: number };

export function KeysView({
  keys,
  comboSlugs,
}: {
  keys: KeyRow[];
  comboSlugs: string[];
}): React.ReactElement {
  const router = useRouter();
  const { toast } = useToast();

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [budget, setBudget] = useState('');
  const [rateLimit, setRateLimit] = useState('');
  const [onExceeded, setOnExceeded] = useState<'block' | 'downgrade-to-free'>('downgrade-to-free');
  const [allowed, setAllowed] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<KeyRow | null>(null);
  const [confirmText, setConfirmText] = useState('');

  const create = async (): Promise<void> => {
    setBusy(true);
    try {
      const res = await fetch('/api/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          allowedCombos: allowed,
          monthlyBudgetUsd: budget.trim().length > 0 ? Number(budget) : null,
          rateLimitPerMin: rateLimit.trim().length > 0 ? Number(rateLimit) : null,
          onBudgetExceeded: onExceeded,
        }),
      });
      const body = (await res.json()) as { secret?: string; error?: string };
      if (!res.ok) throw new Error(body.error ?? 'Could not create the key');

      setSecret(body.secret ?? null);
      setCreating(false);
      setName('');
      setBudget('');
      setRateLimit('');
      setAllowed([]);
      router.refresh();
    } catch (err) {
      toast({ title: 'Failed', description: String(err), tone: 'down' });
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (key: KeyRow): Promise<void> => {
    await fetch(`/api/keys/${key.id}`, { method: 'DELETE' });
    toast({ title: `${key.name} revoked`, tone: 'ok' });
    setRevoking(null);
    setConfirmText('');
    router.refresh();
  };

  const toggleEnabled = async (key: KeyRow, enabled: boolean): Promise<void> => {
    await fetch(`/api/keys/${key.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    router.refresh();
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-ink">API keys</h1>
          <p className="mt-0.5 text-sm text-muted">
            What your tools authenticate with. Each key carries its own budget and rate limit.
          </p>
        </div>
        <Button variant="primary" size="sm" leadingIcon={<Plus size={13} />} onClick={() => setCreating(true)}>
          New key
        </Button>
      </div>

      {keys.length === 0 ? (
        <EmptyState
          icon={<KeyRound size={16} />}
          title="No API keys yet"
          description="Until you create one the gateway runs open on localhost, which is fine for testing but not for anything you expose."
          action={
            <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
              Create your first key
            </Button>
          }
        />
      ) : (
        <div className="rounded-sb border border-line bg-surface">
          <Table>
            <THead>
              <TR>
                <TH>Name</TH>
                <TH>Prefix</TH>
                <TH>Policies</TH>
                <TH>Budget</TH>
                <TH align="right">Rate limit</TH>
                <TH>Last used</TH>
                <TH align="right">Enabled</TH>
                <TH />
              </TR>
            </THead>
            <TBody>
              {keys.map((key) => (
                <TR key={key.id}>
                  <TD className="font-medium">{key.name}</TD>
                  <TD mono className="text-muted">
                    {key.prefix}…
                  </TD>
                  <TD>
                    {key.allowedCombos.length === 0 ? (
                      <span className="text-xs text-faint">all</span>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {key.allowedCombos.map((slug) => (
                          <Badge key={slug} size="sm">
                            {slug}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </TD>
                  <TD className="w-40">
                    <Meter value={key.spentThisMonthUsd} limit={key.monthlyBudgetUsd} currency />
                  </TD>
                  <TD align="right" className="text-muted">
                    {key.rateLimitPerMin === null ? '—' : `${key.rateLimitPerMin}/min`}
                  </TD>
                  <TD className="text-muted">{relativeTime(key.lastUsedAt)}</TD>
                  <TD align="right">
                    <Switch
                      size="sm"
                      checked={key.enabled}
                      onCheckedChange={(v) => void toggleEnabled(key, v)}
                      label={`Enable ${key.name}`}
                    />
                  </TD>
                  <TD align="right">
                    <button
                      type="button"
                      onClick={() => setRevoking(key)}
                      aria-label={`Revoke ${key.name}`}
                      className="rounded p-1 text-faint transition-colors hover:text-down"
                    >
                      <Trash2 size={13} />
                    </button>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      )}

      <Dialog
        open={creating}
        onClose={() => setCreating(false)}
        title="New API key"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={busy}
              disabled={name.trim().length === 0}
              onClick={() => void create()}
            >
              Create key
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Name" required hint="How you will recognise this key later.">
            {(id) => (
              <Input
                id={id}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Cursor on my laptop"
              />
            )}
          </Field>

          <Field
            label="Allowed policies"
            hint="Leave all unselected to permit every policy."
          >
            {() => (
              <div className="flex flex-wrap gap-1.5">
                {comboSlugs.map((slug) => {
                  const on = allowed.includes(slug);
                  return (
                    <button
                      key={slug}
                      type="button"
                      onClick={() =>
                        setAllowed((current) =>
                          on ? current.filter((s) => s !== slug) : [...current, slug],
                        )
                      }
                      className={cn(
                        'rounded-full border px-2.5 py-1 text-[0.6875rem] font-medium transition-colors',
                        on
                          ? 'border-accent-line bg-accent-soft text-accent'
                          : 'border-line text-muted hover:text-ink',
                      )}
                    >
                      {slug}
                    </button>
                  );
                })}
              </div>
            )}
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Monthly budget (USD)" hint="Blank means unlimited.">
              {(id) => (
                <Input
                  id={id}
                  type="number"
                  value={budget}
                  onChange={(event) => setBudget(event.target.value)}
                  placeholder="unlimited"
                />
              )}
            </Field>
            <Field label="Rate limit (per minute)" hint="Blank means unlimited.">
              {(id) => (
                <Input
                  id={id}
                  type="number"
                  value={rateLimit}
                  onChange={(event) => setRateLimit(event.target.value)}
                  placeholder="unlimited"
                />
              )}
            </Field>
          </div>

          <Field label="When the budget runs out">
            {(id) => (
              <Select
                id={id}
                value={onExceeded}
                onChange={(event) =>
                  setOnExceeded(event.target.value as 'block' | 'downgrade-to-free')
                }
              >
                <option value="downgrade-to-free">
                  Downgrade to free providers — keeps working, costs nothing
                </option>
                <option value="block">Block — return 429 until next month</option>
              </Select>
            )}
          </Field>
        </div>
      </Dialog>

      <Dialog
        open={secret !== null}
        onClose={() => setSecret(null)}
        title="Your new API key"
        description="This is the only time it will ever be shown."
        size="lg"
        footer={
          <Button variant="primary" size="sm" onClick={() => setSecret(null)}>
            I have saved it
          </Button>
        }
      >
        {secret !== null && <SecretPanel secret={secret} />}
      </Dialog>

      <Dialog
        open={revoking !== null}
        onClose={() => {
          setRevoking(null);
          setConfirmText('');
        }}
        title={`Revoke ${revoking?.name ?? ''}?`}
        description="Anything using this key stops working immediately."
        footer={
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setRevoking(null);
                setConfirmText('');
              }}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              disabled={confirmText !== revoking?.name}
              onClick={() => revoking !== null && void revoke(revoking)}
            >
              Revoke permanently
            </Button>
          </>
        }
      >
        <Field label={`Type "${revoking?.name ?? ''}" to confirm`}>
          {(id) => (
            <Input id={id} value={confirmText} onChange={(event) => setConfirmText(event.target.value)} />
          )}
        </Field>
      </Dialog>
    </div>
  );
}

function SecretPanel({ secret }: { secret: string }): React.ReactElement {
  const origin = typeof window === 'undefined' ? 'http://127.0.0.1:7272' : window.location.origin;

  const snippets: Array<{ label: string; code: string }> = [
    {
      label: 'OpenAI SDK (Python)',
      code: `from openai import OpenAI

client = OpenAI(base_url="${origin}/v1", api_key="${secret}")`,
    },
    {
      label: 'Claude Code',
      code: `export ANTHROPIC_BASE_URL="${origin}/v1"
export ANTHROPIC_API_KEY="${secret}"`,
    },
    {
      label: 'curl',
      code: `curl ${origin}/v1/chat/completions \\
  -H "Authorization: Bearer ${secret}" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"auto","messages":[{"role":"user","content":"Hello"}]}'`,
    },
  ];

  return (
    <div className="space-y-4">
      <div className="rounded-sb border border-warn/40 bg-warn-soft px-3 py-2.5">
        <p className="text-xs font-medium text-warn">
          Copy this now — it is hashed on the server and cannot be recovered.
        </p>
      </div>

      <div className="flex items-center gap-2 rounded-sb border border-line bg-surface-2 px-3 py-2.5">
        <code className="min-w-0 flex-1 break-all font-mono text-xs text-ink">{secret}</code>
        <CopyButton value={secret} size={15} />
      </div>

      <div className="space-y-2">
        {snippets.map((snippet) => (
          <div key={snippet.label} className="rounded-sb border border-line">
            <div className="flex items-center justify-between border-b border-line px-3 py-1.5">
              <span className="text-[0.6875rem] font-medium text-muted">{snippet.label}</span>
              <CopyButton value={snippet.code} size={11} />
            </div>
            <pre className="overflow-x-auto px-3 py-2 font-mono text-[0.6875rem] leading-relaxed text-ink">
              {snippet.code}
            </pre>
          </div>
        ))}
      </div>
    </div>
  );
}
