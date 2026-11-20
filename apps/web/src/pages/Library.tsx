import { useEffect, useState } from 'react';
import { Link, Navigate, useLocation, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import type { LibraryCard, ScanStatusView, SessionUser, UnmatchedItem } from '@marquee/shared';
import { api, ApiFailure, queryClient } from '../api';
import { Poster, formatBytes, posterTransition } from '../components/Poster';
import { Button, Notice, Progress, cx } from '../components/ui';
import { PageHeader, Tabs } from '../components/Page';
import { useToast } from '../components/Overlay';
import { refreshLibrary } from '../components/Wanted';
import { SearchBox } from './Search';

const PHASE: Record<ScanStatusView['phase'], string> = {
  idle: 'Not scanned yet',
  preparing: 'Getting ready…',
  movies: 'Reading movies…',
  shows: 'Reading shows…',
  cleanup: 'Tidying up…',
  done: 'Scan finished',
  failed: 'Scan failed',
};

/** Scan button + live progress. Admins only. */
export function ScanPanel() {
  const [error, setError] = useState<string | null>(null);
  const { data: status } = useQuery({
    queryKey: ['scan'],
    queryFn: () => api<ScanStatusView>('/library/scan'),
    refetchInterval: (q) => (q.state.data?.running ? 1500 : false),
  });
  const { data: unmatched } = useQuery({ queryKey: ['unmatched'], queryFn: () => api<{ items: UnmatchedItem[] }>('/library/unmatched') });

  // When a scan finishes, refresh everything that shows library data.
  const running = status?.running ?? false;
  useEffect(() => {
    if (!running) {
      void queryClient.invalidateQueries({ queryKey: ['library'] });
      void queryClient.invalidateQueries({ queryKey: ['unmatched'] });
      void queryClient.invalidateQueries({ queryKey: ['home'] });
    }
  }, [running]);

  async function scan() {
    setError(null);
    try {
      await api('/library/scan', { body: {} });
      await queryClient.invalidateQueries({ queryKey: ['scan'] });
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : "Couldn't start the scan.");
    }
  }

  const pct = status && status.total > 0 ? Math.round((status.processed / status.total) * 100) : 0;
  const needMatch = unmatched?.items.length ?? 0;

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-line bg-panel p-4 sm:flex-row sm:items-center sm:gap-5">
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-body font-semibold">{status ? PHASE[status.phase] : 'Library'}</span>
          {status?.running && (
            <span className="text-sm text-muted">
              {status.processed} of {status.total} folders · {status.matched} matched
            </span>
          )}
          {!status?.running && status?.phase === 'done' && (
            <span className="text-sm text-muted">
              {status.matched} matched{status.unmatched ? ` · ${status.unmatched} ${status.unmatched === 1 ? 'needs' : 'need'} a match` : ''}
              {status.finishedAt ? ` · ${new Date(status.finishedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}
            </span>
          )}
          {needMatch > 0 && (
            <Link to="/library/unmatched" className="text-sm font-semibold">
              {needMatch} {needMatch === 1 ? 'folder needs' : 'folders need'} a match →
            </Link>
          )}
        </div>
        {status?.running && <Progress value={pct} />}
        {status?.error && <span className="text-sm text-warn">{status.error}</span>}
        {!status?.running && (status?.warnings.length ?? 0) > 0 && (
          <details className="text-sm text-muted">
            <summary className="cursor-pointer text-warn">{status!.warnings.length} warning{status!.warnings.length > 1 ? 's' : ''}</summary>
            <ul className="mt-2 flex flex-col gap-1 pl-4">
              {status!.warnings.map((w) => (
                <li key={w} className="list-disc break-words">
                  {w}
                </li>
              ))}
            </ul>
          </details>
        )}
        {error && <span className="text-sm text-warn">{error}</span>}
      </div>
      <Button onClick={scan} disabled={status?.running} variant={status?.phase === 'idle' ? 'primary' : 'ghost'}>
        {status?.running ? 'Scanning…' : status?.phase === 'idle' ? 'Scan library' : 'Scan again'}
      </Button>
    </div>
  );
}

const LAST_KIND = 'marquee.library.kind';

/** `/library`: opens Movies or Shows, whichever you looked at last. */
export function LibraryHome() {
  let last: string | null = null;
  try {
    last = localStorage.getItem(LAST_KIND);
  } catch {
    // Private windows can refuse storage; Movies is fine.
  }
  return <Navigate to={last === 'shows' ? '/library/shows' : '/library/movies'} replace />;
}

/** Old `/movies` and `/shows` links land on the matching Library tab, keeping any filters. */
export function LibraryRedirect({ to }: { to: 'movies' | 'shows' }) {
  const { search } = useLocation();
  return <Navigate to={`/library/${to}${search}`} replace />;
}

export function LibraryPage({ kind, user }: { kind: 'movie' | 'series'; user: SessionUser }) {
  useEffect(() => {
    try {
      localStorage.setItem(LAST_KIND, kind === 'movie' ? 'movies' : 'shows');
    } catch {
      // Not remembering is fine.
    }
  }, [kind]);
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const filter = params.get('filter') ?? 'all';
  const sort = params.get('sort') ?? 'added';
  const wantedFilter = params.get('wanted') ?? 'all';
  const isAdmin = user.role === 'admin';
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [bulkError, setBulkError] = useState<string | null>(null);
  const toast = useToast();
  const endpoint = kind === 'movie' ? '/movies' : '/shows';
  const { data, isLoading } = useQuery({
    queryKey: ['library', kind, q, filter, sort, wantedFilter],
    queryFn: () => api<{ items: LibraryCard[] }>(`${endpoint}?${new URLSearchParams({ q, filter, sort, ...(wantedFilter !== 'all' ? { wanted: wantedFilter } : {}) })}`),
  });
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v && v !== 'all' && !(k === 'sort' && v === 'added')) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };
  const items = data?.items ?? [];
  const total = items.reduce((n, i) => n + i.sizeBytes, 0);
  const title = kind === 'movie' ? 'Movies' : 'Shows';
  const wantedCount = items.filter((i) => i.wanted).length;

  async function markPicked(wanted: boolean) {
    setBulkError(null);
    // Undo puts each one back the way it was, not all to the opposite.
    const before = items.filter((i) => picked.has(i.id));
    try {
      await api(`${endpoint}/wanted`, { body: { ids: [...picked], wanted } });
      await refreshLibrary();
      setPicked(new Set());
      setSelecting(false);
      const noun = kind === 'movie' ? (before.length === 1 ? 'movie' : 'movies') : before.length === 1 ? 'show' : 'shows';
      toast({
        message: wanted ? `Looking for ${before.length} ${noun}.` : `Stopped looking for ${before.length} ${noun}.`,
        undo: async () => {
          const was = (w: boolean) => before.filter((i) => i.wanted === w).map((i) => i.id);
          for (const w of [true, false]) if (was(w).length) await api(`${endpoint}/wanted`, { body: { ids: was(w), wanted: w } });
          await refreshLibrary();
        },
      });
    } catch (e) {
      setBulkError(e instanceof ApiFailure ? e.message : 'That didn’t save. Try again.');
    }
  }
  const togglePick = (id: number) => setPicked((prev) => new Set(prev.has(id) ? [...prev].filter((x) => x !== id) : [...prev, id]));

  return (
    <>
      <PageHeader
        title="Library"
        docTitle={`${title} · Library`}
        meta={
          data && (
            <>
              {items.length} {kind === 'movie' ? (items.length === 1 ? 'movie' : 'movies') : items.length === 1 ? 'show' : 'shows'}
              {total > 0 && ` · ${formatBytes(total)}`}
              {isAdmin && ` · ${wantedCount} Wanted`}
            </>
          )
        }
        actions={
          user.role !== 'kid' && (
            <div className="flex w-full min-w-0 sm:w-[420px]">
              <SearchBox kind={kind} />
            </div>
          )
        }
      />
      <Tabs
        label="Movies or shows"
        items={[
          { value: 'movie', label: 'Movies', to: '/library/movies' },
          { value: 'series', label: 'Shows', to: '/library/shows' },
        ]}
      />

      {user.role === 'admin' && <ScanPanel />}

      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor="lib-q" className="sr-only">
          Filter {title.toLowerCase()}
        </label>
        <input
          id="lib-q"
          type="search"
          value={q}
          onChange={(e) => set('q', e.target.value)}
          placeholder={`Filter ${title.toLowerCase()}`}
          className="h-11 flex-[1_1_240px] rounded-xl border border-line bg-panel px-4 text-body text-text placeholder:text-dim focus:border-amber focus:outline-none"
        />
        <div role="group" aria-label="Show" className="flex gap-1.5">
          {[
            ['all', 'All'],
            ['have', kind === 'movie' ? 'On disk' : 'Complete'],
            ['missing', kind === 'movie' ? 'Missing' : 'Incomplete'],
          ].map(([v, label]) => (
            <button
              key={v}
              type="button"
              aria-pressed={filter === v}
              onClick={() => set('filter', v!)}
              className={cx('h-11 rounded-full border px-4 text-sm font-medium', filter === v ? 'border-amber bg-amber text-amber-ink' : 'border-line bg-panel text-soft hover:text-text')}
            >
              {label}
            </button>
          ))}
        </div>
        <label htmlFor="lib-sort" className="sr-only">
          Sort by
        </label>
        <select id="lib-sort" value={sort} onChange={(e) => set('sort', e.target.value)} className="h-11 rounded-xl border border-line bg-panel px-3 text-sm text-text">
          <option value="added">Recently added</option>
          <option value="title">Title</option>
          <option value="year">Year</option>
        </select>
        {isAdmin && (
          <>
            <label htmlFor="lib-wanted" className="sr-only">
              Wanted
            </label>
            <select id="lib-wanted" value={wantedFilter} onChange={(e) => set('wanted', e.target.value)} className="h-11 rounded-xl border border-line bg-panel px-3 text-sm text-text">
              <option value="all">Wanted and not</option>
              <option value="yes">Wanted</option>
              <option value="no">Not wanted</option>
            </select>
            <Button
              type="button"
              variant="ghost"
              aria-pressed={selecting}
              onClick={() => {
                setSelecting(!selecting);
                setPicked(new Set());
              }}
            >
              {selecting ? 'Done' : 'Choose several'}
            </Button>
          </>
        )}
      </div>
      {selecting && (
        <div role="region" aria-label="Wanted for the ones you picked" className="flex flex-wrap items-center gap-3 rounded-2xl border border-amber/60 bg-amber/8 px-4 py-3">
          <span className="text-sm text-soft">{picked.size} picked</span>
          <Button type="button" variant="ghost" className="h-11 px-3.5 text-sm" onClick={() => setPicked(new Set(items.map((i) => i.id)))}>
            Pick all {items.length} shown
          </Button>
          <Button type="button" className="h-11 px-3.5 text-sm" disabled={!picked.size} onClick={() => markPicked(true)}>
            Look for these
          </Button>
          <Button type="button" variant="ghost" className="h-11 px-3.5 text-sm" disabled={!picked.size} onClick={() => markPicked(false)}>
            Stop looking for these
          </Button>
          {bulkError && <span className="text-sm text-warn">{bulkError}</span>}
        </div>
      )}

      {isLoading && <p className="text-muted">Loading…</p>}
      {data && items.length === 0 && (
        <Notice>
          {q ? (
            <>
              Nothing in your library matches that.{' '}
              {user.role !== 'kid' && <Link to={`/search?${new URLSearchParams({ q, kind })}`}>Look for “{q}” to add it →</Link>}
            </>
          ) : filter !== 'all'
            ? 'Nothing matches that.'
            : user.role === 'admin'
              ? `No ${title.toLowerCase()} yet. Add your TMDB key in Settings → Services, then scan your library.`
              : `No ${title.toLowerCase()} yet.`}
        </Notice>
      )}

      <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-x-[18px] gap-y-6">
        {items.map((i) => {
          const tile = (
            <>
            <div className="relative">
              <Poster title={i.title} path={i.posterPath} color={i.posterColor} transition={posterTransition(`${endpoint}/${i.id}`)} className={cx('transition group-hover:ring-2 group-hover:ring-amber', !i.complete && 'opacity-60')} />
              <span
                className={cx(
                  'absolute top-2 left-2 rounded-md px-2 py-0.5 text-caption font-semibold',
                  i.complete ? 'bg-ink/85 text-soft' : 'bg-warn/90 text-warn-ink',
                )}
              >
                {i.badge}
              </span>
              {isAdmin && i.wanted && <span className="absolute top-2 right-2 rounded-md bg-amber px-2 py-0.5 text-caption font-semibold text-amber-ink">Wanted</span>}
              {selecting && (
                <span aria-hidden="true" className={cx('absolute right-2 bottom-2 flex size-6 items-center justify-center rounded-full border-2 text-sm font-bold', picked.has(i.id) ? 'border-amber bg-amber text-amber-ink' : 'border-white/70 bg-ink/70')}>
                  {picked.has(i.id) ? '✓' : ''}
                </span>
              )}
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="truncate text-sm font-semibold">{i.title}</span>
              <span className="text-xs text-muted">{i.year ?? '—'}</span>
            </div>
          </>
          );
          return selecting ? (
            <button key={i.id} type="button" aria-pressed={picked.has(i.id)} onClick={() => togglePick(i.id)} className="group flex flex-col gap-2 text-left text-text">
              {tile}
            </button>
          ) : (
            <Link key={i.id} to={`${endpoint}/${i.id}`} viewTransition className="group flex flex-col gap-2 text-text no-underline hover:text-text">
              {tile}
            </Link>
          );
        })}
      </div>
    </>
  );
}
