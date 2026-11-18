import { Link, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import type { DiscoverPage, DiscoverPrefs } from '@marquee/shared';
import { api, ApiFailure } from '../api';
import { Hero, Row } from '../components/Discover';
import { Notice, cx } from '../components/ui';

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

function Loading() {
  return (
    <div aria-busy="true" className="flex flex-col gap-8">
      <div className="h-[420px] animate-pulse rounded-[22px] bg-panel" />
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
  const service = params.get('service') ?? 'all';
  const genre = params.get('genre') ?? '';
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v && v !== 'all') next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };
  const { data, isLoading, error } = useQuery({
    queryKey: ['discover', 'page', type, service, genre],
    queryFn: () => api<DiscoverPage>(`/discover?${new URLSearchParams({ type, service, ...(genre ? { genre } : {}) })}`),
    staleTime: 5 * 60_000,
  });
  const { data: prefs } = useQuery({ queryKey: ['discover', 'prefs'], queryFn: () => api<DiscoverPrefs>('/discover/prefs') });
  const trailers = prefs?.trailers ?? true;

  return (
    <>
      <div className="flex flex-col gap-1">
        <h1 className="m-0 font-display text-[56px] leading-none font-normal">Discover</h1>
        <p className="m-0 text-sm text-muted">What’s new and popular, what’s on your services, and picks from what you watch and ask for.</p>
      </div>

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
        <div role="group" aria-label="Streaming service" className="-mx-5 flex gap-2 overflow-x-auto px-5 pb-1 sm:-mx-10 sm:px-10">
          <Chip active={service === 'all'} onClick={() => set('service', 'all')}>
            All services
          </Chip>
          {(data?.services ?? []).map((s) => (
            <Chip key={s.key} active={service === s.key} onClick={() => set('service', s.key)}>
              {s.name}
            </Chip>
          ))}
        </div>
      </div>

      {error && <Notice tone="error">{error instanceof ApiFailure ? error.message : 'Discover couldn’t load.'}{error instanceof ApiFailure && error.code === 'tmdb_missing' && <> <Link to="/settings/services">Settings → Services</Link></>}</Notice>}
      {isLoading && <Loading />}
      {data && (
        <>
          {data.hero.length > 0 && <Hero items={data.hero} />}
          {data.rows.length === 0 && <Notice>Nothing to show for this mix yet. Try another service or genre.</Notice>}
          {data.rows.map((r) => (
            <Row key={r.id} row={r} trailers={trailers} />
          ))}
          <p className="m-0 text-xs text-dim">Movie and show information from TMDB. Where to watch comes from JustWatch through TMDB.</p>
        </>
      )}
    </>
  );
}
