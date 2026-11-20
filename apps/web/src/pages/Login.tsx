import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import type { SessionUser, SignInWall } from '@marquee/shared';
import { api, ApiFailure, refreshAuth, useAuthStatus } from '../api';
import { plexSignIn } from '../plex';
import { Button, Field, Notice, cx } from '../components/ui';
import { tmdbImage } from '../components/Poster';

const ERRORS: Record<string, string> = {
  oidc_expired: 'That sign-in took too long. Please try again.',
  oidc_failed: "Single sign-on didn't complete. Please try again.",
  oidc_unreachable: "Marquee couldn't reach your sign-on provider. Check that it's running and that Marquee can reach its address.",
  oidc_no_account: "That account isn't set up in Marquee yet. Ask an admin to add you.",
  oidc_account_exists: 'You already have a Marquee account. Sign in with your password, then link single sign-on under Settings → Account.',
};

/**
 * A slowly drifting wall of popular posters behind the sign-in card, dimmed so
 * the card stays easy to read. Popular titles from TMDB, never your library:
 * anyone can see this page. Nothing shows without a TMDB key.
 */
function PosterWall() {
  const { data } = useQuery({ queryKey: ['auth', 'wall'], queryFn: () => api<SignInWall>('/auth/wall'), staleTime: 60 * 60_000, retry: false });
  const posters = data?.posters ?? [];
  if (posters.length < 8) return null;
  // Six columns, each a loop of posters, alternate columns drifting the other way.
  const cols = Array.from({ length: 6 }, (_, c) => posters.filter((_, i) => i % 6 === c));
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-0 overflow-hidden">
      <div className="absolute -inset-x-24 -inset-y-24 grid rotate-[-6deg] grid-cols-3 gap-4 opacity-35 sm:grid-cols-4 lg:grid-cols-6">
        {cols.map((col, c) => (
          <div key={c} className={cx('poster-drift flex flex-col gap-4', c % 2 === 1 && 'poster-drift-up', c >= 3 && 'max-sm:hidden', c >= 4 && 'max-lg:hidden')}>
            {[...col, ...col].map((p, i) => (
              <img key={i} src={tmdbImage(p, 'w185')!} alt="" loading="lazy" onError={(e) => (e.currentTarget.style.visibility = 'hidden')} className="aspect-[2/3] w-full rounded-xl bg-panel object-cover" />
            ))}
          </div>
        ))}
      </div>
      <div className="absolute inset-0 bg-[radial-gradient(60%_60%_at_50%_45%,color-mix(in_oklab,var(--color-ink)_92%,transparent),color-mix(in_oklab,var(--color-ink)_55%,transparent))]" />
    </div>
  );
}

export function AuthLayout({ children, title, subtitle }: { children: React.ReactNode; title: string; subtitle: string }) {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-ink px-5 py-12">
      <PosterWall />
      {/* Warm marquee glow behind the card */}
      <div aria-hidden="true" className="pointer-events-none absolute -top-40 left-1/2 h-[520px] w-[820px] -translate-x-1/2 rounded-full bg-amber/10 blur-[120px]" />
      <div className="relative flex w-full max-w-[420px] flex-col gap-8">
        <div className="flex flex-col items-center gap-3 text-center">
          <span className="flex items-center gap-2.5">
            <span className="size-3 rounded-full bg-amber" aria-hidden="true" />
            <span className="font-display text-5xl leading-none">Marquee</span>
          </span>
          <h1 className="m-0 text-xl font-semibold">{title}</h1>
          <p className="m-0 text-sm text-muted">{subtitle}</p>
        </div>
        <div className="flex flex-col gap-5 rounded-2xl border border-line bg-panel p-7">{children}</div>
      </div>
    </div>
  );
}

export function LoginPage() {
  const { data: status } = useAuthStatus();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [error, setError] = useState<string | null>(ERRORS[params.get('error') ?? ''] ?? null);
  const [busy, setBusy] = useState<'password' | 'plex' | 'jellyfin' | null>(null);

  if (status?.setupRequired) return <Navigate to="/setup" replace />;
  if (status?.user) return <Navigate to="/" replace />;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy('password');
    setError(null);
    try {
      await api<{ user: SessionUser }>('/auth/login', { body: { username: form.get('username'), password: form.get('password') } });
      await refreshAuth();
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiFailure ? err.message : "Couldn't reach Marquee.");
    } finally {
      setBusy(null);
    }
  }

  async function onJellyfin(form: HTMLFormElement | null) {
    if (!form || !form.reportValidity()) return;
    const d = new FormData(form);
    setBusy('jellyfin');
    setError(null);
    try {
      await api<{ user: SessionUser }>('/auth/jellyfin', { body: { username: d.get('username'), password: d.get('password') } });
      await refreshAuth();
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiFailure ? err.message : "Couldn't reach Marquee.");
    } finally {
      setBusy(null);
    }
  }

  async function onPlex() {
    setBusy('plex');
    setError(null);
    try {
      const result = await plexSignIn();
      if (result.status === 'ok') {
        await refreshAuth();
        navigate('/', { replace: true });
      } else if (result.status === 'denied') setError(result.message);
      else if (result.status === 'expired') setError('Plex sign-in timed out. Please try again.');
    } catch (err) {
      setError(err instanceof ApiFailure ? err.message : "Couldn't reach Plex.");
    } finally {
      setBusy(null);
    }
  }

  const oidc = status?.providers.oidc;
  const plex = status?.providers.plex;

  return (
    <AuthLayout title="Welcome back" subtitle="Sign in to see what's playing.">
      {error && <Notice tone="error">{error}</Notice>}
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <Field label="Username" name="username" autoComplete="username" autoCapitalize="none" required />
        <Field label="Password" name="password" type="password" autoComplete="current-password" required />
        <Button type="submit" disabled={busy !== null} className="mt-1">
          {busy === 'password' ? 'Signing in…' : 'Sign in'}
        </Button>
        {status?.providers.jellyfin.enabled && (
          <Button variant="ghost" type="button" disabled={busy !== null} onClick={(e) => onJellyfin(e.currentTarget.form)}>
            {busy === 'jellyfin' ? 'Checking with Jellyfin…' : 'Sign in with my Jellyfin password'}
          </Button>
        )}
      </form>

      {(oidc?.enabled || plex?.enabled) && (
        <>
          <div className="flex items-center gap-3 text-xs text-dim" aria-hidden="true">
            <span className="h-px flex-1 bg-line" />
            or
            <span className="h-px flex-1 bg-line" />
          </div>
          <div className="flex flex-col gap-3">
            {oidc?.enabled && (
              <a
                href="/api/auth/oidc/start"
                className="inline-flex h-11 items-center justify-center rounded-xl border border-line-strong text-body font-medium text-text no-underline hover:bg-raised hover:text-text"
              >
                Continue with {oidc.name}
              </a>
            )}
            {plex?.enabled && (
              <Button variant="ghost" type="button" onClick={onPlex} disabled={busy !== null}>
                {busy === 'plex' ? 'Waiting for Plex…' : 'Continue with Plex'}
              </Button>
            )}
          </div>
        </>
      )}
    </AuthLayout>
  );
}
