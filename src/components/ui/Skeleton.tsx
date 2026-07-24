import { cn } from '@/lib/utils';

export interface SkeletonProps {
  className?: string;
}

export function Skeleton({ className }: SkeletonProps): React.ReactElement {
  return <div className={cn('skeleton rounded-sb', className)} aria-hidden="true" />;
}

/** A few stacked bars, for list and table placeholders. */
export function SkeletonRows({ rows = 5, className }: { rows?: number; className?: string }): React.ReactElement {
  return (
    <div className={cn('space-y-2', className)}>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-9 w-full" />
      ))}
    </div>
  );
}
