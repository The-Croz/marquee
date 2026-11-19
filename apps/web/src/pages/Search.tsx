import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import type { SearchResult, SessionUser } from '@marquee/shared';
import { api, ApiFailure, queryClient } from '../api';
import { Poster } from '../components/Poster';
import { Button, Notice } from '../components/ui';

/**
 * Searches TMDB for something to add. `kind` keeps the results to movies or
 * shows (from the Movies and Shows pages); without it, both.
 */
export function SearchBox({ initial = '', autoFocus = false, kind }: { initial?: string; autoFocus?: boolean; kind?: 'movie' | 'series' }) {
  const navigate = useNavigate();
  const label = kind === 'movie' ? 'Find a movie to add' : kind === 'series' ? 'Find a show to add' : 'Search movies and shows';
  return (
    <form
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        const q = String(new FormData(e.currentTarget).get('q') ?? '').trim();
        if (q) navigate(`/search?${new URLSearchParams(kind ? { q, kind } : { q })}`);
      }}
      className="flex flex-[1_1_360px]"
    >
      <label htmlFor="search-q" className="sr-only">
        {label}
      </label>
      <input
        id="search-q"
        name="q"
        type="search"
        defaultValue={initial}
        autoFocus={autoFocus}
        placeholder={kind ? `${label}…` : label}
        className="h-12 w-full rounded-xl border border-line bg-panel px-[18px] text-body text-text placeholder:text-dim focus:border-amber focus:outline-none"
      />
    </form>
  );
}

export function SearchPage({ user }: { user: SessionUser }) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const q = params.get('q') ?? '';
  const kindParam = params.get('kind');
  const kind = kindParam === 'movie' || kindParam === 'series' ? kindParam : undefined;
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<number | null>(null);
  const { data, isLoading, error: loadError } = useQuery({
    queryKey: ['search', q, kind],
    queryFn: () => api<{ results: SearchResult[] }>(`/library/search?${new URLSearchParams(kind ? { q, kind } : { q })}`),
    enabled: q.length > 0,
  });

  async function add(r: SearchResult, wanted: boolean) {
    setAdding(r.tmdbId);
    setError(null);
    try {
      const res = await api<{ id: number; kind: 'movie' | 'series' }>('/library/add', { body: { kind: r.kind, tmdbId: r.tmdbId, wanted } });
      await queryClient.invalidateQueries({ queryKey: ['library'] });
      navigate(res.kind === 'movie' ? `/movies/${res.id}` : `/shows/${res.id}`);
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : "Couldn't add it.");
      setAdding(null);
    }
  }

  return (
    <>
      <div className="flex flex-wrap gap-4">
        <SearchBox initial={q} autoFocus={!q} kind={kind} />
      </div>
      {q && <h1 className="m-0 text-2xl font-semibold">Results for “{q}”</h1>}
      {!q && <h1 className="m-0 text-2xl font-semibold">{kind === 'series' ? 'Find a show to add' : kind === 'movie' ? 'Find a movie to add' : 'Find something to add'}</h1>}
      {user.role === 'admin' && (
        <p className="m-0 max-w-[720px] text-sm text-muted">
          Search The Movie Database, press <strong className="text-soft">Add and look for it</strong> and Marquee finds a copy, downloads it and puts it in your library.{' '}
          <strong className="text-soft">Just add</strong> keeps it as Not wanted, so you can pick a copy by hand from its page.
        </p>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      {loadError && <Notice tone="error">{loadError instanceof ApiFailure ? loadError.message : 'Search failed.'}</Notice>}
      {isLoading && <p className="text-muted">Searching…</p>}
      {data && data.results.length === 0 && <Notice>Nothing found on TMDB for that.</Notice>}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-x-[18px] gap-y-7">
        {data?.results.map((r) => (
          <div key={`${r.kind}-${r.tmdbId}`} className="flex flex-col gap-2">
            <Poster title={r.title} path={r.posterPath} />
            <div className="flex flex-col gap-0.5">
              <span className="text-sm font-semibold">{r.title}</span>
              <span className="text-xs text-muted">
                {r.kind === 'movie' ? 'Movie' : 'Show'} · {r.year ?? '—'}
              </span>
            </div>
            {r.libraryId ? (
              <Link to={r.kind === 'movie' ? `/movies/${r.libraryId}` : `/shows/${r.libraryId}`} className="text-sm font-semibold">
                In your library →
              </Link>
            ) : user.role === 'admin' ? (
              <div className="flex flex-col gap-1.5">
                <Button className="h-10 text-sm" onClick={() => add(r, true)} disabled={adding !== null}>
                  {adding === r.tmdbId ? 'Adding…' : 'Add and look for it'}
                </Button>
                <Button variant="ghost" className="h-10 text-sm" onClick={() => add(r, false)} disabled={adding !== null}>
                  Just add
                </Button>
              </div>
            ) : (
              <Link to={`/discover/${r.kind}/${r.tmdbId}`} className="text-sm font-semibold">
                Ask for it →
              </Link>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
