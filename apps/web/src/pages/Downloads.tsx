import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { DownloadView } from '@marquee/shared';
import { ApiFailure, useAuthStatus } from '../api';
import { DEFAULT_COLUMNS, DOWNLOAD_COLUMNS, DownloadTable, sortDownloads, sourceOf, useDownloads, type DownloadColumnKey, type DownloadSortKey } from '../components/Downloads';
import { Menu } from '../components/Overlay';
import { formatBytes } from '../components/Poster';
import { Notice, cx } from '../components/ui';
import { Chips, PageHeader, Tabs } from '../components/Page';

/**
 * Downloads: everything Marquee sent to qBittorrent (or follows for another
 * app), on the way or finished, as one dense table. Open a row for the rest
 * of what qBittorrent knows about it.
 */

const SHOW = [
  ['all', 'Everything'],
  ['now', 'On the way'],
  ['done', 'Finished'],
  ['trouble', 'Needs a look'],
] as const;
type Show = (typeof SHOW)[number][0];

const onTheWay = (d: DownloadView) => d.state === 'sent' || d.state === 'downloading';
// Finished but not in the library needs a look, unless Marquee is busy with it (putting it there, or unpacking it).
const trouble = (d: DownloadView) => d.status.tone === 'bad' || d.status.tone === 'warn' || (d.canImport && d.status.tone !== 'busy');
const matches = (d: DownloadView, show: Show) =>
  show === 'all' ? true : show === 'now' ? onTheWay(d) : show === 'done' ? d.state === 'done' : trouble(d);

/** Downloads, History and Never pick: three views of the same downloads. Admins see all three. */
export function DownloadsTabs() {
  const admin = useAuthStatus().data?.user?.role === 'admin';
  if (!admin) return null;
  return (
    <Tabs
      label="Downloads views"
      items={[
        { value: 'now', label: 'Downloads', to: '/downloads' },
        { value: 'history', label: 'History', to: '/downloads/history' },
        { value: 'never', label: 'Never pick', to: '/downloads/never-pick' },
      ]}
    />
  );
}

const COLUMNS_KEY = 'marquee.downloads.columns';
const SORT_KEY = 'marquee.downloads.sort';
const read = <T,>(key: string, fallback: T): T => {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
};
const keep = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Not remembering is fine.
  }
};

