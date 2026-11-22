import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { HistoryView } from '@marquee/shared';
import { api, ApiFailure } from '../api';
import { HISTORY_KINDS, HistoryRow, NeverPickList, useNeverPick } from '../components/History';
import { EmptyState, PageHeader } from '../components/Page';
import { Button, Notice, cx } from '../components/ui';
import { DownloadsTabs } from './Downloads';

/**
 * One History of every download: sent, in the library, upgraded, replaced,
 * removed, imports that failed. Filter by what happened, by title or copy
 * name, and by days; each row links to its title.
 */
export function DownloadHistoryPage() {
  const [params, setParams] = useSearchParams();
  const [words, setWords] = useState(params.get('q') ?? '');
  const events = (params.get('event') ?? '').split(',').filter(Boolean);
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const movieId = params.get('movieId');
  const seriesId = params.get('seriesId');
  const set = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };
  const toggle = (e: string) => set('event', (events.includes(e) ? events.filter((x) => x !== e) : [...events, e]).join(',') || null);

  const qs = new URLSearchParams();
  for (const key of ['event', 'q', 'from', 'to', 'movieId', 'seriesId']) {
    const v = params.get(key);
    if (v) qs.set(key, v);
  }
  const q = useInfiniteQuery({
    queryKey: ['history', qs.toString()],
    queryFn: ({ pageParam }) => api<HistoryView>(`/history?${qs.toString()}${pageParam ? `&before=${pageParam}` : ''}`),
    initialPageParam: '',
    getNextPageParam: (last) => last.next ?? undefined,
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const oneTitle = movieId || seriesId ? items[0]?.titleName : null;
  const filtered = events.length > 0 || !!params.get('q') || !!from || !!to || !!movieId || !!seriesId;

  return (
    <>
      <PageHeader
        title="History"
        meta={q.data && `${items.length}${q.hasNextPage ? '+' : ''} ${items.length === 1 && !q.hasNextPage ? (filtered ? 'thing matches' : 'thing so far') : filtered ? 'things match' : 'things so far'}`}
        info={<>Everything that happened to Marquee’s downloads, newest first: sent to qBittorrent, put in your library, upgraded, replaced by another copy, removed, and imports that didn’t work. Open a title to see its own History.</>}
      />
      <DownloadsTabs />
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          set('q', words.trim() || null);
        }}
      >
        <div role="group" aria-label="What happened" className="flex flex-wrap gap-1.5">
          <button
            type="button"
            aria-pressed={events.length === 0}
            onClick={() => set('event', null)}
            className={cx('h-11 rounded-full border px-4 text-sm font-medium', events.length === 0 ? 'border-amber bg-amber text-amber-ink' : 'border-line bg-panel text-soft hover:text-text')}
          >
            Everything
          </button>
          {HISTORY_KINDS.map(([k, label]) => (
            <button
              key={k}
              type="button"
              aria-pressed={events.includes(k)}
              onClick={() => toggle(k)}
              className={cx('h-11 rounded-full border px-4 text-sm font-medium', events.includes(k) ? 'border-amber bg-amber text-amber-ink' : 'border-line bg-panel text-soft hover:text-text')}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex min-w-[220px] flex-1 flex-col gap-1">
            <label htmlFor="h-words" className="text-sm text-muted">
              Title or copy name
            </label>
            <input
              id="h-words"
              type="search"
              value={words}
              onChange={(e) => setWords(e.target.value)}
              onBlur={() => set('q', words.trim() || null)}
              placeholder="Dune, FLUX, S02E03…"
              className="h-11 rounded-xl border border-line bg-panel px-4 text-sm text-text placeholder:text-dim focus:border-amber focus:outline-none"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="h-from" className="text-sm text-muted">
              From
            </label>
            <input id="h-from" type="date" value={from} max={to || undefined} onChange={(e) => set('from', e.target.value || null)} className="h-11 rounded-xl border border-line bg-panel px-3 text-sm text-text [color-scheme:dark] focus:border-amber focus:outline-none" />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="h-to" className="text-sm text-muted">
              To
            </label>
            <input id="h-to" type="date" value={to} min={from || undefined} onChange={(e) => set('to', e.target.value || null)} className="h-11 rounded-xl border border-line bg-panel px-3 text-sm text-text [color-scheme:dark] focus:border-amber focus:outline-none" />
          </div>
          <Button type="submit" variant="ghost" className="h-11">
            Find
          </Button>
        </div>
        {(movieId || seriesId) && (
          <p className="m-0 text-sm text-soft">
            Only {oneTitle ?? 'one title'}.{' '}
            <button type="button" className="min-h-11 font-medium text-amber" onClick={() => setParams(new URLSearchParams([...params].filter(([k]) => k !== 'movieId' && k !== 'seriesId')), { replace: true })}>
              Show every title
            </button>
          </p>
        )}
      </form>
      {q.error && <Notice tone="error">{q.error instanceof ApiFailure ? q.error.message : 'The History didn’t load. Reload the page to try again.'}</Notice>}
      {q.data &&
        (items.length === 0 ? (
          filtered ? (
            <p className="m-0 text-muted">Nothing matches that. Try “Everything”, or clear the dates and words.</p>
          ) : (
            <EmptyState title="Nothing has happened yet" action={{ to: '/library', label: 'Go to the library' }}>
              Every download Marquee sends, and what becomes of it, is kept here. Find a copy on a movie or show page and press “Download this”.
            </EmptyState>
          )
        ) : (
          <>
            <ol className="m-0 flex list-none flex-col p-0" aria-label="What happened, newest first">
              {items.map((i) => (
                <HistoryRow key={i.id} item={i} />
              ))}
            </ol>
            {q.hasNextPage && (
              <Button type="button" variant="ghost" className="self-start" disabled={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>
                {q.isFetchingNextPage ? 'Loading…' : 'Show older'}
              </Button>
            )}
          </>
        ))}
    </>
  );
}

/** Every copy turned down, for every title, with Remove from list. */
export function NeverPickPage() {
  const q = useNeverPick();
  const items = q.data?.items ?? [];
  return (
    <>
      <PageHeader
        title="Never pick"
        meta={q.data && `${items.length} ${items.length === 1 ? 'copy' : 'copies'}`}
        info={
          <>
            Copies Marquee turned down for a title (stuck, a fake, or you pressed Try another copy). Searches for that title skip them. <strong>Remove from list</strong> lets Marquee pick one again. Older apps call this the
            block list.
          </>
        }
      />
      <DownloadsTabs />
      {q.error && <Notice tone="error">{q.error instanceof ApiFailure ? q.error.message : 'The list didn’t load. Reload the page to try again.'}</Notice>}
      {q.data &&
        (items.length === 0 ? (
          <EmptyState title="No copies turned down">
            When a download is stuck too long or turns out to be fake, Marquee turns that copy down for the title and tries another. Those copies are listed here.
          </EmptyState>
        ) : (
          <NeverPickList items={items} showTitle />
        ))}
      <p className="m-0 text-sm text-dim">
        Each title’s own list is on its page too. <Link to="/downloads/history?event=replaced">See replaced copies in the History</Link>.
      </p>
    </>
  );
}
