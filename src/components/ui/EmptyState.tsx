import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps): React.ReactElement {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 px-6 py-14 text-center',
        className,
      )}
    >
      {icon !== undefined && (
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-surface-2 text-faint">
          {icon}
        </div>
      )}
      <div className="space-y-1">
        <p className="text-sm font-medium text-ink">{title}</p>
        {description !== undefined && (
          <p className="mx-auto max-w-sm text-xs leading-relaxed text-muted">{description}</p>
        )}
      </div>
      {action}
    </div>
  );
}
