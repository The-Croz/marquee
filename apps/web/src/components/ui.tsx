import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';

const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ');

type Variant = 'primary' | 'ghost' | 'danger';

export function Button({ variant = 'primary', className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      {...props}
      className={cx(
        'inline-flex h-11 items-center justify-center gap-2 rounded-xl px-5 text-[15px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-50',
        variant === 'primary' && 'bg-amber text-amber-ink hover:bg-amber-hi',
        variant === 'ghost' && 'border border-line-strong bg-transparent font-medium text-text hover:bg-raised',
        variant === 'danger' && 'border border-warn/40 bg-transparent font-medium text-warn hover:bg-warn/10',
        className,
      )}
    />
  );
}

export function Field({ label, hint, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  const id = props.id ?? props.name;
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-sm font-medium text-soft">
        {label}
      </label>
      <input
        id={id}
        {...props}
        className="h-12 rounded-xl border border-line-strong bg-ink px-4 text-[15px] text-text placeholder:text-dim focus:border-amber focus:outline-none"
      />
      {hint && <span className="text-xs text-dim">{hint}</span>}
    </div>
  );
}

export function Card({ children, className, ...rest }: { children: ReactNode; className?: string } & React.HTMLAttributes<HTMLElement>) {
  return (
    <section {...rest} className={cx('rounded-[18px] border border-line bg-panel p-6', className)}>
      {children}
    </section>
  );
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'error' | 'success'; children: ReactNode }) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cx(
        'rounded-xl px-4 py-3 text-sm',
        tone === 'info' && 'bg-raised text-soft',
        tone === 'error' && 'bg-warn/12 text-warn',
        tone === 'success' && 'bg-teal/12 text-teal-hi',
      )}
    >
      {children}
    </div>
  );
}

export function Progress({ value, color = 'bg-blue', className }: { value: number; color?: string; className?: string }) {
  return (
    <div className={cx('h-1.5 overflow-hidden rounded-full bg-white/12', className)} role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100}>
      <div className={cx('h-full rounded-full', color)} style={{ width: `${value}%` }} />
    </div>
  );
}

export { cx };
