'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Eye, EyeOff } from 'lucide-react';
import type { ProviderCatalogEntry } from '@/types/core';
import { formatMs } from '@/lib/utils';
import { Badge, Button, Dialog, Field, Input, useToast } from '@/components/ui';

interface TestResult {
  ok: boolean;
  latencyMs: number;
  error: string | null;
}

export function ConnectDialog({
  provider,
  open,
  onClose,
}: {
  provider: ProviderCatalogEntry | null;
  open: boolean;
  onClose: () => void;
}): React.ReactElement | null {
  const router = useRouter();
  const { toast } = useToast();

  const [apiKey, setApiKey] = useState('');
  const [label, setLabel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tested, setTested] = useState<TestResult | null>(null);

  if (provider === null) return null;

  const reset = (): void => {
    setApiKey('');
    setLabel('');
    setBaseUrl('');
    setReveal(false);
    setTested(null);
    setBusy(false);
  };

  const dismiss = (): void => {
    reset();
    onClose();
  };

  /**
   * Creates the connection, probes it, and rolls back if the credential is
   * rejected. Saving a dead key and only finding out on the first real request
   * is the most common way a gateway wastes someone's afternoon.
   */
  const save = async (keepOnFailure: boolean): Promise<void> => {
    setBusy(true);
    setTested(null);

    try {
      const create = await fetch('/api/connections', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          providerId: provider.id,
          ...(label.trim().length > 0 ? { label: label.trim() } : {}),
          ...(apiKey.trim().length > 0 ? { apiKey: apiKey.trim() } : {}),
          ...(baseUrl.trim().length > 0 ? { baseUrlOverride: baseUrl.trim() } : {}),
        }),
      });

      if (!create.ok) {
        const body = (await create.json()) as { error?: string };
        throw new Error(body.error ?? 'Could not create the connection.');
      }

      const connection = (await create.json()) as { id: string };

      const probe = await fetch(`/api/connections/${connection.id}/test`, { method: 'POST' });
      const result = (await probe.json()) as TestResult;
      setTested(result);

      if (!result.ok && !keepOnFailure) {
        await fetch(`/api/connections/${connection.id}`, { method: 'DELETE' });
        toast({
          title: `${provider.name} rejected that key`,
          description: result.error ?? 'The provider did not accept the credential.',
          tone: 'down',
        });
        return;
      }

      toast({
        title: `${provider.name} connected`,
        description: result.ok ? `Responded in ${formatMs(result.latencyMs)}` : 'Saved without a successful probe.',
        tone: result.ok ? 'ok' : 'warn',
      });
      router.refresh();
      dismiss();
    } catch (err) {
      toast({
        title: 'Connection failed',
        description: err instanceof Error ? err.message : String(err),
        tone: 'down',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={dismiss}
      title={`Connect ${provider.name}`}
      description={provider.blurb}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={dismiss} disabled={busy}>
            Cancel
          </Button>
          {tested !== null && !tested.ok && (
            <Button variant="secondary" size="sm" onClick={() => void save(true)} disabled={busy}>
              Save anyway
            </Button>
          )}
          <Button
            variant="primary"
            size="sm"
            loading={busy}
            onClick={() => void save(false)}
            disabled={provider.requiresKey && apiKey.trim().length === 0}
          >
            Test &amp; connect
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {provider.freeTier !== null && (
          <div className="rounded-sb border border-accent-line bg-accent-soft px-3 py-2.5">
            <div className="flex items-center gap-2">
              <Badge tone="accent" size="sm">
                Free tier
              </Badge>
              <span className="text-xs text-accent">{provider.freeTier.summary}</span>
            </div>
            <a
              href={provider.signupUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="mt-1.5 inline-block text-[0.6875rem] text-accent underline underline-offset-2"
            >
              Get a key from {provider.name} →
            </a>
          </div>
        )}

        {provider.requiresKey ? (
          <Field label="API key" required>
            {(id) => (
              <div className="relative">
                <Input
                  id={id}
                  mono
                  type={reveal ? 'text' : 'password'}
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder="Paste the key from your provider dashboard"
                  autoComplete="off"
                  spellCheck={false}
                  className="pr-9"
                />
                <button
                  type="button"
                  onClick={() => setReveal((v) => !v)}
                  aria-label={reveal ? 'Hide key' : 'Show key'}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-faint transition-colors hover:text-ink"
                >
                  {reveal ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            )}
          </Field>
        ) : (
          <p className="rounded-sb bg-surface-2 px-3 py-2 text-xs text-muted">
            {provider.name} runs locally and needs no credential.
          </p>
        )}

        <Field label="Label" hint="Shown throughout the dashboard. Useful when you hold two keys for one provider.">
          {(id) => (
            <Input
              id={id}
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder={provider.name}
            />
          )}
        </Field>

        <Field
          label="Base URL override"
          hint={`Leave empty to use ${provider.baseUrl}. Set this to point at a proxy or self-hosted endpoint.`}
        >
          {(id) => (
            <Input
              id={id}
              mono
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder={provider.baseUrl}
            />
          )}
        </Field>

        {tested !== null && (
          <div
            className={
              tested.ok
                ? 'rounded-sb bg-ok-soft px-3 py-2 text-xs text-ok'
                : 'rounded-sb bg-down-soft px-3 py-2 text-xs text-down'
            }
          >
            {tested.ok
              ? `Connected — responded in ${formatMs(tested.latencyMs)}.`
              : (tested.error ?? 'The provider rejected this credential.')}
          </div>
        )}
      </div>
    </Dialog>
  );
}
