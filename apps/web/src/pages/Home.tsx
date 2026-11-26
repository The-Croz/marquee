import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import type { DiscoverPage, HomeAttention, HomeData, HomeHero, SetupStep } from '@marquee/shared';
import { ApiFailure, api, queryClient, useAuthStatus } from '../api';
import { Bulbs } from '../components/Bulbs';
import { Avatar, Notice, Progress, cx } from '../components/ui';
import { Sheet } from '../components/Overlay';
import { Poster, posterTransition, tmdbImage } from '../components/Poster';
import { STATE as REQUEST_STATE } from './Requests';

/** Home: what's happening, what needs you, what's new and what's next. */
export function HomePage() {
  const { data, error, isLoading } = useQuery({ queryKey: ['home'], queryFn: () => api<HomeData>('/home'), refetchInterval: 30_000 });
  const { data: auth } = useAuthStatus();
  const role = auth?.user?.role ?? 'member';

  if (isLoading) return <p className="text-muted">Loading…</p>;
  if (error || !data) return <Notice tone="error">Couldn’t load Home. It tries again by itself every 30 seconds.</Notice>;

  const problems = data.needsYou.filter((n) => n.tone === 'problem').length;
  const status = role === 'admin' ? <StatusPill needs={data.needsYou} arriving={data.onItsWay} problems={problems} /> : null;
  return (
    <>
      {data.setup && <GetSetUp steps={data.setup} />}

      {data.heroes.length > 0 ? (
        <Banner slides={data.heroes} corner={status} />
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3">
          {role === 'kid' ? <h1 className="m-0 font-display text-[44px] leading-none font-normal">Hi {auth?.user?.displayName}</h1> : <span />}
          {status}
        </div>
      )}

      {data.watching.length > 0 && <NowWatching sessions={data.watching} />}

      {data.recent.length > 0 && <Shelf id="recent" title={role === 'kid' ? 'New for you' : 'Just arrived'} items={data.recent} big={role === 'kid'} more={{ to: '/library', label: 'Library' }} />}

      {data.upcoming.length > 0 ? <Week items={data.upcoming} /> : (
        <p className="m-0 text-sm text-muted">
          Nothing new comes out in the next seven days. <Link to="/calendar">Open the calendar</Link>
        </p>
      )}

      {data.recentRequests.length > 0 && <RecentRequests items={data.recentRequests} everyone={role === 'admin'} />}

      {role !== 'admin' && <ForYou big={role === 'kid'} />}

      {role === 'kid' && (
        <section className="flex flex-col items-start gap-3 rounded-2xl border border-line bg-panel p-5">
          <h2 className="m-0 text-xl font-semibold">Want something new?</h2>
          <p className="m-0 text-soft">Find a movie or show and ask for it. A grown-up says yes, then it shows up here.</p>
          <Link to="/discover" className="inline-flex h-11 items-center rounded-xl bg-amber px-5 text-body font-semibold text-amber-ink no-underline hover:bg-amber-hi hover:text-amber-ink">
            Ask for something
          </Link>
        </section>
      )}

      {data.recent.length === 0 && data.heroes.length === 0 && !data.setup && data.needsYou.length === 0 && role !== 'kid' && (
        <section className="flex flex-col items-start gap-3 py-6">
          <h2 className="m-0 text-xl font-semibold">Nothing here yet</h2>
          <p className="m-0 max-w-[560px] text-soft">
            {role === 'admin' ? 'Once Marquee has scanned your library, new arrivals and what’s coming up show here.' : 'Find something to watch and ask for it. It shows up here when it’s ready.'}
          </p>
          <Link to={role === 'admin' ? '/library' : '/discover'} className="inline-flex h-11 items-center rounded-xl bg-amber px-5 text-body font-semibold text-amber-ink no-underline hover:bg-amber-hi hover:text-amber-ink">
            {role === 'admin' ? 'Go to your library' : 'Open Discover'}
          </Link>
        </section>
      )}

      {data.stats.length > 0 && <Stats stats={data.stats} />}
    </>
  );
}

