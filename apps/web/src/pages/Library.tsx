import { useEffect, useState } from 'react';
import { Link, Navigate, useLocation, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import type { LibraryCard, ScanStatusView, SessionUser, ShowPreset, ShowWantedSnapshot, UnmatchedItem } from '@marquee/shared';
import { api, ApiFailure, queryClient } from '../api';
import { Poster, formatBytes, posterTransition } from '../components/Poster';
import { Button, Notice, Progress, cx } from '../components/ui';
import { Chips, PageHeader, Tabs } from '../components/Page';
import { Menu, MenuDivider, Sheet, menuItemClass, useToast } from '../components/Overlay';
import { SHOW_PRESETS } from './GettingIn';
import { refreshLibrary } from '../components/Wanted';
import { RenameSheet } from '../components/LibraryCare';
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

/** The library scan: its status, the folders needing a match, and a way to start one. */
function useScan() {
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
      setError(e instanceof ApiFailure ? e.message : "Couldn't start the scan. Try again in a moment.");
    }
  }
  return { status, needMatch: unmatched?.items.length ?? 0, scan, error };
}

/**
 * The scan only takes room on the page when there's something to say: it
 * has never run, it's running, it failed, or it left warnings. Otherwise
 * "Scan for new files" lives in the ⋯ menu.
 */
