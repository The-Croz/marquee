import { useState } from 'react';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';

const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ');

type Variant = 'primary' | 'ghost' | 'danger';

export function Button({ variant = 'primary', className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      {...props}
      className={cx(
        'inline-flex h-11 items-center justify-center gap-2 rounded-xl px-5 text-body font-semibold transition disabled:cursor-not-allowed disabled:opacity-50',
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
        className="h-12 rounded-xl border border-line-strong bg-ink px-4 text-body text-text placeholder:text-dim focus:border-amber focus:outline-none"
      />
      {hint && <span className="text-xs text-dim">{hint}</span>}
    </div>
  );
}

export function Card({ children, className, ...rest }: { children: ReactNode; className?: string } & React.HTMLAttributes<HTMLElement>) {
  return (
    <section {...rest} className={cx('rounded-2xl border border-line bg-panel p-6', className)}>
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

/** An on/off switch. A real button with role="switch", so it reads right and toggles with Space or Enter. */
export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (on: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="group flex min-h-11 min-w-11 flex-none items-center justify-center disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span className={cx('relative h-6 w-10 rounded-full transition-colors', checked ? 'bg-amber' : 'bg-line-strong')}>
        <span className={cx('absolute top-1 size-4 rounded-full transition-[left]', checked ? 'left-5 bg-amber-ink' : 'left-1 bg-soft')} />
      </span>
    </button>
  );
}

export { cx };

/** Someone's picture (from Plex or single sign-on), or their initial. */
export function Avatar({ name, src, className }: { name: string; src?: string | null; className?: string }) {
  const [broken, setBroken] = useState<string | null>(null);
  const base = cx('flex flex-none items-center justify-center rounded-full', className ?? 'size-9 text-sm');
  return src && broken !== src ? (
    <img src={src} alt="" onError={() => setBroken(src)} className={cx(base, 'object-cover')} />
  ) : (
    <span aria-hidden="true" className={cx(base, 'bg-amber font-bold text-amber-ink')}>
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}
