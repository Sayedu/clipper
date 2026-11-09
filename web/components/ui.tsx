'use client';

import clsx from 'clsx';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';

/* ------------------------------------------------------------------ *
 *  Small, quiet primitives. One accent, hairlines over boxes.
 * ------------------------------------------------------------------ */

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'md' | 'lg';
  loading?: boolean;
};

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  className,
  children,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={clsx(
        'inline-flex items-center justify-center gap-2 rounded-[var(--radius)] font-medium transition',
        'disabled:cursor-not-allowed disabled:opacity-45',
        size === 'lg' ? 'h-12 px-7 text-[15px]' : 'h-9 px-4 text-[14px]',
        variant === 'primary' &&
          'bg-[color:var(--color-accent)] text-white hover:bg-[color:var(--color-accent-hover)] active:translate-y-px',
        variant === 'secondary' &&
          'border border-[color:var(--color-hairline-strong)] bg-[color:var(--color-surface)] text-[color:var(--color-text)] hover:border-[color:var(--color-faint)]',
        variant === 'ghost' && 'text-[color:var(--color-muted)] hover:text-[color:var(--color-text)]',
        variant === 'danger' &&
          'border border-transparent bg-[color:var(--color-danger-soft)] text-[color:var(--color-danger)] hover:brightness-97',
        className,
      )}
    >
      {loading && <Spinner className="h-4 w-4" />}
      {children}
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={clsx('clip-spin', className)} aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <label htmlFor={htmlFor} className="block">
      <span className="mb-1.5 block text-[14px] font-medium text-[color:var(--color-text)]">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block text-[13px] text-[color:var(--color-muted)]">{hint}</span>}
    </label>
  );
}

const inputBase =
  'w-full rounded-[var(--radius)] border border-[color:var(--color-hairline-strong)] bg-[color:var(--color-surface)] px-3.5 text-[15px] ' +
  'placeholder:text-[color:var(--color-faint)] focus:border-[color:var(--color-accent)] focus:outline-none focus:ring-4 focus:ring-[color:var(--color-accent-ring)]/40';

export function TextInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={clsx(inputBase, 'h-11', className)} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...rest} className={clsx(inputBase, 'h-11 appearance-none bg-no-repeat pr-9', className)}
      style={{
        backgroundImage:
          "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%238a8a8a' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")",
        backgroundPosition: 'right 12px center',
      }}
    >
      {children}
    </select>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex items-center gap-3"
    >
      <span
        className={clsx(
          'relative h-6 w-10 shrink-0 rounded-full transition',
          checked ? 'bg-[color:var(--color-accent)]' : 'bg-[color:var(--color-hairline-strong)]',
        )}
      >
        <span
          className={clsx(
            'absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition',
            checked && 'translate-x-4',
          )}
        />
      </span>
      <span className="text-[15px]">{label}</span>
    </button>
  );
}

export function Hairline({ className }: { className?: string }) {
  return <div className={clsx('h-px bg-[color:var(--color-hairline)]', className)} />;
}

export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div className="inline-flex rounded-[var(--radius)] border border-[color:var(--color-hairline-strong)] p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={clsx(
            'rounded-[7px] px-4 py-1.5 text-[14px] font-medium transition',
            value === o.value
              ? 'bg-[color:var(--color-accent)] text-white'
              : 'text-[color:var(--color-muted)] hover:text-[color:var(--color-text)]',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Textarea({ className, ...rest }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...rest}
      className={clsx(
        'w-full rounded-[var(--radius)] border border-[color:var(--color-hairline-strong)] bg-[color:var(--color-surface)] p-3.5 text-[15px] leading-relaxed',
        'placeholder:text-[color:var(--color-faint)] focus:border-[color:var(--color-accent)] focus:outline-none focus:ring-4 focus:ring-[color:var(--color-accent-ring)]/40',
        className,
      )}
    />
  );
}
