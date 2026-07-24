import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type LabelHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { cn } from '@/lib/utils';

const CONTROL = cn(
  'w-full rounded-sb border border-line-strong bg-surface px-3 text-sm text-ink',
  'placeholder:text-faint',
  'transition-[border-color,box-shadow] duration-100',
  'focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25',
  'disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-faint',
);

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
  mono?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { invalid = false, mono = false, className, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(
        CONTROL,
        'h-9',
        mono && 'font-mono text-[0.8125rem]',
        invalid && 'border-down focus:border-down focus:ring-down/25',
        className,
      )}
      {...props}
    />
  );
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
  mono?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { invalid = false, mono = false, className, ...props },
  ref,
) {
  return (
    <textarea
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(
        CONTROL,
        'min-h-20 resize-y py-2 leading-relaxed',
        mono && 'font-mono text-[0.8125rem]',
        invalid && 'border-down focus:border-down focus:ring-down/25',
        className,
      )}
      {...props}
    />
  );
});

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  invalid?: boolean;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { invalid = false, className, children, ...props },
  ref,
) {
  return (
    <select
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(
        CONTROL,
        'h-9 cursor-pointer appearance-none bg-no-repeat pr-8',
        invalid && 'border-down focus:border-down focus:ring-down/25',
        className,
      )}
      style={{
        // Inline so the caret follows currentColor in both themes without a
        // second asset or a dark-mode override.
        backgroundImage:
          "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%23888' stroke-width='1.5' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")",
        backgroundPosition: 'right 0.625rem center',
      }}
      {...props}
    >
      {children}
    </select>
  );
});

export const Label = forwardRef<HTMLLabelElement, LabelHTMLAttributes<HTMLLabelElement>>(
  function Label({ className, ...props }, ref) {
    return (
      <label
        ref={ref}
        className={cn('block text-xs font-medium text-ink', className)}
        {...props}
      />
    );
  },
);

export function FieldError({ children }: { children: ReactNode }): React.ReactElement | null {
  if (children === null || children === undefined || children === false) return null;
  return (
    <p className="mt-1.5 text-xs text-down" role="alert">
      {children}
    </p>
  );
}

export interface FieldProps {
  label: string;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  className?: string;
  /** Receives the generated id so the label and control stay associated. */
  children: (id: string) => ReactNode;
}

export function Field({
  label,
  hint,
  error,
  required = false,
  className,
  children,
}: FieldProps): React.ReactElement {
  const id = useId();
  return (
    <div className={cn('space-y-1.5', className)}>
      <Label htmlFor={id}>
        {label}
        {required && <span className="ml-0.5 text-down">*</span>}
      </Label>
      {children(id)}
      {hint !== undefined && error === undefined && (
        <p className="text-xs leading-relaxed text-muted">{hint}</p>
      )}
      <FieldError>{error}</FieldError>
    </div>
  );
}