/** Library numbers as a row of tiles; each opens where it's from. */
function Stats({ stats }: { stats: HomeData['stats'] }) {
  return (
    <section aria-labelledby="stats-h" className="flex flex-col gap-3">
      <h2 id="stats-h" className="m-0 text-lg font-semibold">
        Your library in numbers
      </h2>
      <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3 p-0">
        {stats.map((s) => {
          const body = (
            <>
              <span className="font-display text-[34px] leading-none text-text tabular-nums">{s.value}</span>
              <span className="text-sm text-muted">{s.label}</span>
            </>
          );
          return (
            <li key={s.label}>
              {s.to ? (
                <Link to={s.to} className="flex h-full min-h-[92px] flex-col justify-between gap-2 rounded-xl border border-line bg-panel px-4 py-3.5 no-underline hover:border-line-strong">
                  {body}
                </Link>
              ) : (
                <div className="flex h-full min-h-[92px] flex-col justify-between gap-2 rounded-xl border border-line bg-panel px-4 py-3.5">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** "2 need you · 3 on the way": opens a panel with what needs you and what's downloading. */
function StatusPill({ needs, arriving, problems }: { needs: HomeAttention[]; arriving: HomeData['onItsWay']; problems: number }) {
  const [open, setOpen] = useState(false);
  const parts = [needs.length ? `${needs.length} ${needs.length === 1 ? 'needs' : 'need'} you` : 'All good', arriving.length ? `${arriving.length} on the way` : null].filter(Boolean);
  const quiet = !needs.length && !arriving.length;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={quiet}
        className="inline-flex h-11 items-center gap-2.5 rounded-full border border-white/15 bg-ink/70 px-4 text-sm whitespace-nowrap text-soft backdrop-blur hover:text-text disabled:cursor-default"
      >
        <span aria-hidden="true" className={cx('size-2 rounded-full', problems ? 'bg-warn' : needs.length ? 'bg-amber' : arriving.length ? 'bg-blue' : 'bg-teal')} />
        {parts.join(' · ')}
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title="What’s going on" className="sm:w-[min(720px,calc(100vw-48px))]">
        <div className="flex flex-col gap-6 p-5 sm:p-6">
          {needs.length > 0 && <NeedsYou items={needs} />}
          {arriving.length > 0 && <OnItsWay items={arriving} />}
        </div>
      </Sheet>
    </>
  );
}

const SLIDE_MS = 8000;

/** The banner: what's new, aired, coming and worth a look, taking turns. It waits while you're on it. */
function Banner({ slides, corner }: { slides: HomeHero[]; corner?: React.ReactNode }) {
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  const at = Math.min(i, slides.length - 1);
  const hero = slides[at]!;
  useEffect(() => {
    if (paused || slides.length < 2 || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const t = setTimeout(() => setI((at + 1) % slides.length), SLIDE_MS);
    return () => clearTimeout(t);
  }, [at, paused, slides.length]);
  const to = hero.href ?? (hero.discover ? `/discover/${hero.discover.kind}/${hero.discover.tmdbId}` : null);
  return (
    <section
      aria-roledescription="carousel"
      aria-label="Featured"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      className="relative isolate flex min-h-[360px] overflow-hidden rounded-2xl bg-raised sm:min-h-[460px]"
      // The poster's own colour tints the glow; amber when Marquee hasn't picked one yet.
      style={{ '--tint': hero.color ?? 'var(--color-amber)' } as React.CSSProperties}
    >
      <div aria-hidden="true" className="absolute inset-0 -z-20 bg-[radial-gradient(90%_120%_at_85%_20%,color-mix(in_oklab,var(--tint)_38%,transparent)_0%,color-mix(in_oklab,var(--tint)_14%,var(--color-ink))_45%,var(--color-ink)_100%)]" />
      {slides.map((s, n) => {
        const src = tmdbImage(s.backdropPath, 'w1280');
        return src ? (
          <img
            key={`${n}${src}`}
            src={src}
            alt=""
            onError={(e) => (e.currentTarget.style.visibility = 'hidden')}
            className={cx('absolute inset-0 -z-10 size-full object-cover transition-opacity duration-700 motion-reduce:transition-none', n === at ? 'opacity-100' : 'opacity-0')}
          />
        ) : null;
      })}
      <div aria-hidden="true" className="absolute inset-0 -z-10 bg-gradient-to-r from-ink via-ink/75 to-ink/5" />
      <div aria-hidden="true" className="absolute inset-0 -z-10 bg-gradient-to-t from-ink/80 via-transparent to-transparent" />
      {corner && <div className="absolute top-4 right-4 z-10 sm:top-5 sm:right-5">{corner}</div>}
      <div className="flex w-full flex-col justify-end gap-3 px-6 pt-20 pb-5 sm:px-10 sm:pb-6">
        <div className="flex items-end gap-6" aria-live={paused ? 'polite' : 'off'}>
          {hero.posterPath && !hero.backdropPath && <Poster title={hero.title} path={hero.posterPath} color={hero.color} className="hidden w-[150px] flex-none shadow-2xl sm:block" />}
          <div className="flex min-w-0 max-w-[600px] flex-col gap-3.5">
            <div className="flex items-center gap-2.5 text-xs font-semibold tracking-[0.14em] text-amber uppercase">
              <Bulbs lit={3} />
              {hero.eyebrow}
            </div>
            <h1 className="m-0 font-display text-display leading-[0.95] font-normal text-balance sm:text-display-lg">{hero.title}</h1>
            <HeroFacts hero={hero} />
            {hero.note && <p className="m-0 text-soft">{hero.note}</p>}
            {hero.overview && <p className="m-0 line-clamp-2 max-w-[560px] text-body leading-relaxed text-soft sm:line-clamp-3">{hero.overview}</p>}
            {to && (
              <div className="flex flex-wrap gap-3 pt-1">
                <Link to={to} className="inline-flex h-11 items-center rounded-xl bg-amber px-5 text-body font-semibold text-amber-ink no-underline hover:bg-amber-hi hover:text-amber-ink">
                  {hero.href ? 'Open title' : 'More info'}
                </Link>
              </div>
            )}
          </div>
        </div>
        {slides.length > 1 && (
          <div className="-mx-3 flex flex-wrap items-center sm:justify-end" role="group" aria-label="Choose a featured title">
            {slides.map((s, n) => (
              <button key={`${n}${s.title}`} type="button" aria-label={`${s.title}${n === at ? ', showing now' : ''}`} aria-current={n === at} onClick={() => setI(n)} className="flex size-11 items-center justify-center">
                <span className={cx('block h-1.5 rounded-full transition-all', n === at ? 'w-6 bg-amber' : 'w-1.5 bg-white/40')} />
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

/** Admins: a quieter row of what's playing right now, each opening its title. */
function NowWatching({ sessions }: { sessions: HomeData['watching'] }) {
  return (
    <section aria-labelledby="watching-h" className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="watching-h" className="m-0 text-lg font-semibold">
          Watching now
        </h2>
        <Link to="/activity" className="flex min-h-11 items-center text-sm text-muted no-underline hover:text-text">
          Who’s watching →
        </Link>
      </div>
      <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3 p-0">
        {sessions.map((s) => {
          const art = tmdbImage(s.backdropPath, 'w780') ?? tmdbImage(s.posterPath, 'w342');
          return (
            <li key={`${s.server}${s.sessionId}`}>
              <Link to={s.href ?? '/activity'} className="group relative isolate flex min-h-[116px] flex-col justify-end gap-1 overflow-hidden rounded-xl border border-line bg-panel p-3 text-text no-underline hover:border-line-strong hover:text-text">
                {art && <img src={art} alt="" loading="lazy" onError={(e) => (e.currentTarget.style.visibility = 'hidden')} className="absolute inset-0 -z-10 size-full object-cover" />}
                <div aria-hidden="true" className="absolute inset-0 -z-10 bg-gradient-to-t from-ink via-ink/75 to-ink/20" />
                <span className="truncate text-body font-semibold">{s.title}</span>
                {s.subtitle && <span className="truncate text-xs text-soft">{s.subtitle}</span>}
                <span className="flex min-w-0 items-center gap-1.5 text-xs text-soft">
                  <Avatar name={s.user} src={s.userAvatar} className="size-5 text-[10px]" />
                  <span className="truncate">
                    {s.user} · {s.device}
                    {s.state === 'paused' ? ' · Paused' : ''}
                  </span>
                </span>
                <Progress value={Math.round(s.progress * 100)} color="bg-teal" className="h-1" />
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const hm = (min: number) => (min >= 60 ? `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min` : `${min} min`);

/** Year · rating · length · genres, and the review score, under the banner's title. */
function HeroFacts({ hero }: { hero: HomeHero }) {
  const facts = [hero.kindLabel, hero.year ? String(hero.year) : null, hero.runtime ? hm(hero.runtime) : null, hero.genres.length ? hero.genres.join(', ') : null].filter((x): x is string => !!x);
  if (!facts.length && !hero.rating && hero.score === null) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-soft">
      {hero.score !== null && (
        <span className="inline-flex items-center gap-1.5 rounded-md bg-ink/70 px-2 py-0.5 font-semibold text-text" title={hero.votes ? `TMDB review score, from ${hero.votes.toLocaleString()} votes` : 'TMDB review score'}>
          <span aria-hidden="true" className="text-amber">
            ★
          </span>
          {hero.score.toFixed(1)}
          <span className="font-normal text-muted">TMDB{hero.votes ? ` · ${hero.votes >= 1000 ? `${Math.round(hero.votes / 100) / 10}k` : hero.votes} votes` : ''}</span>
        </span>
      )}
      {hero.rating && <span className="rounded border border-white/35 px-1.5 py-px text-caption font-semibold tracking-wide text-text">{hero.rating}</span>}
      {facts.length > 0 && <span>{facts.join(' · ')}</span>}
    </div>
  );
}

function NeedsYou({ items }: { items: HomeAttention[] }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  async function approve(id: number) {
    setBusy(id);
    setError(null);
    try {
      await api(`/requests/${id}/approve`, { body: {} });
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['home'] }), queryClient.invalidateQueries({ queryKey: ['requests'] })]);
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : 'Couldn’t approve it. Try again, or open Requests.');
    } finally {
      setBusy(null);
    }
  }
  return (
    <section aria-labelledby="needs-h" className="flex min-w-0 flex-col gap-1">
      <h2 id="needs-h" className="m-0 flex min-h-11 items-center text-lg font-semibold">
        Needs you
      </h2>
      {error && <Notice tone="error">{error}</Notice>}
      {items.length === 0 ? (
        <p className="m-0 flex items-center gap-2.5 border-t border-line py-4 text-teal-hi">
          <span aria-hidden="true" className="size-2 rounded-full bg-teal" />
          Nothing needs you.
        </p>
      ) : (
        <ul className="m-0 list-none border-t border-line p-0">
          {items.map((n) => (
            <li key={n.key} className="flex items-center gap-3.5 border-b border-line py-3">
              {n.posterPath !== undefined && n.posterPath !== null ? (
                <Poster title={n.title} path={n.posterPath} size="w185" className="w-9 flex-none rounded-md" />
              ) : (
                <span aria-hidden="true" className="flex size-9 flex-none items-center justify-center rounded-lg bg-raised">
                  <span className={cx('size-2 rounded-full', n.tone === 'problem' ? 'bg-warn' : 'bg-amber')} />
                </span>
              )}
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-body font-medium">{n.title}</span>
                {n.detail && <span className="text-label text-dim">{n.detail}</span>}
              </div>
              {n.approveId !== undefined && (
                <button
                  type="button"
                  disabled={busy === n.approveId}
                  onClick={() => approve(n.approveId!)}
                  className="inline-flex h-11 items-center rounded-xl bg-amber px-4 text-sm font-semibold text-amber-ink hover:bg-amber-hi disabled:opacity-50"
                >
                  Approve
                </button>
              )}
              <Link to={n.to} className="inline-flex h-11 flex-none items-center rounded-xl border border-line-strong px-3.5 text-sm font-medium text-text no-underline hover:bg-raised hover:text-text">
                {n.action}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function OnItsWay({ items }: { items: HomeData['onItsWay'] }) {
  const shown = items.slice(0, 4);
  return (
    <section aria-labelledby="way-h" className="flex min-w-0 flex-col gap-1">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="way-h" className="m-0 text-lg font-semibold">
          On its way
        </h2>
        <Link to="/downloads" className="flex min-h-11 items-center text-sm text-muted no-underline hover:text-text">
          {items.length > shown.length ? `and ${items.length - shown.length} more` : 'Downloads'} →
        </Link>
      </div>
      <ul className="m-0 flex list-none flex-col gap-4 border-t border-line p-0 pt-4">
        {shown.map((d) => (
          <li key={d.id} className="flex items-center gap-3.5">
            <Poster title={d.title} path={d.posterPath} size="w185" className="w-9 flex-none rounded-md" />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <div className="flex justify-between gap-3 text-sm">
                {d.href ? (
                  <Link to={d.href} className="truncate font-medium text-text no-underline hover:underline">
                    {d.title}
                  </Link>
                ) : (
                  <span className="truncate font-medium">{d.title}</span>
                )}
                <span className="flex-none text-dim tabular-nums">{d.percent}%</span>
              </div>
              <Progress value={d.percent} className="h-1" />
              <span className="truncate text-xs text-dim">{d.label}</span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The newest requests as a row of posters, each saying where it stands:
 * ready, approved, downloading, waiting for an OK or turned down.
 */
function RecentRequests({ items, everyone }: { items: HomeData['recentRequests']; everyone: boolean }) {
  return (
    <section aria-labelledby="requests-h" className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="requests-h" className="m-0 text-lg font-semibold">
          {everyone ? 'Recent requests' : 'Your requests'}
        </h2>
        <Link to="/requests" className="flex min-h-11 items-center text-sm text-muted no-underline hover:text-text">
          All requests →
        </Link>
      </div>
      <ul className="-mx-4 m-0 flex list-none snap-x scroll-px-4 sm:scroll-px-10 gap-4 overflow-x-auto px-4 pb-2 sm:-mx-10 sm:px-10">
        {items.map((r) => {
          const st = REQUEST_STATE[r.state];
          const to = r.href ?? `/discover/${r.kind}/${r.tmdbId}`;
          return (
            <li key={r.id} className="w-[140px] flex-none snap-start">
              <Link to={to} className="group flex flex-col gap-2 text-text no-underline hover:text-text">
                <div className="relative transition-transform duration-200 group-hover:-translate-y-1 motion-reduce:transition-none motion-reduce:group-hover:translate-y-0">
                  <Poster title={r.title} path={r.posterPath} size="w185" className={cx(r.state === 'declined' && 'opacity-50')} />
                </div>
                <span className="truncate text-label font-semibold">{r.title}</span>
                <span className="-mt-1 flex min-w-0 items-center gap-1.5 text-caption">
                  <span className={cx('flex-none rounded-md px-2 py-0.5 font-medium whitespace-nowrap', st.tone)}>{st.label}</span>
                  {everyone && r.requestedBy && <span className="truncate text-dim">{r.requestedBy.name}</span>}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Titles in your library have a page whose poster this one can grow into. */
const ownTitle = (href: string) => /^\/(movies|shows)\/\d+$/.test(href);

interface ShelfItem {
  href: string;
  title: string;
  sub: string;
  posterPath: string | null;
  posterColor?: string | null;
  /** Shows a NEW badge for a day. */
  addedAt?: number;
}

function Shelf({ id, title, items, big, more }: { id: string; title: string; items: ShelfItem[]; big?: boolean; more?: { to: string; label: string } }) {
  const tint = items.find((i) => i.posterColor)?.posterColor;
  return (
    <section
      aria-labelledby={`${id}-h`}
      className="relative isolate flex flex-col gap-3"
      // The row picks up its first poster's colour as a faint wash behind it.
      style={tint ? ({ '--tint': tint } as React.CSSProperties) : undefined}
    >
      {tint && <div aria-hidden="true" className="absolute -inset-x-4 -inset-y-5 sm:-inset-x-6 -z-10 rounded-3xl bg-[radial-gradient(70%_100%_at_15%_0%,color-mix(in_oklab,var(--tint)_16%,transparent),transparent_75%)]" />}
      <div className="flex items-baseline justify-between gap-3">
        <h2 id={`${id}-h`} className="m-0 text-lg font-semibold">
          {title}
        </h2>
        {more && (
          <Link to={more.to} className="flex min-h-11 items-center text-sm text-muted no-underline hover:text-text">
            {more.label} →
          </Link>
        )}
      </div>
      <div className="-mx-4 flex snap-x scroll-px-4 sm:scroll-px-10 gap-4 overflow-x-auto px-4 pb-2 sm:-mx-10 sm:px-10">
        {items.map((p) => (
          <Link key={p.href} to={p.href} viewTransition={ownTitle(p.href)} className={cx('group flex flex-none snap-start flex-col gap-2 text-text no-underline hover:text-text', big ? 'w-[170px]' : 'w-[140px]')}>
            <div className="relative transition-transform duration-200 group-hover:-translate-y-1 motion-reduce:transition-none motion-reduce:group-hover:translate-y-0">
              <Poster title={p.title} path={p.posterPath} color={p.posterColor} transition={ownTitle(p.href) ? posterTransition(p.href) : undefined} />
              {p.addedAt !== undefined && Date.now() - p.addedAt < 86_400_000 && (
                <span className="absolute top-2 left-2 rounded bg-amber px-1.5 py-0.5 text-caption font-bold tracking-wider text-amber-ink">NEW</span>
              )}
            </div>
            <span className="truncate text-label font-semibold">{p.title}</span>
            <span className="-mt-1.5 text-xs text-dim">{p.sub}</span>
          </Link>
        ))}
      </div>
    </section>
  );
}

/**
 * Members and kids: one row picked for them from Discover ("Because you
 * watched…", or Top picks). Nothing shows until there's something to suggest.
 */
function ForYou({ big }: { big: boolean }) {
  const { data } = useQuery({ queryKey: ['discover', 'home'], queryFn: () => api<DiscoverPage>('/discover?type=all'), staleTime: 10 * 60_000, retry: false });
  const row = data?.rows.find((r) => r.id.startsWith('because-watched')) ?? data?.rows.find((r) => r.id === 'top-picks');
  if (!row || row.items.length < 2) return null;
  const items = row.items.slice(0, big ? 6 : 8).map((c) => ({ href: `/discover/${c.kind}/${c.tmdbId}`, title: c.title, sub: c.year ? String(c.year) : c.kind === 'movie' ? 'Movie' : 'Show', posterPath: c.posterPath }));
  return <Shelf id="for-you" title={row.title} items={items} big={big} more={{ to: '/discover', label: 'Discover' }} />;
}

/** Admins on a new install: what's left to do, in order, one action each. */
function GetSetUp({ steps }: { steps: SetupStep[] }) {
  const musts = steps.filter((s) => !s.optional);
  const done = musts.filter((s) => s.done).length;
  const next = steps.find((s) => !s.done);
  return (
    <section aria-labelledby="setup-h" className="flex flex-col gap-4 rounded-2xl border border-line bg-panel p-5 sm:p-6">
      <div className="flex flex-col gap-1">
        <Bulbs count={musts.length} lit={done} />
        <h2 id="setup-h" className="m-0 mt-2 text-xl font-semibold">
          Get set up
        </h2>
        <p className="m-0 text-sm text-muted">
          {done} of {musts.length} done. This goes away once the first {musts.length} are.
        </p>
      </div>
      <ol className="m-0 flex list-none flex-col p-0">
        {steps.map((s, i) => (
          <li key={s.key} className="flex items-center gap-4 border-t border-line py-3">
            <span
              aria-hidden="true"
              className={cx('flex size-8 flex-none items-center justify-center rounded-full text-sm font-semibold', s.done ? 'bg-teal/20 text-teal-hi' : s === next ? 'bg-amber text-amber-ink' : 'border border-line-strong text-dim')}
            >
              {s.done ? '✓' : i + 1}
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className={cx('text-body font-semibold', s.done && 'text-muted line-through decoration-dim')}>
                {s.title}
                {s.optional && <span className="ml-2 text-sm font-normal text-dim no-underline">optional</span>}
              </span>
              {!s.done && <span className="text-sm text-muted">{s.detail}</span>}
              <span className="sr-only">{s.done ? 'Done.' : 'Not done yet.'}</span>
            </span>
            {!s.done && (
              <Link
                to={s.to}
                aria-label={s === next ? undefined : `Open: ${s.title}`}
                className={cx(
                  'inline-flex min-h-11 flex-none items-center justify-center rounded-xl text-sm font-semibold no-underline',
                  s === next ? 'bg-amber px-4 text-amber-ink hover:bg-amber-hi hover:text-amber-ink' : 'min-w-11 border border-line text-soft hover:text-text sm:px-4',
                )}
              >
                {s === next ? (
                  'Start'
                ) : (
                  <>
                    <span className="max-sm:hidden">Open</span>
                    <span aria-hidden="true" className="text-lg sm:hidden">
                      ›
                    </span>
                  </>
                )}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

/** The next seven days as a row of pictures, each with its day. */
function Week({ items }: { items: HomeData['upcoming'] }) {
  const shared = items.length > 1 && items.every((u) => u.note && u.note === items[0]!.note) ? items[0]!.note : null;
  return (
    <section aria-labelledby="week-h" className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="week-h" className="m-0 text-lg font-semibold">
          This week
        </h2>
        <Link to="/calendar" className="flex min-h-11 items-center text-sm text-muted no-underline hover:text-text">
          Full calendar
        </Link>
      </div>
      {/* When every card says the same thing, say it once. */}
      {shared && <p className="-mt-2 m-0 text-sm text-dim">{shared}</p>}
      <ol className="-mx-4 m-0 flex list-none snap-x scroll-px-4 sm:scroll-px-10 gap-4 overflow-x-auto px-4 pb-2 sm:-mx-10 sm:px-10">
        {items.map((u, i) => {
          const img = tmdbImage(u.backdropPath, 'w780') ?? tmdbImage(u.posterPath, 'w342');
          const today = u.day === 'Today';
          const body = (
            <>
              <div className="relative aspect-video overflow-hidden rounded-xl bg-raised">
                {img && <img src={img} alt="" loading="lazy" onError={(e) => (e.currentTarget.style.visibility = 'hidden')} className="size-full object-cover transition duration-200 group-hover:scale-[1.03] motion-reduce:transition-none" />}
                <div aria-hidden="true" className="absolute inset-0 bg-gradient-to-t from-ink/90 via-ink/20 to-transparent" />
                <span className={cx('absolute top-2.5 left-2.5 rounded-md px-2 py-0.5 text-caption font-semibold', today ? 'bg-amber text-amber-ink' : 'bg-ink/80 text-soft')}>{u.day}</span>
                <span className="absolute right-3 bottom-2.5 left-3 line-clamp-2 text-body leading-tight font-semibold text-text">{u.title}</span>
              </div>
              {!shared && <span className="line-clamp-2 text-xs text-dim">{u.note}</span>}
            </>
          );
          return (
            <li key={`${u.day}${u.title}${i}`} className="flex w-[260px] flex-none snap-start flex-col">
              {u.href ? (
                <Link to={u.href} className="group flex flex-col gap-2 no-underline">
                  {body}
                </Link>
              ) : (
                <div className="flex flex-col gap-2">{body}</div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
