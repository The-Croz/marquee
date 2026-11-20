import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import type { Role, SessionUser } from '@marquee/shared';
import { api, queryClient } from '../api';
import { useQuery } from '@tanstack/react-query';
import { Bell } from './Bell';
import { Icon, type IconName } from './Icon';
import { cx } from './ui';

/**
 * The frame around every screen. Desktop: a sidebar in three groups. Phones: a
 * top bar (wordmark, bell, avatar) and a bottom tab bar of five; everything
 * else lives in the avatar's menu.
 */

interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  /** Other paths that light this item up (Library covers the title pages under /movies and /shows). */
  also?: string[];
  roles?: Role[];
}

const ALL: Role[] = ['admin', 'member', 'kid'];

const GROUPS: { label: string | null; items: NavItem[] }[] = [
  {
    label: null,
    items: [
      { to: '/', label: 'Home', icon: 'home' },
      { to: '/discover', label: 'Discover', icon: 'discover' },
      { to: '/library', label: 'Library', icon: 'movies', also: ['/movies', '/shows'] },
      { to: '/calendar', label: 'Calendar', icon: 'calendar' },
    ],
  },
  {
    label: 'Activity',
    items: [
      { to: '/requests', label: 'Requests', icon: 'requests' },
      { to: '/downloads', label: 'Downloads', icon: 'downloads', roles: ['admin', 'member'] },
      { to: '/activity', label: 'Watching', icon: 'activity', roles: ['admin'] },
    ],
  },
  {
    label: 'Manage',
    items: [{ to: '/settings', label: 'Settings', icon: 'settings', roles: ['admin'] }],
  },
];

/** The phone's bottom bar: at most five. */
const TABS: Record<Role, string[]> = {
  admin: ['/', '/discover', '/library', '/requests', '/downloads'],
  member: ['/', '/discover', '/library', '/requests', '/calendar'],
  kid: ['/', '/discover', '/library', '/requests'],
};

const allowed = (n: NavItem, role: Role) => (n.roles ?? ALL).includes(role);

function useActive() {
  const { pathname } = useLocation();
  return (n: NavItem) => (n.to === '/' ? pathname === '/' : [n.to, ...(n.also ?? [])].some((p) => pathname === p || pathname.startsWith(`${p}/`)));
}

export function Shell({ user }: { user: SessionUser; version?: string }) {
  const { data: summary } = useQuery({ queryKey: ['requests', 'summary'], queryFn: () => api<{ pending: number }>('/requests/summary'), refetchInterval: 30_000, enabled: user.role === 'admin' });
  const pending = summary?.pending ?? 0;
  const isActive = useActive();
  const items = GROUPS.flatMap((g) => g.items).filter((n) => allowed(n, user.role));
  const tabs = TABS[user.role].map((to) => items.find((n) => n.to === to)).filter((n): n is NavItem => !!n);

  const badge = (n: NavItem) =>
    n.to === '/requests' && pending > 0 ? (
      <span aria-label={`${pending} waiting`} className="rounded-full bg-amber px-1.5 text-caption font-bold text-amber-ink">
        {pending}
      </span>
    ) : null;

  return (
    <div className="flex min-h-screen flex-col bg-ink md:flex-row md:items-start">
      {/* Desktop sidebar */}
      <nav aria-label="Main" className="sticky top-0 hidden h-screen w-[232px] flex-none flex-col px-3 py-6 md:flex">
        <div className="flex items-center gap-2.5 px-3 pb-6">
          <Wordmark />
          <Bell />
        </div>
        <div className="flex flex-col gap-0.5">
          {GROUPS.map((g) => {
            const shown = g.items.filter((n) => allowed(n, user.role));
            if (!shown.length) return null;
            return (
              <div key={g.label ?? 'main'} className="flex flex-col gap-0.5">
                {g.label && <div className="px-3 pt-5 pb-1.5 text-caption font-semibold tracking-[0.14em] text-dim uppercase">{g.label}</div>}
                {shown.map((n) => (
                  <Link
                    key={n.to}
                    to={n.to}
                    aria-current={isActive(n) ? 'page' : undefined}
                    className={cx(
                      'flex min-h-11 items-center gap-3 rounded-lg px-3 text-body no-underline',
                      isActive(n) ? 'bg-raised font-semibold text-text hover:text-text' : 'text-muted hover:bg-panel hover:text-text',
                    )}
                  >
                    <Icon name={n.icon} className={isActive(n) ? 'text-amber' : undefined} />
                    <span className="flex-1">{n.label}</span>
                    {badge(n)}
                  </Link>
                ))}
              </div>
            );
          })}
        </div>
        <div className="mt-auto border-t border-line pt-3">
          <AccountMenu user={user} placement="up" />
        </div>
      </nav>

      {/* Phone top bar */}
      <header className="sticky top-0 z-20 flex items-center gap-1 border-b border-line bg-ink/90 px-4 py-2 backdrop-blur md:hidden">
        <Wordmark />
        <Bell />
        <AccountMenu user={user} placement="down" compact />
      </header>

      <main className="box-border flex min-w-0 flex-1 flex-col gap-8 px-4 pt-5 pb-28 sm:px-10 md:pt-8 md:pb-16">
        <Outlet />
      </main>

      {/* Phone tab bar */}
      <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-20 grid border-t border-line bg-panel/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden" style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}>
        {tabs.map((n) => (
          <Link
            key={n.to}
            to={n.to}
            aria-current={isActive(n) ? 'page' : undefined}
            className={cx('relative flex min-h-14 flex-col items-center justify-center gap-1 text-caption no-underline', isActive(n) ? 'font-semibold text-amber hover:text-amber' : 'text-dim hover:text-text')}
          >
            <Icon name={n.icon} />
            {n.label}
            {n.to === '/requests' && pending > 0 && <span className="absolute top-1.5 left-[calc(50%+6px)] size-2 rounded-full bg-amber" aria-label={`${pending} waiting`} />}
          </Link>
        ))}
      </nav>
    </div>
  );
}

