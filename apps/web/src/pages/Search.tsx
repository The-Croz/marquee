import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import type { SearchResult, SessionUser } from '@marquee/shared';
import { api, ApiFailure, queryClient } from '../api';
import { Poster } from '../components/Poster';
import { Button, Notice } from '../components/ui';

export function SearchBox({ initial = '', autoFocus = false }: { initial?: string; autoFocus?: boolean }) {
  const navigate = useNavigate();
  return (
    <form
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        const q = String(new FormData(e.currentTarget).get('q') ?? '').trim();
        if (q) navigate(`/search?${new URLSearchParams({ q })}`);
      }}
      className="flex flex-[1_1_360px]"
    >
      <label htmlFor="search-q" className="sr-only">
        Search movies and shows
      </label>
      <input
        id="search-q"
        name="q"
        type="search"
        defaultValue={initial}
        autoFocus={autoFocus}
        placeholder="Search movies and shows"
        className="h-12 w-full rounded-xl border border-line bg-panel px-[18px] text-[15px] text-text placeholder:text-dim focus:border-amber focus:outline-none"
      />
    </form>
  );
}

export function SearchPage({ user }: { user: SessionUser }) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const q = params.get('q') ?? '';
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<number | null>(null);
  const { data, isLoading, error: loadError } = useQuery({
    queryKey: ['search', q],
    queryFn: () => api<{ results: SearchResult[] }>(`/library/search?${new URLSearchParams({ q })}`),
    enabled: q.length > 0,
  });

  async function add(r: SearchResult) {
    setAdding(r.tmdbId);
    setError(null);
    try {
      const res = await api<{ id: number; kind: 'movie' | 'series' }>('/library/add', { body: { kind: r.kind, tmdbId: r.tmdbId } });
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
        <SearchBox initial={q} autoFocus={!q} />
      </div>
      {q && <h1 className="m-0 text-2xl font-semibold">Results for “{q}”</h1>}
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
              <Button variant="ghost" className="h-10 text-sm" onClick={() => add(r)} disabled={adding !== null}>
                {adding === r.tmdbId ? 'Adding…' : 'Add to library'}
              </Button>
            ) : (
              <span className="text-xs text-dim">Requests arrive in Milestone 5</span>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
