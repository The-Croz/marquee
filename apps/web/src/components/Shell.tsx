import { NavLink, Outlet, useNavigate } from 'react-router';
import type { SessionUser } from '@marquee/shared';
import { api, queryClient } from '../api';
import { Icon, type IconName } from './Icon';
import { cx } from './ui';

interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  adminOnly?: boolean;
  hideForKids?: boolean;
}

const NAV: NavItem[] = [
  { to: '/', label: 'Home', icon: 'home' },
  { to: '/discover', label: 'Discover', icon: 'discover' },
  { to: '/movies', label: 'Movies', icon: 'movies' },
  { to: '/shows', label: 'Shows', icon: 'shows' },
  { to: '/requests', label: 'Requests', icon: 'requests' },
  { to: '/downloads', label: 'Downloads', icon: 'downloads', hideForKids: true },
  { to: '/activity', label: 'Activity', icon: 'activity', hideForKids: true },
  { to: '/quality', label: 'Quality', icon: 'quality', adminOnly: true },
  { to: '/compare', label: 'Compare', icon: 'compare', adminOnly: true },
  { to: '/switch-over', label: 'Switch over', icon: 'switch', adminOnly: true },
  { to: '/settings/account', label: 'Settings', icon: 'settings' },
];

export function Shell({ user, version }: { user: SessionUser; version: string }) {
  const navigate = useNavigate();
  const items = NAV.filter((n) => (!n.adminOnly || user.role === 'admin') && (!n.hideForKids || user.role !== 'kid'));

  async function signOut() {
    await api('/auth/logout', { body: {} });
    queryClient.clear();
    navigate('/login', { replace: true });
  }

  const avatar = (
    <span className="flex size-9 flex-none items-center justify-center rounded-full bg-amber text-sm font-bold text-amber-ink" aria-hidden="true">
      {user.displayName.slice(0, 1).toUpperCase()}
    </span>
  );
  const signOutButton = (
    <button type="button" onClick={signOut} aria-label="Sign out" className="flex size-11 items-center justify-center rounded-lg text-muted hover:bg-raised hover:text-text">
      <Icon name="logout" />
    </button>
  );

  return (
    <div className="flex min-h-screen flex-col bg-ink md:flex-row md:items-start">
      {/* Sidebar on desktop; compact top bar with scrolling tabs on phones */}
      <nav aria-label="Main" className="box-border flex flex-col gap-1 px-4 pt-4 md:sticky md:top-0 md:w-[240px] md:flex-none md:py-7">
        <div className="flex items-center gap-2.5 px-3 pb-3 md:pb-6">
          <span className="size-2.5 rounded-full bg-amber" aria-hidden="true" />
          <span className="flex-1 font-display text-[30px] leading-none">Marquee</span>
          <span className="flex items-center gap-1 md:hidden">
            {avatar}
            {signOutButton}
          </span>
        </div>
        <div className="-mx-4 flex gap-1 overflow-x-auto px-4 pb-2 md:mx-0 md:flex-col md:overflow-visible md:px-0 md:pb-0">
          {items.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                cx(
                  'flex flex-none items-center gap-2 rounded-full px-3.5 py-2.5 text-[15px] whitespace-nowrap no-underline md:gap-3 md:rounded-[10px] md:px-3 md:py-[11px]',
                  isActive ? 'bg-raised font-semibold text-text hover:text-text' : 'text-muted hover:bg-panel hover:text-text',
                )
              }
            >
              {({ isActive }) => (
                <>
                  <Icon name={item.icon} className={isActive ? 'text-amber' : undefined} />
                  {item.label}
                </>
              )}
            </NavLink>
          ))}
        </div>

        <div className="mt-7 hidden items-center gap-3 border-t border-line px-3 pt-4 md:flex">
          {avatar}
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold">{user.displayName}</div>
            <div className="text-xs text-dim capitalize">{user.role}</div>
          </div>
          {signOutButton}
        </div>
        <div className="hidden px-3 pt-3 font-mono text-[11px] text-dim md:block">Marquee {version}</div>
      </nav>

      <main className="box-border flex min-w-0 flex-1 flex-col gap-8 px-5 pt-4 pb-16 sm:px-10 md:pt-7">
        <Outlet />
      </main>
    </div>
  );
}