export function DownloadsPage() {
  const q = useDownloads();
  const v = q.data;
  const [show, setShow] = useState<Show>('all');
  const [filter, setFilter] = useState('');
  const [source, setSource] = useState('any');
  // Which columns show, and the sort, are remembered on this device.
  const [columns, setColumns] = useState<DownloadColumnKey[]>(() => read(COLUMNS_KEY, DEFAULT_COLUMNS).filter((k) => DOWNLOAD_COLUMNS.some((c) => c.key === k)));
  const [sort, setSort] = useState<{ key: DownloadSortKey; dir: 'asc' | 'desc' } | null>(() => read(SORT_KEY, null));
  useEffect(() => keep(COLUMNS_KEY, columns), [columns]);
  useEffect(() => keep(SORT_KEY, sort), [sort]);
  // Removed downloads live in History, not here.
  const items = (v?.items ?? []).filter((d) => d.state !== 'removed');
  const sources = [...new Set(items.map(sourceOf))].sort((a, b) => a.localeCompare(b));
  const onSort = (key: DownloadSortKey) =>
    setSort((cur) => (cur?.key !== key ? { key, dir: key === 'title' || key === 'status' || key === 'source' || key === 'quality' ? 'asc' : 'desc' } : cur.dir === 'desc' ? { key, dir: 'asc' } : cur.dir === 'asc' && key !== 'title' ? null : { key, dir: 'desc' }));
  const now = items.filter(onTheWay);
  const down = now.reduce((n, d) => n + (d.speed ?? 0), 0);
  const up = items.reduce((n, d) => n + (d.uploadSpeed ?? 0), 0);
  const words = filter.trim().toLowerCase();
  const picked = items.filter((d) => matches(d, show) && (source === 'any' || sourceOf(d) === source) && (!words || `${d.titleName} ${d.title}`.toLowerCase().includes(words)));
  // Chosen sort, or on the way first, then newest first.
  const shown = (sort ? sortDownloads(picked, sort.key, sort.dir) : picked.sort((a, b) => Number(onTheWay(b)) - Number(onTheWay(a)) || b.addedAt - a.addedAt)).slice(0, 200);
  const count = (s: Show) => items.filter((d) => matches(d, s)).length;

  return (
    <>
      <PageHeader
        title="Downloads"
        meta={
          v && (
            <>
              {now.length} on the way
              {down > 0 && ` · ↓ ${formatBytes(down)}/s`}
              {up > 0 && ` · ↑ ${formatBytes(up)}/s`}
            </>
          )
        }
        info={
          <>
            Marquee checks qBittorrent every minute, and every 10 seconds while this page is open. When a download is stuck too long or turns out to be fake, it tries another copy by itself. Change the times in{' '}
            <Link to="/settings/downloader">Settings → Downloader</Link>.
          </>
        }
      />
      <DownloadsTabs />
      {q.error && <Notice tone="error">{q.error instanceof ApiFailure ? q.error.message : 'Downloads didn’t load. It tries again by itself every 10 seconds.'}</Notice>}
      {v?.problem && (
        <Notice tone="error">
          qBittorrent: {v.problem.label}. {v.problem.fix} What’s below may be out of date.
        </Notice>
      )}
      {v && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Chips label="Show" value={show} onChange={setShow} items={SHOW.map(([k, label]) => ({ value: k, label, count: count(k) }))} />
            <label htmlFor="dl-filter" className="sr-only">
              Filter downloads
            </label>
            <input
              id="dl-filter"
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter by title or copy name"
              className="ml-auto h-11 w-full rounded-xl border border-line bg-panel px-4 text-sm text-text placeholder:text-dim focus:border-amber focus:outline-none sm:w-[280px]"
            />
            <label htmlFor="dl-source" className="sr-only">
              Source
            </label>
            <select id="dl-source" value={source} onChange={(e) => setSource(e.target.value)} className="h-11 min-w-0 flex-1 rounded-xl border border-line bg-panel px-3 text-sm text-text sm:flex-none">
              <option value="any">Every Source</option>
              {sources.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <Menu
              label="Columns to show"
              className="max-sm:hidden"
              trigger={<span className="flex h-11 items-center rounded-xl border border-line bg-panel px-3.5 text-sm font-medium text-soft">Columns</span>}
            >
              {DOWNLOAD_COLUMNS.map((c) => {
                const on = columns.includes(c.key);
                return (
                  <button
                    key={c.key}
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={on}
                    onClick={() => setColumns((cur) => (on ? cur.filter((k) => k !== c.key) : DOWNLOAD_COLUMNS.map((x) => x.key).filter((k) => k === c.key || cur.includes(k))))}
                    className="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-sm text-soft hover:bg-raised hover:text-text focus-visible:bg-raised"
                  >
                    <span aria-hidden="true" className={cx('flex size-5 items-center justify-center rounded border text-xs', on ? 'border-amber bg-amber text-amber-ink' : 'border-line-strong')}>
                      {on ? '✓' : ''}
                    </span>
                    {c.label}
                  </button>
                );
              })}
              <button type="button" role="menuitem" onClick={() => (setColumns(DEFAULT_COLUMNS), setSort(null))} className="flex min-h-11 w-full items-center rounded-lg px-3 text-left text-sm text-amber hover:bg-raised">
                Back to the usual
              </button>
            </Menu>
          </div>
          {items.length === 0 ? (
            <p className="m-0 text-muted">Nothing downloading yet. Find a copy on a movie or show page and press “Download this”.</p>
          ) : shown.length === 0 ? (
            <p className="m-0 text-muted">Nothing matches that. Try “Everything” and Every Source, or clear the filter.</p>
          ) : (
            <DownloadTable items={shown} caption="Downloads" columns={columns} sort={sort} onSort={onSort} />
          )}
        </>
      )}
    </>
  );
}
