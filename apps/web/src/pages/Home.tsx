import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import type { DiscoverPage, HomeAttention, HomeData, HomeHero, SetupStep } from '@marquee/shared';
import { ApiFailure, api, queryClient, useAuthStatus } from '../api';
import { Bulbs } from '../components/Bulbs';
import { Notice, Progress, cx } from '../components/ui';
import { Poster, tmdbImage } from '../components/Poster';
import { SearchBox } from './Search';
import { STATE as REQUEST_STATE } from './Requests';

/** Home: what's happening, what needs you, what's new and what's next. */
export function HomePage() {
  const { data, error, isLoading } = useQuery({ queryKey: ['home'], queryFn: () => api<HomeData>('/home'), refetchInterval: 30_000 });
  const { data: auth } = useAuthStatus();
  const role = auth?.user?.role ?? 'member';

  if (isLoading) return <p className="text-muted">Loading…</p>;
  if (error || !data) return <Notice tone="error">Couldn’t load Home. It tries again by itself every 30 seconds.</Notice>;

  const problems = data.needsYou.filter((n) => n.tone === 'problem').length;
  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        {role !== 'kid' && <SearchBox />}
        {role === 'admin' && <StatusPill needs={data.needsYou.length} problems={problems} arriving={data.onItsWay.length} />}
      </div>

      {data.setup && <GetSetUp steps={data.setup} />}

      {data.hero ? <Hero hero={data.hero} /> : role === 'kid' && <h1 className="m-0 font-display text-[44px] leading-none font-normal">Hi {auth?.user?.displayName}</h1>}

      {role === 'admin' && (data.needsYou.length > 0 || data.onItsWay.length > 0) && (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          <NeedsYou items={data.needsYou} />
          {data.onItsWay.length > 0 && <OnItsWay items={data.onItsWay} />}
        </div>
      )}

      {data.myRequests.length > 0 && <MyRequests items={data.myRequests} />}

      {data.recent.length > 0 && <Shelf id="recent" title={role === 'kid' ? 'New for you' : 'Just arrived'} items={data.recent} big={role === 'kid'} more={{ to: '/library', label: 'Library' }} />}

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

      <Week items={data.upcoming} />

      {data.recent.length === 0 && !data.hero && !data.setup && data.needsYou.length === 0 && role !== 'kid' && (
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

      {data.stats.length > 0 && (
        <footer className="flex flex-wrap gap-x-6 gap-y-2 border-t border-line pt-4 text-sm text-dim">
          {data.stats.map((s) => {
            const body = (
              <>
                <b className="font-semibold text-soft tabular-nums">{s.value}</b> {s.label}
              </>
            );
            return s.to ? (
              <Link key={s.label} to={s.to} className="text-dim no-underline hover:text-text">
                {body}
              </Link>
            ) : (
              <span key={s.label}>{body}</span>
            );
          })}
        </footer>
      )}
    </>
  );
}

function StatusPill({ needs, problems, arriving }: { needs: number; problems: number; arriving: number }) {
  const parts = [needs ? `${needs} ${needs === 1 ? 'needs' : 'need'} you` : 'All good', arriving ? `${arriving} on the way` : null].filter(Boolean);
  return (
    <span role="status" className="inline-flex h-12 items-center gap-2.5 rounded-xl border border-line bg-panel px-4 text-sm whitespace-nowrap text-soft">
      <span aria-hidden="true" className={cx('size-2 rounded-full', problems ? 'bg-warn' : needs ? 'bg-amber' : 'bg-teal')} />
      {parts.join(' · ')}
    </span>
  );
}

function Hero({ hero }: { hero: HomeHero }) {
  const bg = tmdbImage(hero.backdropPath, 'w1280');
  const live = hero.kind === 'watching';
  return (
    <section
      aria-label={hero.eyebrow}
      className="relative isolate flex min-h-[300px] overflow-hidden rounded-2xl bg-raised sm:min-h-[360px]"
      // The poster's own colour tints the glow; amber when Marquee hasn't picked one yet.
      style={{ '--tint': hero.color ?? 'var(--color-amber)' } as React.CSSProperties}
    >
      {bg ? (
        <img src={bg} alt="" className="absolute inset-0 -z-10 size-full object-cover" />
      ) : (
        <div aria-hidden="true" className="absolute inset-0 -z-10 bg-[radial-gradient(90%_120%_at_85%_20%,color-mix(in_oklab,var(--tint)_38%,transparent)_0%,color-mix(in_oklab,var(--tint)_14%,var(--color-ink))_45%,var(--color-ink)_100%)]" />
      )}
      <div aria-hidden="true" className="absolute inset-0 -z-10 bg-gradient-to-r from-ink via-ink/75 to-ink/5" />
      {bg && <div aria-hidden="true" className="absolute inset-0 -z-10 bg-[radial-gradient(70%_90%_at_0%_100%,color-mix(in_oklab,var(--tint)_30%,transparent),transparent_70%)]" />}
      <div aria-hidden="true" className="absolute inset-0 -z-10 bg-gradient-to-t from-ink/80 via-transparent to-transparent" />
      <div className="flex w-full items-end gap-6 px-6 py-8 sm:px-10 sm:py-10">
        {hero.posterPath && !bg && <Poster title={hero.title} path={hero.posterPath} color={hero.color} className="hidden w-[150px] flex-none shadow-2xl sm:block" />}
        <div className="flex max-w-[600px] flex-col gap-3.5">
          <div className="flex items-center gap-2.5 text-xs font-semibold tracking-[0.14em] text-amber uppercase">
            <Bulbs lit={live ? 4 : 3} chase={live} />
            {hero.eyebrow}
          </div>
          <h1 className="m-0 font-display text-display leading-[0.95] font-normal text-balance sm:text-display-lg">{hero.title}</h1>
          {hero.note && <p className="m-0 text-soft">{hero.note}</p>}
          {hero.chips.length > 0 && (
            <div className="flex flex-wrap gap-2 text-label">
              {hero.chips.map((c, i) => (
                <span key={c} className={cx('rounded-full px-2.5 py-1', i === 0 ? 'bg-amber/15 font-semibold text-amber-hi' : 'bg-white/10 text-soft')}>
                  {c}
                </span>
              ))}
            </div>
          )}
          {hero.progress !== null && <Progress value={hero.progress} color="bg-amber" className="max-w-[420px]" />}
          {hero.href && (
            <div className="flex flex-wrap gap-3 pt-1">
              <Link to={hero.href} className="inline-flex h-11 items-center rounded-xl bg-amber px-5 text-body font-semibold text-amber-ink no-underline hover:bg-amber-hi hover:text-amber-ink">
                Open title
              </Link>
              {live && (
                <Link to="/activity" className="inline-flex h-11 items-center rounded-xl border border-white/25 px-5 text-body font-medium text-text no-underline hover:bg-white/10 hover:text-text">
                  Who’s watching
                </Link>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
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

function MyRequests({ items }: { items: HomeData['myRequests'] }) {
  return (
    <section aria-labelledby="mine-h" className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="mine-h" className="m-0 text-lg font-semibold">
          Your requests
        </h2>
        <Link to="/requests" className="flex min-h-11 items-center text-sm text-muted no-underline hover:text-text">
          All →
        </Link>
      </div>
      <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3 p-0">
        {items.map((r) => {
          const st = REQUEST_STATE[r.state];
          const body = (
            <>
              <Poster title={r.title} path={r.posterPath} size="w185" className="w-11 flex-none rounded-md" />
              <div className="flex min-w-0 flex-col gap-1.5">
                <span className="truncate font-medium">{r.title}</span>
                <span className={cx('self-start rounded-full px-2 py-0.5 text-xs font-medium', st.tone)}>{st.label}</span>
              </div>
            </>
          );
          return (
            <li key={r.id}>
              {r.href ? (
                <Link to={r.href} className="flex items-center gap-3 rounded-xl border border-line bg-panel p-2.5 text-text no-underline hover:border-line-strong hover:text-text">
                  {body}
                </Link>
              ) : (
                <div className="flex items-center gap-3 rounded-xl border border-line bg-panel p-2.5">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

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
  return (
    <section aria-labelledby={`${id}-h`} className="flex flex-col gap-3">
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
      <div className={cx('grid gap-4', big ? 'grid-cols-[repeat(auto-fill,minmax(170px,1fr))]' : 'grid-cols-[repeat(auto-fill,minmax(130px,1fr))]')}>
        {items.map((p) => (
          <Link key={p.href} to={p.href} className="group flex flex-col gap-2 text-text no-underline hover:text-text">
            <div className="relative transition-transform duration-200 group-hover:-translate-y-1 motion-reduce:transition-none motion-reduce:group-hover:translate-y-0">
              <Poster title={p.title} path={p.posterPath} color={p.posterColor} />
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
                className={cx(
                  'inline-flex min-h-11 flex-none items-center rounded-xl px-4 text-sm font-semibold no-underline',
                  s === next ? 'bg-amber text-amber-ink hover:bg-amber-hi hover:text-amber-ink' : 'border border-line text-soft hover:text-text',
                )}
              >
                {s === next ? 'Start' : 'Open'}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

function Week({ items }: { items: HomeData['upcoming'] }) {
  const days: { day: string; items: HomeData['upcoming'] }[] = [];
  for (const u of items) {
    const last = days.at(-1);
    if (last && last.day === u.day) last.items.push(u);
    else days.push({ day: u.day, items: [u] });
  }
  return (
    <section aria-labelledby="week-h" className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="week-h" className="m-0 text-lg font-semibold">
          This week
        </h2>
        <Link to="/calendar" className="flex min-h-11 items-center text-sm text-muted no-underline hover:text-text">
          Full calendar →
        </Link>
      </div>
      {days.length === 0 && <p className="m-0 text-sm text-muted">Nothing new airs in the next seven days.</p>}
      <ol className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3 p-0">
        {days.map((d, i) => (
          <li key={d.day} className={cx('flex flex-col gap-2.5 rounded-xl border bg-panel p-3.5', i === 0 ? 'border-amber/45' : 'border-line')}>
            <span className={cx('text-caption font-semibold tracking-[0.12em] uppercase', i === 0 ? 'text-amber' : 'text-dim')}>{d.day}</span>
            {d.items.map((u) => (
              <div key={u.title} className="flex flex-col gap-0.5 text-sm">
                {u.href ? (
                  <Link to={u.href} className="font-medium text-text no-underline hover:underline">
                    {u.title}
                  </Link>
                ) : (
                  <span className="font-medium">{u.title}</span>
                )}
                <span className="text-xs text-dim">{u.note}</span>
              </div>
            ))}
          </li>
        ))}
      </ol>
    </section>
  );
}
