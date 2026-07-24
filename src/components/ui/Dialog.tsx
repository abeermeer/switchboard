'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
}

const SIZES = { sm: 'max-w-md', md: 'max-w-lg', lg: 'max-w-3xl' };

/**
 * Built on the native <dialog> element, which gives focus trapping, inertness
 * of the background, and top-layer stacking from the platform instead of a
 * hand-rolled focus manager that will eventually get it wrong.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
}: DialogProps): React.ReactElement {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (node === null) return;

    if (open && !node.open) {
      node.showModal();
      document.body.style.overflow = 'hidden';
    } else if (!open && node.open) {
      node.close();
      document.body.style.overflow = '';
    }

    return () => {
      document.body.style.overflow = '';
    };
  }, [open]);

  useEffect(() => {
    const node = ref.current;
    if (node === null) return;

    // Esc fires `cancel`; routing it through onClose keeps React state in sync
    // with whether the dialog is actually open.
    const onCancel = (event: Event): void => {
      event.preventDefault();
      onClose();
    };
    node.addEventListener('cancel', onCancel);
    return () => node.removeEventListener('cancel', onCancel);
  }, [onClose]);

  return (
    <dialog
      ref={ref}
      aria-labelledby="sb-dialog-title"
      onClick={(event) => {
        // Clicking the backdrop lands on the dialog element itself, never on
        // its children, which is how backdrop-dismiss is detected here.
        if (event.target === ref.current) onClose();
      }}
      className={cn(
        'w-[calc(100vw-2rem)] rounded-sb border border-line bg-surface p-0 text-ink shadow-sb-lg',
        'backdrop:bg-black/40 backdrop:backdrop-blur-[2px]',
        'open:animate-fade-up',
        SIZES[size],
      )}
    >
      <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
        <div>
          <h2 id="sb-dialog-title" className="text-sm font-semibold text-ink">
            {title}
          </h2>
          {description !== undefined && <p className="mt-1 text-xs text-muted">{description}</p>}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close dialog"
          className="-mr-1 -mt-1 rounded-sb p-1.5 text-faint transition-colors hover:bg-surface-2 hover:text-ink"
        >
          <X size={16} />
        </button>
      </div>

      <div className="max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>

      {footer !== undefined && (
        <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">
          {footer}
        </div>
      )}
    </dialog>
  );
}
