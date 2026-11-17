import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Navigate, RouterProvider, createBrowserRouter, useLocation } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import type { AuthStatus, SessionUser } from '@marquee/shared';
import { queryClient, useAuthStatus } from './api';
import { Shell } from './components/Shell';
import { LoginPage } from './pages/Login';
import { SetupPage } from './pages/Setup';
import { HomePage } from './pages/Home';
import { Placeholder } from './pages/Placeholder';
import { AccountPage, ServicesPage, SettingsLayout, UsersPage } from './pages/Settings';
import { LibraryPage } from './pages/Library';
import { MovieDetailPage, ShowDetailPage } from './pages/TitleDetail';
import { UnmatchedPage } from './pages/Unmatched';
import { SearchPage } from './pages/Search';
import './styles.css';

/** Sends people to setup or sign-in as needed, then renders the app shell. */
function RequireUser({ render }: { render: (status: AuthStatus & { user: SessionUser }) => React.ReactNode }) {
  const { data, isLoading, error } = useAuthStatus();
  const location = useLocation();
  if (isLoading) return <div className="min-h-screen bg-ink" />;
  if (error || !data) return <p className="p-10 text-warn">Couldn't reach the Marquee server.</p>;
  if (data.setupRequired) return <Navigate to="/setup" replace />;
  if (!data.user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <>{render(data as AuthStatus & { user: SessionUser })}</>;
}

function AdminOnly({ status, children }: { status: AuthStatus; children: React.ReactNode }) {
  return status.user?.role === 'admin' ? <>{children}</> : <Navigate to="/" replace />;
}

const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  { path: '/setup', element: <SetupPage /> },
  {
    element: <RequireUser render={(s) => <Shell user={s.user} />} />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'discover', element: <Placeholder title="Discover" milestone={5}>Browse trending and upcoming movies and shows and request them. Kid profiles only see kid-safe titles.</Placeholder> },
      { path: 'movies', element: <RequireUser render={(s) => <LibraryPage key="movies" kind="movie" user={s.user} />} /> },
      { path: 'movies/:id', element: <MovieDetailPage /> },
      { path: 'shows', element: <RequireUser render={(s) => <LibraryPage key="shows" kind="series" user={s.user} />} /> },
      { path: 'shows/:id', element: <ShowDetailPage /> },
      { path: 'library/unmatched', element: <RequireUser render={(s) => <AdminOnly status={s}><UnmatchedPage /></AdminOnly>} /> },
      { path: 'search', element: <RequireUser render={(s) => (s.user.role === 'kid' ? <Navigate to="/" replace /> : <SearchPage user={s.user} />)} /> },
      { path: 'requests', element: <Placeholder title="Requests" milestone={5}>Requests from the family, with approvals for kid profiles.</Placeholder> },
      { path: 'downloads', element: <Placeholder title="Downloads" milestone={3}>Your qBittorrent queue in plain English: what's downloading, what's stuck, and one-tap fixes.</Placeholder> },
      { path: 'activity', element: <Placeholder title="Activity" milestone={6}>Who's watching now and watch history across Plex and Jellyfin.</Placeholder> },
      {
        path: 'quality',
        element: (
          <RequireUser
            render={(s) => (
              <AdminOnly status={s}>
                <Placeholder title="Quality" milestone={2}>Cinema, Everyday HD and Kids & Cartoons profiles built on the TRaSH Guides, explained in plain English.</Placeholder>
              </AdminOnly>
            )}
          />
        ),
      },
      {
        path: 'settings',
        element: <RequireUser render={(s) => <SettingsLayout status={s} />} />,
        children: [
          { index: true, element: <Navigate to="account" replace /> },
          { path: 'account', element: <AccountPage /> },
          { path: 'users', element: <UsersPage /> },
          { path: 'services', element: <ServicesPage /> },
        ],
      },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);

