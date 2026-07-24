'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, KeyRound, Plug, Terminal } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button, CopyButton } from '@/components/ui';

const TABS = ['Claude Code', 'Cursor', 'OpenAI SDK', 'curl'] as const;
type Tab = (typeof TABS)[number];

export function FirstRun({ freeProviders }: { freeProviders: string[] }): React.ReactElement {
  const [tab, setTab] = useState<Tab>('Claude Code');
  const [origin, setOrigin] = useState('http://127.0.0.1:7272');

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const snippets: Record<Tab, string> = {
    'Claude Code': `export ANTHROPIC_BASE_URL="${origin}/v1"
export ANTHROPIC_API_KEY="sb-live-your-key"
claude`,
    Cursor: `Settings → Models → Override OpenAI Base URL

  Base URL:  ${origin}/v1
  API Key:   sb-live-your-key
  Model:     auto`,
    'OpenAI SDK': `from openai import OpenAI

client = OpenAI(
    base_url="${origin}/v1",
    api_key="sb-live-your-key",
)

# "auto" hands routing to Switchboard: free tiers first,
# automatic fallback when a provider is down.
response = client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "Hello"}],
)`,
    curl: `curl ${origin}/v1/chat/completions \\
  -H "Authorization: Bearer sb-live-your-key" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "auto",
    "messages": [{"role": "user", "content": "Hello"}]
  }'`,
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6 py-6">
      <div className="space-y-2 text-center">
        <h1 className="text-xl font-semibold tracking-tight text-ink">Set up your gateway</h1>
        <p className="mx-auto max-w-lg text-sm leading-relaxed text-muted">
          Three steps and every tool you own can share one endpoint, routed to whichever provider
          is cheapest and healthiest at that moment.
        </p>
      </div>

      <ol className="space-y-3">
        <Step
          index={1}
          icon={<Plug size={15} />}
          title="Connect a provider"
          description={`Start with a free tier — ${freeProviders.slice(0, 3).join(', ')} need no card and cover most day-to-day work.`}
          action={
            <Link href="/dashboard/providers">
              <Button variant="primary" size="sm" trailingIcon={<ArrowRight size={13} />}>
                Browse providers
              </Button>
            </Link>
          }
        />
        <Step
          index={2}
          icon={<KeyRound size={15} />}
          title="Create an API key"
          description="This is what your tools authenticate with. Keys carry their own budget and rate limit."
          action={
            <Link href="/dashboard/keys">
              <Button variant="secondary" size="sm" trailingIcon={<ArrowRight size={13} />}>
                Create a key
              </Button>
            </Link>
          }
        />
        <Step
          index={3}
          icon={<Terminal size={15} />}
          title="Point a tool at it"
          description="Anything that speaks the OpenAI API works unchanged — only the base URL moves."
        />
      </ol>

      <div className="overflow-hidden rounded-sb border border-line bg-surface">
        <div className="flex items-center gap-0.5 border-b border-line px-2 pt-2">
          {TABS.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setTab(item)}
              className={cn(
                'relative -mb-px px-3 py-2 text-xs font-medium transition-colors',
                tab === item ? 'text-ink' : 'text-muted hover:text-ink',
              )}
            >
              {item}
              {tab === item && (
                <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-accent" />
              )}
            </button>
          ))}
        </div>
        <div className="relative">
          <pre className="overflow-x-auto px-4 py-3.5 font-mono text-xs leading-relaxed text-ink">
            {snippets[tab]}
          </pre>
          <div className="absolute right-2 top-2">
            <CopyButton value={snippets[tab]} />
          </div>
        </div>
      </div>
    </div>
  );
}

function Step({
  index,
  icon,
  title,
  description,
  action,
}: {
  index: number;
  icon: React.ReactNode;
  title: string;
  description: string;
  action?: React.ReactNode;
}): React.ReactElement {
  return (
    <li className="flex items-start gap-3 rounded-sb border border-line bg-surface p-4">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-ink">
          <span className="mr-1.5 text-faint tabular">{index}.</span>
          {title}
        </p>
        <p className="mt-1 text-xs leading-relaxed text-muted">{description}</p>
      </div>
      {action !== undefined && <div className="shrink-0">{action}</div>}
    </li>
  );
}
