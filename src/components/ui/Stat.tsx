import type { ReactNode } from 'react';
import { ArrowDownRight, ArrowUpRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Sparkline } from './Sparkline';

export interface StatProps {
  label: string;
  value: string;
  hint?: ReactNode;
  delta?: { value: string; direction: 'up' | 'down'; good?: boolean };
  series?: number[];
  tone?: 'accent' | 'ok' | 'warn' | 'down' | 'info' | 'muted';
  className?: string;
}

export function Stat({
  label,
  value,
  hint,
  delta,
  series,
  tone = 'accent',
  className,
}: StatProps): React.ReactElement {
  // Up is not automatically good — rising spend is bad, rising savings is good —
  // so direction and sentiment are separate inputs.
  const good = delta?.good ?? (delta?.direction === 'up');
  const Arrow = delta?.direction === 'up' ? ArrowUpRight : ArrowDownRight;

  // Written out rather than interpolated: Tailwind extracts class names
  // statically, so `text-${tone}` would never make it into the stylesheet.
  const valueColor =
    tone === 'ok'
      ? 'text-ok'
      : tone === 'warn'
        ? 'text-warn'
        : tone === 'down'
          ? 'text-down'
          : tone === 'info'
            ? 'text-info'
            : tone === 'muted'
              ? 'text-muted'
              : 'text-ink';

  return (
    <div
      className={cn(
        'flex flex-col justify-between gap-3 rounded-sb border border-line bg-surface p-4',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium text-muted">{label}</p>
        {delta !== undefined && (
          <span
            className={cn(
              'inline-flex items-center gap-0.5 text-[0.6875rem] font-medium tabular',
              good ? 'text-ok' : 'text-down',
            )}
          >
            <Arrow size={12} />
            {delta.value}
          </span>
        )}
      </div>

      <div>
        <p className={cn('text-2xl font-semibold leading-none tabular', valueColor)}>{value}</p>
        {hint !== undefined && <p className="mt-1.5 text-xs text-faint">{hint}</p>}
      </div>

      {series !== undefined && series.length > 0 && (
        <Sparkline data={series} tone={tone} width={200} height={28} className="w-full" />
      )}
    </div>
  );
}
