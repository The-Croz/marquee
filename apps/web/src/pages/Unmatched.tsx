import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import type { SearchResult, UnmatchedItem } from '@marquee/shared';
import { api, ApiFailure, queryClient } from '../api';
import { Poster } from '../components/Poster';
import { Button, Card, Notice } from '../components/ui';

type Candidate = { tmdbId: number; title: string; year: number | null; posterPath: string | null };

function ItemCard({ item, onDone }: { item: UnmatchedItem; onDone: (msg: string) => void }) {
  const [results, setResults] = useState<Candidate[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shown = results ?? item.candidates;

  async function search(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const q = String(new FormData(e.currentTarget).get('q') ?? '').trim();
    if (!q) return;
    setError(null);
    try {
      const r = await api<{ results: SearchResult[] }>(`/library/search?${new URLSearchParams({ q, kind: item.kind })}`);
      setResults(r.results.map(({ tmdbId, title, year, posterPath }) => ({ tmdbId, title, year, posterPath })));
    } catch (err) {
      setError(err instanceof ApiFailure ? err.message : 'Search failed.');
    }
  }

  async function match(c: Candidate) {
    setBusy(true);
    setError(null);
    try {
      await api(`/library/unmatched/${item.id}/match`, { body: { tmdbId: c.tmdbId } });
      onDone(`Matched “${item.folder}” to ${c.title}${c.year ? ` (${c.year})` : ''}.`);
    } catch (err) {
      setError(err instanceof ApiFailure ? err.message : 'Matching failed.');
      setBusy(false);
    }
  }

  async function ignore() {
    await api(`/library/unmatched/${item.id}/ignore`, { body: {} });
    onDone(`Ignoring “${item.folder}”.`);
  }

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-[220px] flex-1">
          <div className="text-xs font-semibold tracking-wider text-amber uppercase">{item.kind === 'movie' ? 'Movie folder' : 'Show folder'}</div>
          <div className="mt-1 text-[17px] font-semibold break-words">{item.folder}</div>
          <div className="mt-1 text-sm text-muted">{item.reason}</div>
        </div>
        <Button variant="ghost" className="h-10 px-4 text-sm" onClick={ignore} disabled={busy}>
          Ignore this folder
        </Button>
      </div>

      <form onSubmit={search} className="flex flex-wrap gap-2">
        <label htmlFor={`q-${item.id}`} className="sr-only">
          Search TMDB
        </label>
        <input
          id={`q-${item.id}`}
          name="q"
          defaultValue={[item.parsedTitle, item.parsedYear].filter(Boolean).join(' ')}
          className="h-11 flex-[1_1_240px] rounded-xl border border-line-strong bg-ink px-4 text-[15px] text-text focus:border-amber focus:outline-none"
        />
        <Button type="submit" variant="ghost" className="h-11">
          Search TMDB
        </Button>
      </form>

      {error && <Notice tone="error">{error}</Notice>}
      {shown.length === 0 ? (
        <p className="m-0 text-sm text-muted">No suggestions. Try a different search.</p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(110px,1fr))] gap-3">
          {shown.map((c) => (
            <button
              key={c.tmdbId}
              type="button"
              onClick={() => match(c)}
              disabled={busy}
              className="flex flex-col gap-1.5 rounded-xl p-1 text-left text-text hover:bg-raised disabled:opacity-50"
              aria-label={`Match to ${c.title} ${c.year ?? ''}`}
            >
              <Poster title={c.title} path={c.posterPath} size="w185" />
              <span className="text-[13px] leading-tight font-semibold">{c.title}</span>
              <span className="text-xs text-muted">{c.year ?? '—'}</span>
            </button>
          ))}
        </div>
      )}
    </Card>
  );
}

export function UnmatchedPage() {
  const { data } = useQuery({ queryKey: ['unmatched'], queryFn: () => api<{ items: UnmatchedItem[] }>('/library/unmatched') });
  const [message, setMessage] = useState<string | null>(null);
  const done = (msg: string) => {
    setMessage(msg);
    void queryClient.invalidateQueries({ queryKey: ['unmatched'] });
    void queryClient.invalidateQueries({ queryKey: ['library'] });
  };
  return (
    <>
      <Link to="/movies" className="text-sm no-underline">
        ← Library
      </Link>
      <div className="flex flex-col gap-2">
        <h1 className="m-0 font-display text-[56px] leading-none font-normal">Needs a match</h1>
        <p className="m-0 max-w-[680px] text-[15px] text-muted">
          Marquee couldn't be sure which title these folders are. Pick the right one and it will remember. Nothing on disk is renamed or moved.
        </p>
      </div>
      {message && <Notice tone="success">{message}</Notice>}
      {data && data.items.length === 0 && <Notice>Everything is matched.</Notice>}
      <div className="flex max-w-[960px] flex-col gap-4">
        {data?.items.map((i) => (
          <ItemCard key={i.id} item={i} onDone={done} />
        ))}
      </div>
    </>
  );
}
