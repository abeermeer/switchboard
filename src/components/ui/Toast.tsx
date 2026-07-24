'use client';

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { AlertTriangle, Check, Info, X, XCircle } from 'lucide-react';
import { cn, id as makeId } from '@/lib/utils';

export type ToastTone = 'neutral' | 'ok' | 'warn' | 'down' | 'info';

export interface Toast {
  id: string;
  title: string;
  description?: string;
  tone: ToastTone;
}

interface ToastContextValue {
  toast: (input: { title: string; description?: string; tone?: ToastTone }) => void;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const DEFAULT_TTL_MS = 4_500;

export function ToastProvider({ children }: { children: ReactNode }): React.ReactElement {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((toastId: string) => {
    setToasts((current) => current.filter((t) => t.id !== toastId));
  }, []);

  const toast = useCallback(
    ({ title, description, tone = 'neutral' }: { title: string; description?: string; tone?: ToastTone }) => {
      const entry: Toast = { id: makeId('toast'), title, tone, ...(description === undefined ? {} : { description }) };
      setToasts((current) => [...current, entry]);
      // Errors stay longer: they usually carry text the user needs to read.
      const ttl = tone === 'down' ? DEFAULT_TTL_MS * 2 : DEFAULT_TTL_MS;
      setTimeout(() => {
        setToasts((current) => current.filter((t) => t.id !== entry.id));
      }, ttl);
    },
    [],
  );

  const value = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-80 flex-col gap-2"
        role="region"
        aria-live="polite"
        aria-label="Notifications"
      >
        {toasts.map((entry) => (
          <ToastCard key={entry.id} toast={entry} onDismiss={() => dismiss(entry.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

const ICONS: Record<ToastTone, ReactNode> = {
  neutral: <Info size={15} />,
  ok: <Check size={15} />,
  warn: <AlertTriangle size={15} />,
  down: <XCircle size={15} />,
  info: <Info size={15} />,
};

const TONE_STYLES: Record<ToastTone, string> = {
  neutral: 'text-muted',
  ok: 'text-ok',
  warn: 'text-warn',
  down: 'text-down',
  info: 'text-info',
};

function ToastCard({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }): React.ReactElement {
  return (
    <div
      className={cn(
        'pointer-events-auto flex items-start gap-2.5 rounded-sb border border-line',
        'bg-surface px-3.5 py-3 shadow-sb-lg animate-fade-up',
      )}
    >
      <span className={cn('mt-0.5 shrink-0', TONE_STYLES[toast.tone])}>{ICONS[toast.tone]}</span>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-ink">{toast.title}</p>
        {toast.description !== undefined && (
          <p className="mt-0.5 break-words text-xs leading-relaxed text-muted">{toast.description}</p>
        )}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss notification"
        className="-mr-1 -mt-0.5 shrink-0 rounded p-1 text-faint transition-colors hover:text-ink"
      >
        <X size={13} />
      </button>
    </div>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (ctx === null) {
    throw new Error('useToast must be used inside a <ToastProvider>.');
  }
  return ctx;
}
