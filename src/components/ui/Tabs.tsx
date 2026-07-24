'use client';

import { useCallback, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface TabItem {
  value: string;
  label: string;
  count?: number;
  icon?: ReactNode;
}

export interface TabsProps {
  items: TabItem[];
  value: string;
  onChange: (value: string) => void;
  className?: string;
}

export function Tabs({ items, value, onChange, className }: TabsProps): React.ReactElement {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const index = items.findIndex((item) => item.value === value);
      if (index === -1) return;

      let next: number | null = null;
      if (event.key === 'ArrowRight') next = (index + 1) % items.length;
      if (event.key === 'ArrowLeft') next = (index - 1 + items.length) % items.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = items.length - 1;
      if (next === null) return;

      event.preventDefault();
      const target = items[next];
      if (target === undefined) return;
      onChange(target.value);
      // Roving focus: the arrow keys must move focus too, not just selection.
      refs.current[next]?.focus();
    },
    [items, value, onChange],
  );

  return (
    <div
      role="tablist"
      onKeyDown={onKeyDown}
      className={cn('flex items-center gap-0.5 border-b border-line', className)}
    >
      {items.map((item, index) => {
        const active = item.value === value;
        return (
          <button
            key={item.value}
            ref={(node) => {
              refs.current[index] = node;
            }}
            role="tab"
            type="button"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(item.value)}
            className={cn(
              'relative -mb-px inline-flex items-center gap-1.5 whitespace-nowrap px-3 py-2',
              'text-sm font-medium transition-colors duration-100',
              'focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent',
              active ? 'text-ink' : 'text-muted hover:text-ink',
            )}
          >
            {item.icon}
            {item.label}
            {item.count !== undefined && (
              <span
                className={cn(
                  'rounded-full px-1.5 py-0.5 text-[0.625rem] tabular',
                  active ? 'bg-accent-soft text-accent' : 'bg-surface-2 text-muted',
                )}
              >
                {item.count}
              </span>
            )}
            <span
              aria-hidden="true"
              className={cn(
                'absolute inset-x-0 -bottom-px h-0.5 rounded-full transition-opacity duration-150',
                active ? 'bg-accent opacity-100' : 'opacity-0',
              )}
            />
          </button>
        );
      })}
    </div>
  );
}
