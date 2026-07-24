import { cn, formatUsd } from '@/lib/utils';

export interface MeterProps {
  value: number;
  limit: number | null;
  label?: string;
  /** Renders the numbers as currency rather than raw counts. */
  currency?: boolean;
  className?: string;
}

export function Meter({
  value,
  limit,
  label,
  currency = false,
  className,
}: MeterProps): React.ReactElement {
  const format = (n: number): string => (currency ? formatUsd(n) : String(Math.round(n)));

  if (limit === null || limit <= 0) {
    return (
      <div className={cn('space-y-1', className)}>
        {label !== undefined && (
          <div className="flex items-baseline justify-between text-xs">
            <span className="text-muted">{label}</span>
            <span className="tabular text-ink">{format(value)}</span>
          </div>
        )}
        <div className="h-1.5 w-full rounded-full bg-surface-3">
          <div className="h-full w-full rounded-full bg-surface-3" />
        </div>
        <p className="text-[0.6875rem] text-faint">No limit set</p>
      </div>
    );
  }

  const fraction = Math.min(1, value / limit);
  const percent = fraction * 100;

  // The colour shift is the whole point of a meter: it has to be readable at a
  // glance from across the room before the cap is actually hit.
  const tone = fraction >= 0.9 ? 'down' : fraction >= 0.75 ? 'warn' : 'accent';
  const barColor = tone === 'down' ? 'bg-down' : tone === 'warn' ? 'bg-warn' : 'bg-accent';
  const textColor = tone === 'down' ? 'text-down' : tone === 'warn' ? 'text-warn' : 'text-ink';

  return (
    <div className={cn('space-y-1', className)}>
      {label !== undefined && (
        <div className="flex items-baseline justify-between text-xs">
          <span className="text-muted">{label}</span>
          <span className={cn('tabular font-medium', textColor)}>
            {format(value)} <span className="text-faint">/ {format(limit)}</span>
          </span>
        </div>
      )}
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-surface-3"
        role="meter"
        aria-valuenow={Math.round(percent)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label ?? 'Usage'}
      >
        <div
          className={cn('h-full rounded-full transition-[width] duration-300', barColor)}
          style={{ width: `${Math.max(percent, value > 0 ? 2 : 0)}%` }}
        />
      </div>
      <p className="text-[0.6875rem] tabular text-faint">{percent.toFixed(0)}% used</p>
    </div>
  );
}
