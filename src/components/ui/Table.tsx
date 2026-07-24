import { forwardRef, type HTMLAttributes, type TdHTMLAttributes, type ThHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export interface TableProps extends HTMLAttributes<HTMLTableElement> {
  /** Wraps the table so wide content scrolls instead of breaking the layout. */
  scroll?: boolean;
}

export const Table = forwardRef<HTMLTableElement, TableProps>(function Table(
  { scroll = true, className, ...props },
  ref,
) {
  const table = (
    <table
      ref={ref}
      className={cn('w-full border-collapse text-sm', className)}
      {...props}
    />
  );
  return scroll ? <div className="w-full overflow-x-auto">{table}</div> : table;
});

export const THead = forwardRef<HTMLTableSectionElement, HTMLAttributes<HTMLTableSectionElement>>(
  function THead({ className, ...props }, ref) {
    return (
      <thead
        ref={ref}
        className={cn('sticky top-0 z-10 bg-surface-2', className)}
        {...props}
      />
    );
  },
);

export const TBody = forwardRef<HTMLTableSectionElement, HTMLAttributes<HTMLTableSectionElement>>(
  function TBody({ className, ...props }, ref) {
    return <tbody ref={ref} className={className} {...props} />;
  },
);

export interface TRProps extends HTMLAttributes<HTMLTableRowElement> {
  clickable?: boolean;
  selected?: boolean;
}

export const TR = forwardRef<HTMLTableRowElement, TRProps>(function TR(
  { clickable = false, selected = false, className, ...props },
  ref,
) {
  return (
    <tr
      ref={ref}
      className={cn(
        'border-b border-line transition-colors duration-75 last:border-b-0',
        clickable && 'cursor-pointer hover:bg-surface-2',
        selected && 'bg-accent-soft',
        className,
      )}
      {...props}
    />
  );
});

export interface THProps extends ThHTMLAttributes<HTMLTableCellElement> {
  align?: 'left' | 'right' | 'center';
  sortable?: boolean;
  sorted?: 'asc' | 'desc' | null;
}

export const TH = forwardRef<HTMLTableCellElement, THProps>(function TH(
  { align = 'left', sortable = false, sorted = null, className, children, ...props },
  ref,
) {
  return (
    <th
      ref={ref}
      scope="col"
      aria-sort={sorted === null ? undefined : sorted === 'asc' ? 'ascending' : 'descending'}
      className={cn(
        'whitespace-nowrap border-b border-line px-3 py-2 text-xs font-medium text-muted',
        align === 'right' && 'text-right',
        align === 'center' && 'text-center',
        align === 'left' && 'text-left',
        sortable && 'cursor-pointer select-none hover:text-ink',
        className,
      )}
      {...props}
    >
      <span className={cn('inline-flex items-center gap-1', align === 'right' && 'flex-row-reverse')}>
        {children}
        {sortable && (
          <span className={cn('text-[0.625rem]', sorted === null ? 'text-faint opacity-40' : 'text-accent')}>
            {sorted === 'desc' ? '▼' : '▲'}
          </span>
        )}
      </span>
    </th>
  );
});

export interface TDProps extends TdHTMLAttributes<HTMLTableCellElement> {
  align?: 'left' | 'right' | 'center';
  mono?: boolean;
}

export const TD = forwardRef<HTMLTableCellElement, TDProps>(function TD(
  { align = 'left', mono = false, className, ...props },
  ref,
) {
  return (
    <td
      ref={ref}
      className={cn(
        'px-3 py-2 text-ink',
        // Numeric columns must not jitter as values tick, so right alignment
        // implies tabular figures.
        align === 'right' && 'text-right tabular',
        align === 'center' && 'text-center',
        mono && 'font-mono text-[0.8125rem]',
        className,
      )}
      {...props}
    />
  );
});
