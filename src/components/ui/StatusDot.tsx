import type { ConnectionStatus } from '@/types/core';
import { cn } from '@/lib/utils';

const COLORS: Record<ConnectionStatus, string> = {
  healthy: 'text-ok',
  degraded: 'text-warn',
  down: 'text-down',
  unconfigured: 'text-faint',
  disabled: 'text-faint',
};

export const STATUS_LABELS: Record<ConnectionStatus, string> = {
  healthy: 'Healthy',
  degraded: 'Degraded',
  down: 'Down',
  unconfigured: 'Not configured',
  disabled: 'Disabled',
};

export interface StatusDotProps {
  status: ConnectionStatus;
  /** Adds the breathing halo. Reserve it for states worth drawing the eye to. */
  live?: boolean;
  withLabel?: boolean;
  className?: string;
}

export function StatusDot({
  status,
  live,
  withLabel = false,
  className,
}: StatusDotProps): React.ReactElement {
  // Healthy is the resting state and does not need to pulse; a failing provider
  // does. Defaulting this way keeps a page of 20 green dots calm.
  const animate = live ?? (status === 'degraded' || status === 'down');

  return (
    <span className={cn('inline-flex items-center gap-2', COLORS[status], className)}>
      <span
        className="status-dot"
        data-live={animate ? 'true' : 'false'}
        role="img"
        aria-label={STATUS_LABELS[status]}
      />
      {withLabel && <span className="text-xs font-medium">{STATUS_LABELS[status]}</span>}
    </span>
  );
}
