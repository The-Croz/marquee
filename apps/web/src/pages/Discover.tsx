import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import type { DiscoverCard, DiscoverPage, DiscoverPrefs, ServiceChip, ServiceTop } from '@marquee/shared';
import { api, ApiFailure } from '../api';
import { Hero, Row, TitleCard } from '../components/Discover';
import { Notice, cx } from '../components/ui';
import { PageHeader } from '../components/Page';

const TYPES = [
  ['all', 'All'],
  ['movie', 'Movies'],
  ['series', 'Shows'],
] as const;

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cx('h-11 flex-none rounded-full border px-4 text-sm font-medium whitespace-nowrap', active ? 'border-amber bg-amber text-amber-ink' : 'border-line bg-panel text-soft hover:text-text')}
    >
      {children}
    </button>
  );
}

function Ranked({ title, cards, trailers, numbered }: { title: string; cards: DiscoverCard[]; trailers: boolean; numbered: boolean }) {
  const scroller = useRef<HTMLDivElement>(null);
  if (!cards.length) return null;
  return (
    <section aria-label={title} className="flex flex-col gap-3">
      <h3 className="m-0 text-heading font-semibold">{title}</h3>
      <div ref={scroller} className="-mx-4 flex snap-x scroll-px-4 sm:scroll-px-10 gap-[18px] overflow-x-auto px-4 pb-2 sm:-mx-10 sm:px-10">
        {cards.map((c, i) => (
          <div key={`${c.kind}${c.tmdbId}`} className="relative flex-none">
            <TitleCard card={c} trailers={trailers} />
            {numbered && (
              <span aria-hidden="true" className="pointer-events-none absolute bottom-14 left-1 font-display text-display-lg leading-none text-white [text-shadow:0_2px_14px_rgba(0,0,0,.9)]">
                {i + 1}
              </span>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * Small chips for each streaming service; pick one to see its Top 10 movies
 * and shows. Numbered only when they're the service's own Top 10; otherwise
 * it's TMDB's "popular on it", and admins are told how to get the real one.
 */
function TopTen({ services, type, trailers }: { services: ServiceChip[]; type: 'all' | 'movie' | 'series'; trailers: boolean }) {
  const saved = (() => {
    try {
      return localStorage.getItem('marquee.topTenService');
    } catch {
      return null;
    }
  })();
  const [pick, setPick] = useState(saved);
  const svc = services.find((s) => s.key === pick) ?? services[0]!;
  const choose = (key: string) => {
    setPick(key);
    try {
      localStorage.setItem('marquee.topTenService', key);
    } catch {
      /* private window: just don't remember it */
    }
  };
  const { data, isLoading } = useQuery({ queryKey: ['discover', 'top', svc.key], queryFn: () => api<ServiceTop>(`/discover/top?service=${svc.key}`), staleTime: 10 * 60_000 });
  return (
    <section aria-labelledby="top10" className="flex flex-col gap-3">
      <h2 id="top10" className="m-0 text-xl font-semibold">
        {data && !data.ranked ? 'Popular on your services' : 'Top 10 on your services'}
      </h2>
      <div role="group" aria-label="Streaming service" className="-mx-4 flex gap-1 overflow-x-auto px-4 sm:-mx-10 sm:px-10">
        {services.map((s) => (
          <button key={s.key} type="button" aria-pressed={svc.key === s.key} onClick={() => choose(s.key)} className="flex h-11 flex-none items-center">
            <span className={cx('rounded-full border px-3 py-1 text-label font-medium whitespace-nowrap', svc.key === s.key ? 'border-amber bg-amber text-amber-ink' : 'border-line bg-panel text-soft hover:text-text')}>{s.name}</span>
          </button>
        ))}
      </div>
      {isLoading && <div className="h-[260px] animate-pulse rounded-xl bg-panel" />}
      {data?.note && (
        <p className="m-0 max-w-[720px] text-sm text-muted">
          {data.note}
          {/Settings → Services/.test(data.note) && (
            <>
              {' '}
              <Link to="/settings/services">Open Settings → Services</Link>
            </>
          )}
        </p>
      )}
      {data && type !== 'series' && <Ranked title={`${data.ranked ? 'Top 10' : 'Popular'} movies on ${svc.name}`} cards={data.movies} trailers={trailers} numbered={data.ranked} />}
      {data && type !== 'movie' && <Ranked title={`${data.ranked ? 'Top 10' : 'Popular'} shows on ${svc.name}`} cards={data.shows} trailers={trailers} numbered={data.ranked} />}
      {data && data.movies.length === 0 && data.shows.length === 0 && <p className="m-0 text-sm text-muted">Nothing to show for {svc.name} right now. Try another service.</p>}
    </section>
  );
}

function Loading() {
  return (
    <div aria-busy="true" className="flex flex-col gap-8">
      <div className="h-[420px] animate-pulse rounded-2xl bg-panel" />
      {[0, 1].map((n) => (
        <div key={n} className="flex flex-col gap-3">
          <div className="h-6 w-48 animate-pulse rounded bg-panel" />
          <div className="flex gap-[18px] overflow-hidden">
            {Array.from({ length: 8 }, (_, k) => (
              <div key={k} className="aspect-[2/3] w-[160px] flex-none animate-pulse rounded-xl bg-panel" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Everything / Movies / Shows, for search results and a genre. */
function KindSwitch({ value, onChange }: { value: 'all' | 'movie' | 'series'; onChange: (v: 'all' | 'movie' | 'series') => void }) {
  return (
    <div role="group" aria-label="Show" className="flex gap-2">
      {TYPES.map(([v, label]) => (
        <Chip key={v} active={value === v} onClick={() => onChange(v)}>
          {label}
        </Chip>
      ))}
    </div>
  );
}

/** Search results as you type: posters you can open and ask for. */
function Results({ q, type, onType, trailers }: { q: string; type: 'all' | 'movie' | 'series'; onType: (v: 'all' | 'movie' | 'series') => void; trailers: boolean }) {
  const { data, isFetching, error } = useQuery({
    queryKey: ['discover', 'search', q],
    queryFn: () => api<{ results: DiscoverCard[] }>(`/discover/search?${new URLSearchParams({ q, type: 'all' })}`),
    staleTime: 5 * 60_000,
    placeholderData: (prev) => prev,
  });
  const all = data?.results ?? [];
  const shown = all.filter((c) => type === 'all' || c.kind === type);
  const movies = all.filter((c) => c.kind === 'movie').length;
  return (
    <section aria-labelledby="results-h" aria-busy={isFetching} className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="results-h" className="m-0 text-xl font-semibold">
          {isFetching && !data ? 'Searching…' : `${shown.length} ${shown.length === 1 ? 'result' : 'results'} for “${q}”`}
        </h2>
        {movies > 0 && movies < all.length && <KindSwitch value={type} onChange={onType} />}
      </div>
      {error && <Notice tone="error">{error instanceof ApiFailure ? error.message : 'Search didn’t work. Try again.'}</Notice>}
      {data && shown.length === 0 && <p className="m-0 text-muted">Nothing found for that. Try fewer words, or check the spelling.</p>}
      <div className={cx('grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-x-[18px] gap-y-6 transition-opacity', isFetching && 'opacity-60')}>
        {shown.map((c) => (
          <TitleCard key={`${c.kind}${c.tmdbId}`} card={c} trailers={trailers} className="w-auto" />
        ))}
      </div>
    </section>
  );
}

/** Searches as you type (after a short pause), and Escape clears it. */
function DiscoverSearch({ q, onSearch }: { q: string; onSearch: (q: string) => void }) {
  const [text, setText] = useState(q);
  useEffect(() => setText(q), [q]);
  useEffect(() => {
    const t = text.trim();
    if (t === q) return;
    const timer = setTimeout(() => onSearch(t), t ? 350 : 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);
  return (
    <form
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        onSearch(text.trim());
      }}
      className="flex w-full min-w-0 gap-2 sm:w-[420px]"
    >
      <label htmlFor="discover-q" className="sr-only">
        Search movies and shows
      </label>
      <input
        id="discover-q"
        type="search"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && setText('')}
        placeholder="Search movies and shows"
        className="h-12 min-w-0 flex-1 rounded-xl border border-line bg-panel px-[18px] text-body text-text placeholder:text-dim focus:border-amber focus:outline-none"
      />
    </form>
  );
}

/** A hue for each genre's tile, so the grid reads at a glance. */
const GENRE_HUE: Record<string, number> = {
  Action: 18, 'Action & Adventure': 18, Adventure: 38, Animation: 190, Comedy: 48, Crime: 0, Documentary: 150, Drama: 260, Family: 120, Fantasy: 285,
  History: 30, Horror: 350, Kids: 160, Music: 320, Mystery: 230, Reality: 60, Romance: 335, 'Science Fiction': 205, 'Sci-Fi & Fantasy': 205, Soap: 300,
  Thriller: 215, War: 80, 'War & Politics': 80, Western: 25,
};

function GenreTiles({ genres, onPick }: { genres: string[]; onPick: (g: string) => void }) {
  return (
    <section aria-labelledby="genres-h" className="flex flex-col gap-3">
      <h2 id="genres-h" className="m-0 text-xl font-semibold">
        Browse by genre
      </h2>
      <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3 p-0">
        {genres.map((g) => (
          <li key={g}>
            <button
              type="button"
              onClick={() => onPick(g)}
              style={{ '--h': GENRE_HUE[g] ?? 40 } as React.CSSProperties}
              className="flex h-20 w-full items-end rounded-xl border border-line bg-[linear-gradient(135deg,hsl(var(--h)_45%_22%),hsl(var(--h)_30%_11%))] px-4 pb-3 text-left font-display text-xl leading-none text-cream hover:border-line-strong hover:brightness-125 focus-visible:brightness-125"
            >
              {g}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function DiscoverPageView() {
  const [params, setParams] = useSearchParams();
  const type = (params.get('type') ?? 'all') as 'all' | 'movie' | 'series';
  const genre = params.get('genre') ?? '';
  const q = params.get('q') ?? '';
  const set = (changes: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) {
      if (v && v !== 'all') next.set(k, v);
      else next.delete(k);
    }
    setParams(next, { replace: true });
  };
  // The front page is always everything; a genre can narrow to movies or shows.
  const pageType = genre ? type : 'all';
  const { data, isLoading, error } = useQuery({
    queryKey: ['discover', 'page', pageType, genre],
    queryFn: () => api<DiscoverPage>(`/discover?${new URLSearchParams({ type: pageType, ...(genre ? { genre } : {}) })}`),
    staleTime: 5 * 60_000,
  });
  const { data: prefs } = useQuery({ queryKey: ['discover', 'prefs'], queryFn: () => api<DiscoverPrefs>('/discover/prefs') });
  const trailers = prefs?.trailers ?? true;
  const genres = useQuery({ queryKey: ['discover', 'page', 'all', ''], queryFn: () => api<DiscoverPage>('/discover?type=all'), staleTime: 5 * 60_000, enabled: !!genre }).data?.genres ?? data?.genres ?? [];

  return (
    <>
      <PageHeader title={genre && !q ? genre : 'Discover'} actions={<DiscoverSearch q={q} onSearch={(v) => set({ q: v, ...(v ? {} : { type: genre ? type : '' }) })} />} />

      {q && <Results q={q} type={type} onType={(v) => set({ type: v })} trailers={trailers} />}

      {!q && genre && (
        <div className="-mt-2 flex flex-wrap items-center justify-between gap-3">
          <button type="button" onClick={() => set({ genre: '', type: '' })} className="flex min-h-11 items-center text-sm text-muted hover:text-text">
            ← All of Discover
          </button>
          <KindSwitch value={type} onChange={(v) => set({ type: v })} />
        </div>
      )}
      {!q && error && <Notice tone="error">{error instanceof ApiFailure ? error.message : 'Discover couldn’t load.'}{error instanceof ApiFailure && error.code === 'tmdb_missing' && <> <Link to="/settings/services">Settings → Services</Link></>}</Notice>}
      {!q && isLoading && <Loading />}
      {!q && data && (
        <>
          {data.hero.length > 0 && <Hero items={data.hero} />}
          {data.rows.length === 0 && <Notice>Nothing to show here yet. Try another genre.</Notice>}
          {/* Trending, then the services' Top 10s, then Latest releases, then the rest ("because you…" rows come last from the server). */}
          {data.rows.filter((r) => r.id !== 'latest').slice(0, 1).map((r) => (
            <Row key={r.id} row={r} trailers={trailers} />
          ))}
          {!genre && data.services.length > 0 && <TopTen services={data.services} type="all" trailers={trailers} />}
          {data.rows.filter((r) => r.id === 'latest').map((r) => (
            <Row key={r.id} row={r} trailers={trailers} />
          ))}
          {data.rows.filter((r) => r.id !== 'latest').slice(1, genre ? undefined : 4).map((r) => (
            <Row key={r.id} row={r} trailers={trailers} />
          ))}
          {!genre && genres.length > 0 && <GenreTiles genres={genres} onPick={(g) => { set({ genre: g, type: '' }); window.scrollTo({ top: 0 }); }} />}
          {!genre && data.rows.filter((r) => r.id !== 'latest').slice(4).map((r) => (
            <Row key={r.id} row={r} trailers={trailers} />
          ))}
          <p className="m-0 text-xs text-dim">Movie and show information from TMDB. Where to watch comes from JustWatch through TMDB.</p>
        </>
      )}
    </>
  );
}
