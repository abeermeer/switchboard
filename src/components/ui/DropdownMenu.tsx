'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface DropdownItem {
  label: string;
  onSelect: () => void;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
}

export interface DropdownMenuProps {
  trigger: ReactNode;
  items: DropdownItem[];
  align?: 'left' | 'right';
  className?: string;
}

export function DropdownMenu({
  trigger,
  items,
  align = 'right',
  className,
}: DropdownMenuProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    setActive(0);
  }, []);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent): void => {
      if (root.current !== null && !root.current.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        close();
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActive((i) => (i + 1) % items.length);
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActive((i) => (i - 1 + items.length) % items.length);
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        const item = items[active];
        if (item !== undefined && item.disabled !== true) {
          item.onSelect();
          close();
        }
      }
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, items, active, close]);

  return (
    <div ref={root} className={cn('relative inline-flex', className)}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex"
      >
        {trigger}
      </button>

      {open && (
        <div
          role="menu"
          className={cn(
            'absolute top-full z-50 mt-1 min-w-44 rounded-sb border border-line bg-surface p-1',
            'shadow-sb-lg animate-fade-up',
            align === 'right' ? 'right-0' : 'left-0',
          )}
        >
          {items.map((item, index) => (
            <button
              key={item.label}
              role="menuitem"
              type="button"
              disabled={item.disabled}
              onMouseEnter={() => setActive(index)}
              onClick={() => {
                item.onSelect();
                close();
              }}
              className={cn(
                'flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-xs',
                'transition-colors duration-75 disabled:pointer-events-none disabled:opacity-45',
                index === active && 'bg-surface-2',
                item.danger === true ? 'text-down' : 'text-ink',
              )}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
