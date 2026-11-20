import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { cx } from './ui';

/**
 * Things that sit on top of a page: Menu (a list of actions under a button),
 * Sheet (a panel that slides up on phones and opens in the middle on
 * desktop), and Toast (a short note at the bottom, with Undo when an action
 * can be taken back).
 */

// ---------------- Menu ----------------

/**
 * A button that opens a list of actions. Arrow keys move between items, Escape
 * or a click outside closes it, and focus goes back to the button.
 * Items are `role="menuitem"` links or buttons passed as children.
 */
export function Menu({
  trigger,
  label,
  placement = 'down',
  className,
  children,
}: {
  /** What the button shows. */
  trigger: ReactNode;
  /** The button's accessible name. */
  label: string;
  placement?: 'up' | 'down';
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    visibleItems(list.current)[0]?.focus();
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, close]);

  function onKeyDown(e: ReactKeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      close(true);
      return;
    }
    if (e.key === 'Tab') return close(false);
    const items = visibleItems(list.current);
    const at = items.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => items[(i + items.length) % items.length]?.focus();
    if (e.key === 'ArrowDown') go(at + 1);
    else if (e.key === 'ArrowUp') go(at - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(items.length - 1);
    else return;
    e.preventDefault();
  }

  return (
    <div ref={box} className={cx('relative', className)}>
      <button
        ref={button}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={label}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            setOpen(true);
          } else if (e.key === 'Escape' && open) {
            e.preventDefault();
            close(true);
          }
        }}
        className="flex min-h-11 w-full items-center rounded-lg text-left hover:bg-panel"
      >
        {trigger}
      </button>
      {open && (
        <div
          ref={list}
          id={id}
          role="menu"
          aria-label={label}
          onKeyDown={onKeyDown}
          // A click on an item closes the menu; links navigate as usual.
          onClick={(e) => (e.target as HTMLElement).closest('[role=menuitem]') && close(false)}
          className={cx(
            'absolute z-40 flex w-56 flex-col rounded-xl border border-line-strong bg-panel p-1.5 shadow-2xl',
            placement === 'up' ? 'bottom-full left-0 mb-2' : 'top-full right-0 mt-2',
          )}
        >
          {children}
        </div>
      )}
    </div>
  );
}

/** Menu items that are showing (some are phone-only). */
const visibleItems = (list: HTMLElement | null) => [...(list?.querySelectorAll<HTMLElement>('[role=menuitem]') ?? [])].filter((el) => el.getClientRects().length > 0);

/** Class names for a menu item, so links and buttons look the same. */
export const menuItemClass = 'flex min-h-11 items-center gap-3 rounded-lg px-3 text-left text-sm text-soft no-underline outline-none hover:bg-raised hover:text-text focus-visible:bg-raised focus-visible:text-text';

export function MenuDivider() {
  return <div role="separator" className="my-1 border-t border-line" />;
}

// ---------------- Sheet ----------------

/**
 * A panel over the page. Phones: slides up from the bottom. Wider screens: a
 * dialog in the middle. Built on <dialog>, so focus stays inside, Escape
 * closes it and the page behind can't be clicked.
 */
export function Sheet({
  open,
  onClose,
  title,
  hideTitle,
  children,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Keep the title for screen readers only. */
  hideTitle?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      // A click on the dimmed backdrop lands on the dialog itself.
      onMouseDown={(e) => e.target === ref.current && onClose()}
      className={cx(
        'sheet m-0 mt-auto w-full max-w-none border border-line-strong bg-panel p-0 text-text shadow-2xl backdrop:bg-black/60',
        'max-h-[85vh] rounded-t-2xl sm:m-auto sm:max-h-[80vh] sm:w-[min(560px,calc(100vw-48px))] sm:rounded-2xl',
        className,
      )}
    >
      {open && (
        <div className="flex max-h-[inherit] flex-col">
          <div className="flex items-center gap-3 px-5 pt-3 pb-2">
            <span aria-hidden="true" className="absolute top-2 left-1/2 h-1 w-10 -translate-x-1/2 rounded-full bg-line-strong sm:hidden" />
            <h2 id={titleId} className={cx('m-0 flex-1 pt-3 text-heading font-semibold', hideTitle && 'sr-only')}>
              {title}
            </h2>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-[max(20px,env(safe-area-inset-bottom))]">{children}</div>
        </div>
      )}
    </dialog>
  );
}

// ---------------- Toast ----------------

interface ToastInput {
  message: string;
  /** Offer Undo. The toast says what happened if undoing fails. */
  undo?: () => Promise<unknown> | void;
  tone?: 'info' | 'error';
}
interface ToastItem extends ToastInput {
  id: number;
  state: 'shown' | 'undoing' | 'undone' | 'failed';
}

const ToastContext = createContext<(t: ToastInput) => void>(() => {});

/** `const toast = useToast(); toast({ message: 'Stopped looking for 3 movies', undo: () => … })` */
export const useToast = () => useContext(ToastContext);

const TOAST_MS = 6000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const next = useRef(1);
  const timers = useRef(new Map<number, number>());

  const dismiss = useCallback((id: number) => {
    window.clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setToasts((all) => all.filter((t) => t.id !== id));
  }, []);
  const later = useCallback(
    (id: number, ms = TOAST_MS) => {
      window.clearTimeout(timers.current.get(id));
      timers.current.set(id, window.setTimeout(() => dismiss(id), ms));
    },
    [dismiss],
  );
  const show = useCallback(
    (t: ToastInput) => {
      const id = next.current++;
      // Keep at most three on screen.
      setToasts((all) => [...all.slice(-2), { ...t, id, state: 'shown' }]);
      later(id, t.undo ? TOAST_MS + 2000 : TOAST_MS);
    },
    [later],
  );
  const set = (id: number, state: ToastItem['state']) => setToasts((all) => all.map((t) => (t.id === id ? { ...t, state } : t)));

  async function undo(t: ToastItem) {
    window.clearTimeout(timers.current.get(t.id));
    set(t.id, 'undoing');
    try {
      await t.undo?.();
      set(t.id, 'undone');
    } catch {
      set(t.id, 'failed');
    }
    later(t.id, 3000);
  }

  return (
    <ToastContext.Provider value={show}>
      {children}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-[calc(72px+env(safe-area-inset-bottom))] z-50 flex flex-col items-center gap-2 px-4 md:bottom-6"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            onMouseEnter={() => window.clearTimeout(timers.current.get(t.id))}
            onMouseLeave={() => later(t.id, 3000)}
            className={cx(
              'toast pointer-events-auto flex w-full max-w-[440px] items-center gap-3 rounded-xl border bg-raised py-1.5 pr-1.5 pl-4 text-sm shadow-2xl',
              t.tone === 'error' || t.state === 'failed' ? 'border-warn/60' : 'border-line-strong',
            )}
          >
            <span className="min-w-0 flex-1 py-2 text-text">
              {t.state === 'undone' ? 'Undone.' : t.state === 'failed' ? 'That couldn’t be undone. Try again from the page.' : t.message}
            </span>
            {t.undo && t.state !== 'undone' && t.state !== 'failed' && (
              <button
                type="button"
                disabled={t.state === 'undoing'}
                onClick={() => void undo(t)}
                className="min-h-11 rounded-lg px-3 font-semibold text-amber hover:bg-panel disabled:opacity-60"
              >
                {t.state === 'undoing' ? 'Undoing…' : 'Undo'}
              </button>
            )}
            <button type="button" aria-label="Dismiss" onClick={() => dismiss(t.id)} className="flex size-11 flex-none items-center justify-center rounded-lg text-dim hover:bg-panel hover:text-text">
              <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
