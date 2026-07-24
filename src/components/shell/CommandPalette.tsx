'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Activity,
  BarChart3,
  KeyRound,
  LayoutDashboard,
  ListTree,
  Moon,
  PanelsTopLeft,
  Plug,
  RefreshCw,
  ScrollText,
  Settings,
  Sparkles,
  Sun,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useToast } from '@/components/ui';

interface Command {
  id: string;
  label: string;
  group: string;
  icon: React.ReactNode;
  run: () => void | Promise<void>;
}

export function CommandPalette(): React.ReactElement | null {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setActive(0);
  }, []);

  const commands = useMemo<Command[]>(() => {
    const go = (href: string) => () => {
      router.push(href);
      close();
    };

    return [
      { id: 'nav-overview', label: 'Overview', group: 'Go to', icon: <LayoutDashboard size={14} />, run: go('/dashboard') },
      { id: 'nav-providers', label: 'Providers', group: 'Go to', icon: <Plug size={14} />, run: go('/dashboard/providers') },
      { id: 'nav-routing', label: 'Routing policies', group: 'Go to', icon: <ListTree size={14} />, run: go('/dashboard/routing') },
      { id: 'nav-models', label: 'Models', group: 'Go to', icon: <PanelsTopLeft size={14} />, run: go('/dashboard/models') },
      { id: 'nav-playground', label: 'Playground', group: 'Go to', icon: <Sparkles size={14} />, run: go('/dashboard/playground') },
      { id: 'nav-analytics', label: 'Analytics', group: 'Go to', icon: <BarChart3 size={14} />, run: go('/dashboard/analytics') },
      { id: 'nav-requests', label: 'Requests', group: 'Go to', icon: <ScrollText size={14} />, run: go('/dashboard/requests') },
      { id: 'nav-health', label: 'Health', group: 'Go to', icon: <Activity size={14} />, run: go('/dashboard/health') },
      { id: 'nav-keys', label: 'API keys', group: 'Go to', icon: <KeyRound size={14} />, run: go('/dashboard/keys') },
      { id: 'nav-settings', label: 'Settings', group: 'Go to', icon: <Settings size={14} />, run: go('/dashboard/settings') },
      {
        id: 'act-probe',
        label: 'Probe all providers',
        group: 'Actions',
        icon: <RefreshCw size={14} />,
        run: async () => {
          close();
          toast({ title: 'Probing every provider…' });
          try {
            const res = await fetch('/api/health/probe', { method: 'POST' });
            if (!res.ok) throw new Error(await res.text());
            toast({ title: 'Probe complete', tone: 'ok' });
            router.refresh();
          } catch (err) {
            toast({
              title: 'Probe failed',
              description: err instanceof Error ? err.message : String(err),
              tone: 'down',
            });
          }
        },
      },
      {
        id: 'act-endpoint',
        label: 'Copy gateway endpoint',
        group: 'Actions',
        icon: <Plug size={14} />,
        run: async () => {
          await navigator.clipboard.writeText(`${window.location.origin}/v1`);
          toast({ title: 'Endpoint copied', tone: 'ok' });
          close();
        },
      },
      {
        id: 'act-theme',
        label: 'Toggle light / dark',
        group: 'Actions',
        // A static icon: reading data-theme here would run during SSR, where
        // there is no document.
        icon: <Moon size={14} />,
        run: () => {
          const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
          document.documentElement.setAttribute('data-theme', next);
          localStorage.setItem('sb-theme', next);
          close();
        },
      },
    ];
  }, [router, close, toast]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return commands;
    // Subsequence match, so "gp" finds "Go to → Playground".
    return commands.filter((command) => {
      const haystack = `${command.group} ${command.label}`.toLowerCase();
      let index = 0;
      for (const char of q) {
        index = haystack.indexOf(char, index);
        if (index === -1) return false;
        index += 1;
      }
      return true;
    });
  }, [commands, query]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[90] flex items-start justify-center bg-black/40 px-4 pt-[12vh] backdrop-blur-[2px]"
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="w-full max-w-lg overflow-hidden rounded-sb border border-line bg-surface shadow-sb-lg animate-fade-up"
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') close();
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setActive((i) => (i + 1) % Math.max(filtered.length, 1));
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault();
              setActive((i) => (i - 1 + filtered.length) % Math.max(filtered.length, 1));
            }
            if (event.key === 'Enter') {
              event.preventDefault();
              void filtered[active]?.run();
            }
          }}
          placeholder="Search pages and actions…"
          className="w-full border-b border-line bg-transparent px-4 py-3.5 text-sm text-ink outline-none placeholder:text-faint"
        />

        <div className="max-h-80 overflow-y-auto p-1.5">
          {filtered.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-faint">No matches</p>
          ) : (
            filtered.map((command, index) => (
              <button
                key={command.id}
                type="button"
                onMouseEnter={() => setActive(index)}
                onClick={() => void command.run()}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded px-3 py-2 text-left text-sm transition-colors',
                  index === active ? 'bg-accent-soft text-accent' : 'text-ink hover:bg-surface-2',
                )}
              >
                <span className="shrink-0 opacity-70">{command.icon}</span>
                <span className="flex-1 truncate">{command.label}</span>
                <span className="shrink-0 text-[0.625rem] text-faint">{command.group}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
