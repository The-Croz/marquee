import { useRef, useState } from 'react';
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

function Ranked({ title, cards, trailers }: { title: string; cards: DiscoverCard[]; trailers: boolean }) {
  const scroller = useRef<HTMLDivElement>(null);
  if (!cards.length) return null;
  return (
    <section aria-label={title} className="flex flex-col gap-3">
      <h3 className="m-0 text-heading font-semibold">{title}</h3>
      <div ref={scroller} className="-mx-5 flex snap-x gap-[18px] overflow-x-auto px-5 pb-2 sm:-mx-10 sm:px-10">
        {cards.map((c, i) => (
          <div key={`${c.kind}${c.tmdbId}`} className="relative flex-none">
            <TitleCard card={c} trailers={trailers} />
            <span aria-hidden="true" className="pointer-events-none absolute bottom-14 left-1 font-display text-display-lg leading-none text-white [text-shadow:0_2px_14px_rgba(0,0,0,.9)]">
              {i + 1}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Small chips for each streaming service; pick one to see its top 10 movies and top 10 shows. */
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
        Top 10 on your services
      </h2>
      <div role="group" aria-label="Streaming service" className="-mx-5 flex gap-1 overflow-x-auto px-5 sm:-mx-10 sm:px-10">
        {services.map((s) => (
          <button key={s.key} type="button" aria-pressed={svc.key === s.key} onClick={() => choose(s.key)} className="flex h-11 flex-none items-center">
            <span className={cx('rounded-full border px-3 py-1 text-label font-medium whitespace-nowrap', svc.key === s.key ? 'border-amber bg-amber text-amber-ink' : 'border-line bg-panel text-soft hover:text-text')}>{s.name}</span>
          </button>
        ))}
      </div>
      {isLoading && <div className="h-[260px] animate-pulse rounded-xl bg-panel" />}
      {data && type !== 'series' && <Ranked title={`Top 10 movies on ${svc.name}`} cards={data.movies} trailers={trailers} />}
      {data && type !== 'movie' && <Ranked title={`Top 10 shows on ${svc.name}`} cards={data.shows} trailers={trailers} />}
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

export function DiscoverPageView() {
  const [params, setParams] = useSearchParams();
  const type = (params.get('type') ?? 'all') as 'all' | 'movie' | 'series';
  const genre = params.get('genre') ?? '';
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v && v !== 'all') next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };
  const { data, isLoading, error } = useQuery({
    queryKey: ['discover', 'page', type, genre],
    queryFn: () => api<DiscoverPage>(`/discover?${new URLSearchParams({ type, ...(genre ? { genre } : {}) })}`),
    staleTime: 5 * 60_000,
  });
  const { data: prefs } = useQuery({ queryKey: ['discover', 'prefs'], queryFn: () => api<DiscoverPrefs>('/discover/prefs') });
  const trailers = prefs?.trailers ?? true;

  return (
    <>
      <PageHeader title="Discover" />

      <div className="flex flex-col gap-3">
        <div role="group" aria-label="Show" className="flex flex-wrap gap-2">
          {TYPES.map(([v, label]) => (
            <Chip key={v} active={type === v} onClick={() => set('type', v)}>
              {label}
            </Chip>
          ))}
          <label htmlFor="genre" className="sr-only">
            Genre
          </label>
          <select id="genre" value={genre} onChange={(e) => set('genre', e.target.value)} className="h-11 rounded-full border border-line bg-panel px-4 text-sm text-text">
            <option value="">Any genre</option>
            {(data?.genres ?? []).map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error && <Notice tone="error">{error instanceof ApiFailure ? error.message : 'Discover couldn’t load.'}{error instanceof ApiFailure && error.code === 'tmdb_missing' && <> <Link to="/settings/services">Settings → Services</Link></>}</Notice>}
      {isLoading && <Loading />}
      {data && (
        <>
          {data.hero.length > 0 && <Hero items={data.hero} />}
          {data.rows.length === 0 && <Notice>Nothing to show for this mix yet. Try another genre.</Notice>}
          {data.rows.slice(0, 1).map((r) => (
            <Row key={r.id} row={r} trailers={trailers} />
          ))}
          {!genre && data.services.length > 0 && <TopTen services={data.services} type={type} trailers={trailers} />}
          {data.rows.slice(1).map((r) => (
            <Row key={r.id} row={r} trailers={trailers} />
          ))}
          <p className="m-0 text-xs text-dim">Movie and show information from TMDB. Where to watch comes from JustWatch through TMDB.</p>
        </>
      )}
    </>
  );
}
