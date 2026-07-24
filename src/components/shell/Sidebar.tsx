'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Activity,
  BarChart3,
  ChevronsLeft,
  KeyRound,
  LayoutDashboard,
  ListTree,
  PanelsTopLeft,
  Plug,
  ScrollText,
  Settings,
  Sparkles,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { CopyButton } from '@/components/ui';
import { useLive } from './LiveProvider';

const NAV = [
  { href: '/dashboard', label: 'Overview', icon: LayoutDashboard },
  { href: '/dashboard/providers', label: 'Providers', icon: Plug },
  { href: '/dashboard/routing', label: 'Routing', icon: ListTree },
  { href: '/dashboard/models', label: 'Models', icon: PanelsTopLeft },
  { href: '/dashboard/playground', label: 'Playground', icon: Sparkles },
  { href: '/dashboard/analytics', label: 'Analytics', icon: BarChart3 },
  { href: '/dashboard/requests', label: 'Requests', icon: ScrollText },
  { href: '/dashboard/health', label: 'Health', icon: Activity },
  { href: '/dashboard/keys', label: 'API Keys', icon: KeyRound },
  { href: '/dashboard/settings', label: 'Settings', icon: Settings },
] as const;

export function Sidebar(): React.ReactElement {
  const pathname = usePathname();
  const { connected, health } = useLive();
  const [collapsed, setCollapsed] = useState(false);
  const [endpoint, setEndpoint] = useState('http://127.0.0.1:7272/v1');

  useEffect(() => {
    setCollapsed(localStorage.getItem('sb-sidebar') === 'collapsed');
    setEndpoint(`${window.location.origin}/v1`);
  }, []);

  const toggle = (): void => {
    setCollapsed((current) => {
      const next = !current;
      localStorage.setItem('sb-sidebar', next ? 'collapsed' : 'open');
      return next;
    });
  };

  const healthy = Object.values(health).filter((h) => h.status === 'healthy').length;

  return (
    <aside
      className={cn(
        'flex shrink-0 flex-col border-r border-line bg-surface',
        'transition-[width] duration-200 ease-out',
        collapsed ? 'w-14' : 'w-56',
      )}
    >
      <div className={cn('flex h-14 items-center gap-2 border-b border-line px-3', collapsed && 'justify-center px-0')}>
        <Link href="/dashboard" className="flex items-center gap-2 overflow-hidden">
          <SwitchboardMark />
          {!collapsed && (
            <span className="whitespace-nowrap text-sm font-semibold tracking-tight text-ink">
              Switchboard
            </span>
          )}
        </Link>
      </div>

      <nav className="flex-1 space-y-0.5 overflow-y-auto p-2">
        {NAV.map((item) => {
          // Only /dashboard needs an exact match; every other entry should stay
          // lit while the user is on one of its detail pages.
          const active =
            item.href === '/dashboard'
              ? pathname === '/dashboard'
              : pathname.startsWith(item.href);
          const Icon = item.icon;

          return (
            <Link
              key={item.href}
              href={item.href}
              title={collapsed ? item.label : undefined}
              className={cn(
                'relative flex items-center gap-2.5 rounded-sb px-2.5 py-2 text-sm',
                'transition-colors duration-100',
                collapsed && 'justify-center px-0',
                active ? 'bg-accent-soft font-medium text-accent' : 'text-muted hover:bg-surface-2 hover:text-ink',
              )}
            >
              {active && (
                <span
                  aria-hidden="true"
                  className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-r-full bg-accent"
                />
              )}
              <Icon size={16} className="shrink-0" />
              {!collapsed && <span className="truncate">{item.label}</span>}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-line p-2">
        {!collapsed && (
          <div className="mb-2 rounded-sb bg-surface-2 px-2.5 py-2">
            <div className="flex items-center gap-1.5">
              <span
                className={cn('status-dot', connected ? 'text-ok' : 'text-down')}
                data-live={connected ? 'true' : 'false'}
              />
              <span className="text-[0.6875rem] font-medium text-ink">
                {connected ? 'Gateway online' : 'Reconnecting…'}
              </span>
            </div>
            <p className="mt-0.5 text-[0.625rem] text-faint">
              {healthy} provider{healthy === 1 ? '' : 's'} healthy
            </p>
            <div className="mt-1.5 flex items-center gap-1">
              <code className="min-w-0 flex-1 truncate font-mono text-[0.625rem] text-muted">
                {endpoint}
              </code>
              <CopyButton value={endpoint} label="Copy endpoint" size={11} />
            </div>
          </div>
        )}

        <button
          type="button"
          onClick={toggle}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className={cn(
            'flex w-full items-center gap-2 rounded-sb px-2.5 py-1.5 text-xs text-faint',
            'transition-colors hover:bg-surface-2 hover:text-ink',
            collapsed && 'justify-center px-0',
          )}
        >
          <ChevronsLeft size={14} className={cn('transition-transform', collapsed && 'rotate-180')} />
          {!collapsed && 'Collapse'}
        </button>
      </div>
    </aside>
  );
}

/** The mark: a patch panel jack, rendered in the copper accent. */
function SwitchboardMark(): React.ReactElement {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none" className="shrink-0" aria-hidden="true">
      <rect x="1" y="1" width="20" height="20" rx="5" className="fill-accent-soft stroke-accent-line" strokeWidth="1" />
      <circle cx="7.5" cy="7.5" r="1.75" className="fill-accent" />
      <circle cx="14.5" cy="7.5" r="1.75" className="fill-accent" opacity="0.35" />
      <circle cx="7.5" cy="14.5" r="1.75" className="fill-accent" opacity="0.35" />
      <circle cx="14.5" cy="14.5" r="1.75" className="fill-accent" />
      <path
        d="M7.5 7.5C7.5 11 14.5 11 14.5 14.5"
        className="stroke-accent"
        strokeWidth="1.5"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}
