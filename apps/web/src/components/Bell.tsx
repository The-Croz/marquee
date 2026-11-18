import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import type { NotificationInboxItem } from '@marquee/shared';
import { api, queryClient } from '../api';
import { Icon } from './Icon';
import { cx } from './ui';

const ago = (ms: number) => {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

/** The bell: what Marquee has told you, newest first. */
export function Bell({ up = false }: { up?: boolean }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const { data } = useQuery({ queryKey: ['notifications'], queryFn: () => api<{ items: NotificationInboxItem[]; unread: number }>('/notifications'), refetchInterval: 30_000 });
  const unread = data?.unread ?? 0;

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  async function markAll() {
    await api('/notifications/read', { body: {} });
    await queryClient.invalidateQueries({ queryKey: ['notifications'] });
  }

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-label={unread ? `Notifications, ${unread} new` : 'Notifications'}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="relative flex size-11 items-center justify-center rounded-lg text-muted hover:bg-raised hover:text-text"
      >
        <Icon name="bell" />
        {unread > 0 && <span className="absolute top-1.5 right-1.5 flex min-w-[18px] items-center justify-center rounded-full bg-amber px-1 text-[11px] font-bold text-amber-ink">{unread > 9 ? '9+' : unread}</span>}
      </button>
      {open && (
        <div role="dialog" aria-label="Notifications" className={cx(up ? "bottom-12 left-0" : "top-12 right-0", "absolute z-30 flex max-h-[70vh] w-[min(360px,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-line-strong bg-panel shadow-2xl")}>
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <span className="font-semibold">Notifications</span>
            <button type="button" onClick={markAll} disabled={!unread} className="min-h-11 text-sm font-medium text-amber disabled:opacity-40">
              Mark all read
            </button>
          </div>
          <ul className="m-0 flex list-none flex-col overflow-y-auto p-0">
            {(data?.items ?? []).length === 0 && <li className="px-4 py-6 text-sm text-muted">Nothing yet. You’ll hear here when something you asked for is ready.</li>}
            {(data?.items ?? []).map((n) => {
              const inner = (
                <>
                  <span className="flex items-baseline justify-between gap-3">
                    <span className={cx('text-sm', n.read ? 'text-soft' : 'font-semibold text-text')}>{n.title}</span>
                    <span className="flex-none text-xs text-dim">{ago(n.createdAt)}</span>
                  </span>
                  <span className="text-[13px] text-muted">{n.body}</span>
                </>
              );
              return (
                <li key={n.id} className="border-b border-line last:border-0">
                  {n.link ? (
                    <Link to={n.link} onClick={() => setOpen(false)} className="flex flex-col gap-0.5 px-4 py-3 text-text no-underline hover:bg-raised hover:text-text">
                      {inner}
                    </Link>
                  ) : (
                    <div className="flex flex-col gap-0.5 px-4 py-3">{inner}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