function ScanStatusLine({ scan }: { scan: ReturnType<typeof useScan> }) {
  const { status, error } = scan;
  if (!status) return null;
  const pct = status.total > 0 ? Math.round((status.processed / status.total) * 100) : 0;
  if (status.phase === 'idle') {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-panel p-4">
        <span className="flex-1 text-sm text-soft">Marquee hasn’t read your library folders yet. It doesn’t move or change anything.</span>
        <Button onClick={scan.scan}>Scan library</Button>
      </div>
    );
  }
  const warnings = !status.running ? status.warnings : [];
  if (!status.running && !status.error && !error && warnings.length === 0) return null;
  return (
    <div role="status" className="flex flex-col gap-2 rounded-xl border border-line bg-panel px-4 py-3 text-sm">
      {status.running && (
        <>
          <span className="text-soft">
            {PHASE[status.phase]} {status.processed} of {status.total} folders · {status.matched} matched
          </span>
          <Progress value={pct} />
        </>
      )}
      {status.error && <span className="text-warn">{status.error} Try “Scan for new files” in the ⋯ menu again.</span>}
      {error && <span className="text-warn">{error}</span>}
      {warnings.length > 0 && (
        <details className="text-muted">
          <summary className="cursor-pointer text-warn">
            The last scan left {warnings.length} warning{warnings.length > 1 ? 's' : ''}
          </summary>
          <ul className="mt-2 flex flex-col gap-1 pl-4">
            {warnings.map((w) => (
              <li key={w} className="list-disc break-words">
                {w}
              </li>
            ))}
          </ul>
        </details>
      )}
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
  // Older links put Needs a look in `filter`; it has its own place now.
  const rawFilter = params.get('filter') ?? 'all';
  const filter = rawFilter === 'have' || rawFilter === 'missing' ? rawFilter : 'all';
  const need = params.get('need') ?? (rawFilter === 'wanted_missing' || rawFilter === 'not_good_enough' ? rawFilter : '');
  const sort = params.get('sort') ?? 'added';
  const wantedFilter = params.get('wanted') ?? 'all';
  const [filtering, setFiltering] = useState(false);
  const [bulkPreset, setBulkPreset] = useState<ShowPreset>('all');
  const isAdmin = user.role === 'admin';
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const toast = useToast();
  const scan = useScan();
  const endpoint = kind === 'movie' ? '/movies' : '/shows';
  const { data, isLoading } = useQuery({
    queryKey: ['library', kind, q, filter, sort, wantedFilter, need],
    queryFn: () => api<{ items: LibraryCard[] }>(`${endpoint}?${new URLSearchParams({ q, filter, sort, ...(wantedFilter !== 'all' ? { wanted: wantedFilter } : {}), ...(need ? { need } : {}) })}`),
  });
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (k === 'filter' || k === 'need') {
      // Drop an older link's Needs a look from `filter` once anything is chosen.
      if (rawFilter === 'wanted_missing' || rawFilter === 'not_good_enough') {
        next.delete('filter');
        if (k !== 'need' && need) next.set('need', need);
      }
    }
    if (v && v !== 'all' && !(k === 'sort' && v === 'added')) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };
  // What's filtered, as removable chips.
  const active = [
    filter !== 'all' && { key: 'filter', label: filter === 'have' ? (kind === 'movie' ? 'On disk' : 'Complete') : kind === 'movie' ? 'Missing' : 'Incomplete' },
    isAdmin && wantedFilter !== 'all' && { key: 'wanted', label: wantedFilter === 'yes' ? 'Wanted' : 'Not wanted' },
    isAdmin && need && { key: 'need', label: need === 'not_good_enough' ? 'Not good enough yet' : kind === 'movie' ? 'Wanted, nothing yet' : 'Wanted, episodes missing' },
  ].filter((a): a is { key: string; label: string } => !!a);
  const items = data?.items ?? [];
  const total = items.reduce((n, i) => n + i.sizeBytes, 0);
  const title = kind === 'movie' ? 'Movies' : 'Shows';
  const wantedCount = items.filter((i) => i.wanted).length;

  /** Look for these: Wanted, and searched for right now. */
  async function lookFor() {
    setBulkError(null);
    try {
      const r = await api<{ message: string }>(`${endpoint}/look-now`, { body: { ids: [...picked] } });
      await refreshLibrary();
      setPicked(new Set());
      setSelecting(false);
      toast({ message: r.message });
    } catch (e) {
      setBulkError(e instanceof ApiFailure ? e.message : 'That didn’t start. Try again.');
    }
  }

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
  /** "Which episodes" for every show picked, with Undo putting each back as it was. */
  async function setEpisodesPicked() {
    setBulkError(null);
    const n = picked.size;
    try {
      const r = await api<{ changed: number; before: ShowWantedSnapshot[] }>('/shows/episodes-wanted', { body: { ids: [...picked], preset: bulkPreset } });
      await refreshLibrary();
      setPicked(new Set());
      setSelecting(false);
      const label = SHOW_PRESETS.find((p) => p.value === bulkPreset)!.label;
      toast({
        message: `${label}: ${r.changed || n} ${r.changed === 1 ? 'show' : 'shows'}.`,
        undo: async () => {
          await api('/shows/episodes-wanted/restore', { body: { before: r.before } });
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
        // Admins add titles from More on phones, so the add box only takes room on wide screens.
        actionsWideOnly={isAdmin}
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

      {isAdmin && <ScanStatusLine scan={scan} />}

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
          className="order-1 h-11 min-w-0 flex-[1_1_200px] rounded-xl border border-line bg-panel px-4 text-body text-text placeholder:text-dim focus:border-amber focus:outline-none"
        />
        <div className="order-4 flex w-full gap-2 sm:order-3 sm:w-auto">
          <Button type="button" variant="ghost" className="h-11 flex-1 sm:flex-none" aria-haspopup="dialog" onClick={() => setFiltering(true)}>
            Filter{active.length ? ` · ${active.length}` : ''}
          </Button>
          <label htmlFor="lib-sort" className="sr-only">
            Sort by
          </label>
          <select id="lib-sort" value={sort} onChange={(e) => set('sort', e.target.value)} className="h-11 min-w-0 flex-1 rounded-xl border border-line bg-panel px-3 text-sm text-text sm:flex-none">
            <option value="added">Recently added</option>
            <option value="title">Title</option>
            <option value="year">Year</option>
          </select>
          {selecting && (
            <Button type="button" variant="ghost" onClick={() => (setSelecting(false), setPicked(new Set()))}>
              Done choosing
            </Button>
          )}
        </div>
        {isAdmin && (
          <Menu
            label={`More for ${title.toLowerCase()}`}
            className="order-2 w-auto sm:order-last sm:ml-auto"
            trigger={
              <span className="flex h-11 items-center gap-2 rounded-xl border border-line bg-panel px-3.5 text-sm font-medium text-soft">
                {scan.status?.running ? 'Scanning…' : 'More'}
                <span aria-hidden="true" className="text-lg leading-none">
                  ⋯
                </span>
              </span>
            }
          >
            <button type="button" role="menuitem" className={menuItemClass} disabled={scan.status?.running} onClick={() => void scan.scan()}>
              {scan.status?.running ? 'Scanning your folders…' : 'Scan for new files'}
            </button>
            {scan.status?.finishedAt && !scan.status.running && (
              <span className="px-3 pb-1.5 text-caption text-dim">
                Last scan {new Date(scan.status.finishedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · {scan.status.matched} matched
              </span>
            )}
            <Link to="/library/unmatched" role="menuitem" className={menuItemClass}>
              {scan.needMatch > 0 ? `${scan.needMatch} ${scan.needMatch === 1 ? 'folder needs' : 'folders need'} a match` : 'Folders that need a match'}
            </Link>
            <MenuDivider />
            <button
              type="button"
              role="menuitem"
              className={menuItemClass}
              onClick={() => {
                setSelecting(!selecting);
                setPicked(new Set());
              }}
            >
              {selecting ? 'Stop choosing' : 'Choose several…'}
            </button>
            <button type="button" role="menuitem" className={menuItemClass} onClick={() => setRenaming(true)}>
              Rename files to Marquee’s names…
            </button>
            <MenuDivider />
            <Link to="/library/care" role="menuitem" className={menuItemClass}>
              Library care: import, clean up, not watched…
            </Link>
          </Menu>
        )}
      </div>
      {active.length > 0 && (
        <div role="group" aria-label="Filters on" className="flex flex-wrap items-center gap-1.5">
          {active.map((a) => (
            <button key={a.key} type="button" onClick={() => set(a.key, '')} className="inline-flex h-9 items-center gap-1.5 rounded-full border border-amber/60 bg-amber/10 px-3 text-sm text-text hover:bg-amber/20" aria-label={`Remove filter: ${a.label}`}>
              {a.label} <span aria-hidden="true" className="text-muted">×</span>
            </button>
          ))}
          {active.length > 1 && (
            <button type="button" onClick={() => setParams(q ? { q } : {}, { replace: true })} className="h-9 px-2 text-sm text-amber">
              Clear all
            </button>
          )}
        </div>
      )}
      <Sheet open={filtering} onClose={() => setFiltering(false)} title={`Filter ${title.toLowerCase()}`}>
        <div className="flex flex-col gap-5 pt-1 pb-2">
          <FilterGroup label="On disk" value={filter} onChange={(v) => set('filter', v)} items={[{ value: 'all', label: 'All' }, { value: 'have', label: kind === 'movie' ? 'On disk' : 'Complete' }, { value: 'missing', label: kind === 'movie' ? 'Missing' : 'Incomplete' }]} />
          {isAdmin && (
            <>
              <FilterGroup label="Looking for" value={wantedFilter} onChange={(v) => set('wanted', v)} items={[{ value: 'all', label: 'Any' }, { value: 'yes', label: 'Wanted' }, { value: 'no', label: 'Not wanted' }]} />
              <FilterGroup
                label="Needs a look"
                value={need || 'all'}
                onChange={(v) => set('need', v)}
                items={[{ value: 'all', label: 'Anything' }, { value: 'wanted_missing', label: kind === 'movie' ? 'Wanted, nothing yet' : 'Wanted, episodes missing' }, { value: 'not_good_enough', label: 'Not good enough yet' }]}
              />
            </>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" onClick={() => setFiltering(false)}>
              Show {items.length} {kind === 'movie' ? (items.length === 1 ? 'movie' : 'movies') : items.length === 1 ? 'show' : 'shows'}
            </Button>
            {active.length > 0 && (
              <Button type="button" variant="ghost" onClick={() => setParams(q ? { q } : {}, { replace: true })}>
                Clear filters
              </Button>
            )}
          </div>
        </div>
      </Sheet>
      {isAdmin && !selecting && items.length > 0 && (need === 'wanted_missing' || need === 'not_good_enough') && (
        <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-panel px-4 py-3">
          <span className="min-w-[200px] flex-1 text-sm text-soft">
            {need === 'wanted_missing'
              ? kind === 'movie'
                ? 'Wanted, with nothing on disk yet. Marquee looks for these by itself every few hours; Look for these searches now.'
                : 'Wanted, with episodes that are out but not on disk. Look for these searches now.'
              : 'You have these, but below their profile’s “good enough”, so Marquee would still take a better copy. Look for these searches now.'}
          </span>
          <Button
            type="button"
            className="h-11 px-3.5 text-sm"
            onClick={() => {
              setSelecting(true);
              setPicked(new Set(items.map((i) => i.id)));
            }}
          >
            Look for these…
          </Button>
        </div>
      )}
      {selecting && (
        <div role="region" aria-label="Wanted for the ones you picked" className="flex flex-wrap items-center gap-3 rounded-2xl border border-amber/60 bg-amber/8 px-4 py-3">
          <span className="text-sm text-soft">{picked.size} picked</span>
          <Button type="button" variant="ghost" className="h-11 px-3.5 text-sm" onClick={() => setPicked(new Set(items.map((i) => i.id)))}>
            Pick all {items.length} shown
          </Button>
          {kind === 'series' ? (
            <>
              <label className="flex items-center gap-2 text-sm text-soft">
                Which episodes
                <select value={bulkPreset} onChange={(e) => setBulkPreset(e.target.value as ShowPreset)} className="h-11 rounded-lg border border-line-strong bg-panel px-2.5 text-sm text-text">
                  {SHOW_PRESETS.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
              <Button type="button" className="h-11 px-3.5 text-sm" disabled={!picked.size} onClick={() => void setEpisodesPicked()}>
                Apply to {picked.size || ''} {picked.size === 1 ? 'show' : 'shows'}
              </Button>
              <Button type="button" variant="ghost" className="h-11 px-3.5 text-sm" disabled={!picked.size} onClick={() => void lookFor()}>
                Look for these now
              </Button>
            </>
          ) : (
            <>
              <Button type="button" className="h-11 px-3.5 text-sm" disabled={!picked.size} onClick={() => void lookFor()}>
                Look for these
              </Button>
              <Button type="button" variant="ghost" className="h-11 px-3.5 text-sm" disabled={!picked.size} onClick={() => markPicked(false)}>
                Stop looking for these
              </Button>
            </>
          )}
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

      {isAdmin && <RenameSheet open={renaming} onClose={() => setRenaming(false)} kind={kind === 'movie' ? 'movie' : 'tv'} />}

      <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-x-[18px] gap-y-6">
        {items.map((i) => {
          const tile = (
            <>
            <div className="relative">
              <Poster title={i.title} path={i.posterPath} color={i.posterColor} transition={posterTransition(`${endpoint}/${i.id}`)} className={cx('transition group-hover:ring-2 group-hover:ring-amber', !i.complete && 'opacity-60')} />
              <CornerLabel card={i} isAdmin={isAdmin} />
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

/** One group in the Filter sheet: a heading and its choices. */
function FilterGroup({ label, value, onChange, items }: { label: string; value: string; onChange: (v: string) => void; items: { value: string; label: string }[] }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-label font-semibold text-muted">{label}</span>
      <Chips<string> label={label} value={value} onChange={onChange} items={items} className="sm:flex-wrap" />
    </div>
  );
}

/**
 * The poster's one corner label. Shows: "5 of 8" episodes; movies: the
 * quality, or Looking / Not on disk. For admins its colour says whether
 * Marquee is looking (amber) or not (grey) for what's missing, and the dot
 * whether it watches for what comes next (new episodes, a better copy).
 */
function CornerLabel({ card, isAdmin }: { card: LibraryCard; isAdmin: boolean }) {
  const missing = !card.complete && card.badge !== 'Not aired yet';
  const text = card.kind === 'movie' && missing && isAdmin ? (card.looking ? 'Looking' : 'Not on disk') : card.badge;
  const tone = !missing ? 'bg-ink/85 text-soft' : !isAdmin ? 'bg-warn/90 text-warn-ink' : card.looking ? 'bg-amber text-amber-ink' : 'bg-line-strong/95 text-soft';
  const meaning = isAdmin
    ? [missing ? (card.looking ? 'Marquee is looking for what’s missing' : 'Missing, and Marquee isn’t looking') : null, card.watching ? (card.kind === 'movie' ? 'watching for a better copy' : 'watching for new episodes') : null].filter(Boolean).join('; ')
    : '';
  return (
    <span className={cx('absolute top-2 left-2 inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-caption font-semibold tabular-nums', tone)} title={meaning || undefined}>
      {isAdmin && card.watching && (
        <span aria-hidden="true" className={cx('size-1.5 rounded-full', missing && card.looking ? 'bg-amber-ink' : 'bg-amber')} />
      )}
      {text}
      {meaning && <span className="sr-only"> ({meaning})</span>}
    </span>
  );
}
