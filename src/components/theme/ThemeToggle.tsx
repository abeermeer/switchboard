'use client';

import { useEffect, useState } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { cn } from '@/lib/utils';

type Theme = 'light' | 'dark' | 'system';

const OPTIONS: Array<{ value: Theme; icon: React.ReactNode; label: string }> = [
  { value: 'light', icon: <Sun size={13} />, label: 'Light' },
  { value: 'system', icon: <Monitor size={13} />, label: 'System' },
  { value: 'dark', icon: <Moon size={13} />, label: 'Dark' },
];

function apply(theme: Theme): void {
  const resolved =
    theme === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : theme;
  document.documentElement.setAttribute('data-theme', resolved);
}

export function ThemeToggle({ className }: { className?: string }): React.ReactElement {
  const [theme, setTheme] = useState<Theme>('system');

  useEffect(() => {
    const stored = localStorage.getItem('sb-theme');
    setTheme(stored === 'light' || stored === 'dark' ? stored : 'system');
  }, []);

  useEffect(() => {
    if (theme !== 'system') return;
    // Following the OS means tracking it live, not only reading it once.
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (): void => apply('system');
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [theme]);

  const select = (next: Theme): void => {
    setTheme(next);
    if (next === 'system') localStorage.removeItem('sb-theme');
    else localStorage.setItem('sb-theme', next);
    apply(next);
  };

  return (
    <div
      role="radiogroup"
      aria-label="Colour theme"
      className={cn('inline-flex items-center gap-0.5 rounded-sb bg-surface-2 p-0.5', className)}
    >
      {OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={theme === option.value}
          aria-label={option.label}
          title={option.label}
          onClick={() => select(option.value)}
          className={cn(
            'inline-flex h-6 w-7 items-center justify-center rounded transition-colors duration-100',
            theme === option.value
              ? 'bg-surface text-ink shadow-sb-sm'
              : 'text-faint hover:text-ink',
          )}
        >
          {option.icon}
        </button>
      ))}
    </div>
  );
}
