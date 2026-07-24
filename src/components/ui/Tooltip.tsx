'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  delayMs?: number;
  className?: string;
}

export function Tooltip({
  content,
  children,
  delayMs = 400,
  className,
}: TooltipProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  useEffect(() => clear, [clear]);

  const show = useCallback(() => {
    clear();
    timer.current = setTimeout(() => setOpen(true), delayMs);
  }, [clear, delayMs]);

  const hide = useCallback(() => {
    clear();
    setOpen(false);
  }, [clear]);

  return (
    <span
      className={cn('relative inline-flex', className)}
      onMouseEnter={show}
      onMouseLeave={hide}
      // Keyboard users get the tooltip too — hover-only would hide the score
      // factor explanations from anyone tabbing through the routing page.
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {open && (
        <span
          role="tooltip"
          className={cn(
            'pointer-events-none absolute bottom-full left-1/2 z-50 mb-1.5 -translate-x-1/2',
            'w-max max-w-64 rounded-sb border border-line bg-surface px-2.5 py-1.5',
            'text-xs leading-relaxed text-ink shadow-sb-lg animate-fade-up',
          )}
        >
          {content}
          <span
            aria-hidden="true"
            className="absolute left-1/2 top-full h-2 w-2 -translate-x-1/2 -translate-y-1 rotate-45 border-b border-r border-line bg-surface"
          />
        </span>
      )}
    </span>
  );
}