function Wordmark() {
  return (
    <Link to="/" aria-label="Marquee home" className="flex min-h-11 flex-1 items-center gap-2.5 text-text no-underline hover:text-text">
      <span className="bulb-on size-2.5 rounded-full bg-amber" aria-hidden="true" />
      <span className="font-display text-[30px] leading-none">Marquee</span>
    </Link>
  );
}

/** The avatar: your name, and a menu with what isn't in the main nav, then Sign out. */
function AccountMenu({ user, placement, compact }: { user: SessionUser; placement: 'up' | 'down'; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  async function signOut() {
    await api('/auth/logout', { body: {} });
    queryClient.clear();
    navigate('/login', { replace: true });
  }

  const admin = user.role === 'admin';
  // On phones the menu also holds what the five tabs leave out.
  const links: { to: string; label: string; icon: IconName; phoneOnly?: boolean }[] = admin
    ? [
        { to: '/calendar', label: 'Calendar', icon: 'calendar', phoneOnly: true },
        { to: '/activity', label: 'Watching', icon: 'activity', phoneOnly: true },
        { to: '/settings', label: 'Settings', icon: 'settings', phoneOnly: true },
        { to: '/settings/account', label: 'My account', icon: 'user' },
      ]
    : [
        ...(user.role === 'kid' ? [{ to: '/calendar', label: 'Calendar', icon: 'calendar' as const, phoneOnly: true }] : []),
        { to: '/history', label: 'My history', icon: 'history' },
        { to: '/settings', label: 'Settings', icon: 'settings' },
      ];
  const avatar = (
    <span className="flex size-9 flex-none items-center justify-center rounded-full bg-amber text-sm font-bold text-amber-ink" aria-hidden="true">
      {user.displayName.slice(0, 1).toUpperCase()}
    </span>
  );

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${user.displayName}: account menu`}
        onClick={() => setOpen((o) => !o)}
        className={cx('flex min-h-11 items-center gap-3 rounded-lg text-left hover:bg-panel', compact ? 'px-1' : 'w-full px-2 py-1.5')}
      >
        {avatar}
        {!compact && (
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold">{user.displayName}</span>
            <span className="block text-caption text-dim capitalize">{user.role}</span>
          </span>
        )}
      </button>
      {open && (
        <div role="menu" className={cx('absolute z-40 flex w-56 flex-col rounded-xl border border-line-strong bg-panel p-1.5 shadow-2xl', placement === 'up' ? 'bottom-full left-0 mb-2' : 'top-full right-0 mt-2')}>
          {links.map((l) => (
            <Link
              key={l.to + l.label}
              role="menuitem"
              to={l.to}
              className={cx('flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm text-soft no-underline hover:bg-raised hover:text-text', l.phoneOnly && 'md:hidden')}
            >
              <Icon name={l.icon} className="text-dim" />
              {l.label}
            </Link>
          ))}
          <div className="my-1 border-t border-line" />
          <button type="button" role="menuitem" onClick={signOut} className="flex min-h-11 items-center gap-3 rounded-lg px-3 text-left text-sm text-soft hover:bg-raised hover:text-text">
            <Icon name="logout" className="text-dim" />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
