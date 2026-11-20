import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink } from 'react-router';
import { cx } from './ui';

/**
 * The top of every screen: a title (Inter, not the serif: the serif is for
 * film titles), one optional line of live facts, actions on the right, and an
 * ⓘ that holds how the page works. Also sets the browser tab's title.
 */
export function PageHeader({
  title,
  meta,
  back,
  actions,
  info,
  docTitle,
}: {
  title: ReactNode;
  meta?: ReactNode;
  /** `wideHidden`: hide it on wide screens, where a side list already leads back. */
  back?: { to: string; label: string; wideHidden?: boolean };
  actions?: ReactNode;
  info?: ReactNode;
  /** The browser tab's title, when `title` isn't plain text. */
  docTitle?: string;
}) {
  useDocTitle(docTitle ?? (typeof title === 'string' ? title : undefined));
  return (
    <header className="flex flex-col gap-1">
      {back && (
        <Link to={back.to} className={cx('-mt-2 flex min-h-11 items-center self-start text-sm text-muted no-underline hover:text-text', back.wideHidden && 'lg:hidden')}>
          ← {back.label}
        </Link>
      )}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex items-center gap-1">
            <h1 className="m-0 text-title font-semibold tracking-tight">{title}</h1>
            {info && <InfoTip label="How this works">{info}</InfoTip>}
          </div>
          {meta && <div className="text-sm text-dim">{meta}</div>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2 max-sm:w-full">{actions}</div>}
      </div>
    </header>
  );
}

/** Sets the browser tab's title to "<title> · Marquee" while the page is open. */
export function useDocTitle(title: string | undefined) {
  useEffect(() => {
    if (!title) return;
    const before = document.title;
    document.title = `${title} · Marquee`;
    return () => {
      document.title = before;
    };
  }, [title]);
}

/** An ⓘ button that opens a small note: where "how it works" text lives instead of on the page. */
export function InfoTip({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const ref = useRef<HTMLSpanElement>(null);
  const note = useRef<HTMLSpanElement>(null);
  const [shift, setShift] = useState(0);
  // Keep the note on screen: slide it left when the ⓘ sits near the right edge.
  useLayoutEffect(() => {
    if (!open || !note.current) return setShift(0);
    const r = note.current.getBoundingClientRect();
    const over = r.right - shift - (document.documentElement.clientWidth - 12);
    setShift(over > 0 ? over : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);
  return (
    <span ref={ref} className={cx('relative inline-flex', className)}>
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className="flex size-11 items-center justify-center rounded-full text-dim hover:text-text aria-expanded:text-amber"
      >
        <svg viewBox="0 0 20 20" className="size-[18px]" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
          <circle cx="10" cy="10" r="8" />
          <path d="M10 9v5M10 6.2v.1" strokeLinecap="round" />
        </svg>
      </button>
      {open && (
        <span
          id={id}
          ref={note}
          role="note"
          style={shift ? { transform: `translateX(-${shift}px)` } : undefined}
          className="absolute top-full left-0 z-30 mt-1 w-[min(340px,80vw)] rounded-lg border border-line-strong bg-raised p-4 text-sm leading-relaxed font-normal tracking-normal text-soft normal-case shadow-2xl"
        >
          {children}
        </span>
      )}
    </span>
  );
}

/** A status dot: ok (working), busy (on its way), attention (waiting on you), problem (needs fixing). */
export function StatusDot({ tone, className }: { tone: 'ok' | 'busy' | 'attention' | 'problem' | 'off'; className?: string }) {
  const bg = { ok: 'bg-teal', busy: 'bg-blue', attention: 'bg-amber', problem: 'bg-warn', off: 'bg-line-strong' }[tone];
  return <span aria-hidden="true" className={cx('inline-block size-2 flex-none rounded-full', bg, className)} />;
}

/** Pill tabs. Links when given `to`, buttons otherwise. */
export function Tabs<T extends string>({
  label,
  items,
  value,
  onChange,
}: {
  label: string;
  items: { value: T; label: ReactNode; to?: string; count?: number }[];
  value?: T;
  onChange?: (v: T) => void;
}) {
  const cls = (active: boolean) =>
    cx(
      'inline-flex min-h-11 items-center gap-2 rounded-full border px-4 text-sm font-medium whitespace-nowrap no-underline',
      active ? 'border-amber bg-amber text-amber-ink hover:text-amber-ink' : 'border-line bg-panel text-soft hover:text-text',
    );
  return (
    <nav aria-label={label} className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
      {items.map((t) =>
        t.to ? (
          <NavLink key={t.value} to={t.to} end className={({ isActive }) => cls(isActive)}>
            {t.label}
            {t.count !== undefined && <span className="tabular-nums opacity-70">{t.count}</span>}
          </NavLink>
        ) : (
          <button key={t.value} type="button" aria-pressed={value === t.value} onClick={() => onChange?.(t.value)} className={cls(value === t.value)}>
            {t.label}
            {t.count !== undefined && <span className="tabular-nums opacity-70">{t.count}</span>}
          </button>
        ),
      )}
    </nav>
  );
}

/** An empty list: says why it's empty and gives one next step. */
export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: { to: string; label: string } }) {
  return (
    <div className="flex flex-col items-start gap-2 rounded-2xl border border-dashed border-line-strong px-6 py-8">
      <h2 className="m-0 text-heading font-semibold">{title}</h2>
      {children && <p className="m-0 max-w-[560px] text-sm text-soft">{children}</p>}
      {action && (
        <Link to={action.to} className="mt-1 inline-flex h-11 items-center rounded-lg border border-line-strong px-4 text-sm font-medium text-text no-underline hover:bg-raised hover:text-text">
          {action.label}
        </Link>
      )}
    </div>
  );
}
