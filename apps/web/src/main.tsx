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
import { AboutPage, AccountPage, ServicesPage, SettingsLayout, UsersPage } from './pages/Settings';
import { SourcesPage } from './pages/Sources';
import { DownloaderPage } from './pages/Downloader';
import { DownloadsPage } from './pages/Downloads';
import { ActivityPage } from './pages/Activity';
import { MyHistoryPage, PersonPage } from './pages/Person';
import { CalendarPage } from './pages/Calendar';
import { DiscoverPageView } from './pages/Discover';
import { RequestsPage } from './pages/Requests';
import { WatchSyncPage } from './pages/WatchSync';
import { AutomationPage } from './pages/Automation';
import { DiscoverSettingsPage, MyNotificationsPage, NotificationSettingsLayout, SharedAlertsPage, WordingPage } from './pages/NotificationSettings';
import { LibraryHome, LibraryPage, LibraryRedirect } from './pages/Library';
import { DiscoverTitlePage, MovieDetailPage, ShowDetailPage } from './pages/Title';
import { TmdbPersonPage } from './pages/TmdbPerson';
import { UnmatchedPage } from './pages/Unmatched';
import { SearchPage } from './pages/Search';
import { QualityPage } from './pages/Quality';
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
    element: <RequireUser render={(s) => <Shell user={s.user} version={s.version} />} />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'discover', element: <DiscoverPageView /> },
      { path: 'discover/person/:id', element: <TmdbPersonPage /> },
      { path: 'discover/:kind/:id', element: <DiscoverTitlePage /> },
      { path: 'library', element: <LibraryHome /> },
      { path: 'library/movies', element: <RequireUser render={(s) => <LibraryPage key="movies" kind="movie" user={s.user} />} /> },
      { path: 'library/shows', element: <RequireUser render={(s) => <LibraryPage key="shows" kind="series" user={s.user} />} /> },
      { path: 'movies', element: <LibraryRedirect to="movies" /> },
      { path: 'movies/:id', element: <MovieDetailPage /> },
      { path: 'shows', element: <LibraryRedirect to="shows" /> },
      { path: 'shows/:id', element: <ShowDetailPage /> },
      { path: 'library/unmatched', element: <RequireUser render={(s) => <AdminOnly status={s}><UnmatchedPage /></AdminOnly>} /> },
      { path: 'search', element: <RequireUser render={(s) => (s.user.role === 'kid' ? <Navigate to="/" replace /> : <SearchPage user={s.user} />)} /> },
      { path: 'requests', element: <RequireUser render={(s) => <RequestsPage user={s.user} />} /> },
      { path: 'downloads', element: <DownloadsPage /> },
      { path: 'activity/people/:name', element: <RequireUser render={(s) => <AdminOnly status={s}><PersonPage /></AdminOnly>} /> },
      { path: 'activity', element: <RequireUser render={(s) => <AdminOnly status={s}><ActivityPage /></AdminOnly>} /> },
      { path: 'quality', element: <Navigate to="/settings/quality" replace /> },
      { path: 'calendar', element: <CalendarPage /> },
      { path: 'history', element: <MyHistoryPage /> },
      {
        path: 'settings',
        element: <RequireUser render={(s) => <SettingsLayout status={s} />} />,
        children: [
          { index: true, element: null },
          { path: 'account', element: <AccountPage /> },
          { path: 'about', element: <AboutPage /> },
          { path: 'quality', element: <RequireUser render={(st) => <AdminOnly status={st}><QualityPage /></AdminOnly>} /> },
          { path: 'discover', element: <DiscoverSettingsPage /> },
          {
            path: 'notifications',
            element: <NotificationSettingsLayout />,
            children: [
              { index: true, element: <MyNotificationsPage /> },
              { path: 'shared', element: <RequireUser render={(s) => <AdminOnly status={s}><SharedAlertsPage /></AdminOnly>} /> },
              { path: 'wording', element: <RequireUser render={(s) => <AdminOnly status={s}><WordingPage /></AdminOnly>} /> },
            ],
          },
          { path: 'users', element: <UsersPage /> },
          { path: 'services', element: <ServicesPage /> },
          { path: 'sources', element: <SourcesPage /> },
          { path: 'downloader', element: <DownloaderPage /> },
          { path: 'automation', element: <RequireUser render={(st) => <AdminOnly status={st}><AutomationPage /></AdminOnly>} /> },
          { path: 'watched-sync', element: <RequireUser render={(st) => <AdminOnly status={st}><WatchSyncPage /></AdminOnly>} /> },
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

