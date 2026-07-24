'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronRight, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui';
import { ThemeToggle } from '@/components/theme/ThemeToggle';
import { useLive } from './LiveProvider';

const LABELS: Record<string, string> = {
  dashboard: 'Overview',
  providers: 'Providers',
  routing: 'Routing',
  models: 'Models',
  playground: 'Playground',
  analytics: 'Analytics',
  requests: 'Requests',
  health: 'Health',
  keys: 'API Keys',
  settings: 'Settings',
};

export function Topbar(): React.ReactElement {
  const pathname = usePathname();
  const { health } = useLive();

  const crumbs = useMemo(() => {
    const parts = pathname.split('/').filter(Boolean);
    return parts.map((part, index) => ({
      label: LABELS[part] ?? part,
      href: `/${parts.slice(0, index + 1).join('/')}`,
      // Detail routes carry an opaque id; showing it truncated beats showing
      // nothing, and it is still a valid link target.
      isId: LABELS[part] === undefined,
    }));
  }, [pathname]);

  const entries = Object.values(health);
  const healthy = entries.filter((h) => h.status === 'healthy').length;
  const down = entries.filter((h) => h.status === 'down').length;

  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-line bg-surface px-4">
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1 text-sm">
        {crumbs.map((crumb, index) => (
          <span key={crumb.href} className="flex min-w-0 items-center gap-1">
            {index > 0 && <ChevronRight size={13} className="shrink-0 text-faint" />}
            {index === crumbs.length - 1 ? (
              <span className={cn('truncate font-medium text-ink', crumb.isId && 'font-mono text-xs')}>
                {crumb.isId ? `${crumb.label.slice(0, 16)}…` : crumb.label}
              </span>
            ) : (
              <Link href={crumb.href} className="truncate text-muted transition-colors hover:text-ink">
                {crumb.label}
              </Link>
            )}
          </span>
        ))}
      </nav>

      <div className="flex shrink-0 items-center gap-2">
        {entries.length > 0 && (
          <Badge tone={down > 0 ? 'down' : 'ok'} dot>
            {down > 0 ? `${down} down` : `${healthy} healthy`}
          </Badge>
        )}

        <button
          type="button"
          onClick={() => {
            // The palette owns the shortcut; dispatching it keeps one code path.
            window.dispatchEvent(
              new KeyboardEvent('keydown', { key: 'k', metaKey: true, ctrlKey: true, bubbles: true }),
            );
          }}
          className={cn(
            'hidden items-center gap-2 rounded-sb border border-line bg-surface-2 px-2.5 py-1.5',
            'text-xs text-faint transition-colors hover:border-line-strong hover:text-muted sm:flex',
          )}
        >
          <Search size={13} />
          <span>Search</span>
          <kbd className="rounded border border-line bg-surface px-1 py-0.5 font-mono text-[0.625rem]">
            ⌘K
          </kbd>
        </button>

        <ThemeToggle />
      </div>
    </header>
  );
}
