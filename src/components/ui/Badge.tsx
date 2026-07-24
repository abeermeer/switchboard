import { forwardRef, type HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export type BadgeTone = 'neutral' | 'ok' | 'warn' | 'down' | 'info' | 'accent';

const TONES: Record<BadgeTone, string> = {
  neutral: 'bg-surface-2 text-muted border-line',
  ok: 'bg-ok-soft text-ok border-transparent',
  warn: 'bg-warn-soft text-warn border-transparent',
  down: 'bg-down-soft text-down border-transparent',
  info: 'bg-info-soft text-info border-transparent',
  accent: 'bg-accent-soft text-accent border-accent-line',
};

const DOT_TONES: Record<BadgeTone, string> = {
  neutral: 'bg-faint',
  ok: 'bg-ok',
  warn: 'bg-warn',
  down: 'bg-down',
  info: 'bg-info',
  accent: 'bg-accent',
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  size?: 'sm' | 'md';
  dot?: boolean;
}

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  { tone = 'neutral', size = 'sm', dot = false, className, children, ...props },
  ref,
) {
  return (
    <span
      ref={ref}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border font-medium whitespace-nowrap',
        size === 'sm' ? 'px-2 py-0.5 text-[0.6875rem]' : 'px-2.5 py-1 text-xs',
        TONES[tone],
        className,
      )}
      {...props}
    >
      {dot && <span className={cn('h-1.5 w-1.5 rounded-full', DOT_TONES[tone])} aria-hidden="true" />}
      {children}
    </span>
  );
});
