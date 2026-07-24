'use client';

import { cn } from '@/lib/utils';

export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  label?: string;
  size?: 'sm' | 'md';
  className?: string;
}

export function Switch({
  checked,
  onCheckedChange,
  disabled = false,
  label,
  size = 'md',
  className,
}: SwitchProps): React.ReactElement {
  const track = size === 'sm' ? 'h-4 w-7' : 'h-5 w-9';
  const knob = size === 'sm' ? 'h-3 w-3' : 'h-4 w-4';
  const travel = size === 'sm' ? 'translate-x-3' : 'translate-x-4';

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        'relative inline-flex shrink-0 cursor-pointer items-center rounded-full p-0.5',
        'transition-colors duration-150',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        'disabled:cursor-not-allowed disabled:opacity-45',
        track,
        checked ? 'bg-accent' : 'bg-surface-3',
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'pointer-events-none rounded-full bg-surface shadow-sb-sm',
          'transition-transform duration-150 ease-out',
          knob,
          checked ? travel : 'translate-x-0',
        )}
      />
    </button>
  );
}
