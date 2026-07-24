'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';
import type { Combo } from '@/types/core';
import { Badge, Button, CopyButton, Dialog, Field, Input, useToast } from '@/components/ui';

export function PolicyList({ combos }: { combos: Combo[] }): React.ReactElement {
  const router = useRouter();
  const { toast } = useToast();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [busy, setBusy] = useState(false);

  const create = async (): Promise<void> => {
    setBusy(true);
    try {
      const res = await fetch('/api/combos', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), slug: slug.trim() }),
      });
      const body = (await res.json()) as { id?: string; error?: string };
      if (!res.ok) throw new Error(body.error ?? 'Could not create the policy');
      toast({ title: 'Policy created', tone: 'ok' });
      setCreating(false);
      setName('');
      setSlug('');
      if (body.id !== undefined) router.push(`/dashboard/routing/${body.id}`);
      else router.refresh();
    } catch (err) {
      toast({ title: 'Failed', description: String(err), tone: 'down' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-ink">Routing policies</h1>
          <p className="mt-0.5 text-sm text-muted">
            A policy is a model name your clients can send. It decides where the request goes.
          </p>
        </div>
        <Button variant="primary" size="sm" leadingIcon={<Plus size={13} />} onClick={() => setCreating(true)}>
          New policy
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {combos.map((combo) => (
          <Link
            key={combo.id}
            href={`/dashboard/routing/${combo.id}`}
            className="rounded-sb border border-line bg-surface p-4 transition-shadow hover:border-line-strong hover:shadow-sb"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-ink">{combo.name}</p>
                <p className="mt-1 text-xs leading-relaxed text-muted">
                  {combo.description.length > 0 ? combo.description : 'No description'}
                </p>
              </div>
              {combo.isDefault && (
                <Badge tone="accent" size="sm">
                  default
                </Badge>
              )}
            </div>

            <div
              className="mt-3 flex items-center gap-1 rounded-sb bg-surface-2 px-2 py-1.5"
              onClick={(event) => event.preventDefault()}
            >
              <code className="min-w-0 flex-1 truncate font-mono text-[0.6875rem] text-muted">
                model: &quot;{combo.slug}&quot;
              </code>
              <CopyButton value={combo.slug} size={11} />
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <Badge size="sm">{combo.strategy}</Badge>
              <span className="text-[0.6875rem] text-faint">
                {combo.members.length === 0
                  ? 'all connections'
                  : `${combo.members.length} member${combo.members.length === 1 ? '' : 's'}`}
              </span>
              {!combo.enabled && (
                <Badge tone="warn" size="sm">
                  disabled
                </Badge>
              )}
            </div>
          </Link>
        ))}
      </div>

      <Dialog
        open={creating}
        onClose={() => setCreating(false)}
        title="New routing policy"
        description="Give it a name and the model string clients will send."
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={busy}
              disabled={name.trim().length === 0 || slug.trim().length === 0}
              onClick={() => void create()}
            >
              Create
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Name" required>
            {(id) => (
              <Input
                id={id}
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  // Slug follows the name until the user edits it directly.
                  setSlug(
                    event.target.value
                      .toLowerCase()
                      .replace(/[^a-z0-9]+/g, '-')
                      .replace(/^-|-$/g, ''),
                  );
                }}
                placeholder="Cheap coding"
              />
            )}
          </Field>
          <Field label="Slug" required hint="Lowercase letters, numbers and dashes.">
            {(id) => (
              <Input
                id={id}
                mono
                value={slug}
                onChange={(event) => setSlug(event.target.value)}
                placeholder="cheap-coding"
              />
            )}
          </Field>
        </div>
      </Dialog>
    </div>
  );
}
