import { useState } from 'react';
import { Link } from 'react-router';
import type { DownloadView } from '@marquee/shared';
import { ApiFailure } from '../api';
import { DownloadTable, useDownloads } from '../components/Downloads';
import { formatBytes } from '../components/Poster';
import { Notice, cx } from '../components/ui';
import { PageHeader } from '../components/Page';

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
const trouble = (d: DownloadView) => d.status.tone === 'bad' || d.status.tone === 'warn' || d.canImport;
const matches = (d: DownloadView, show: Show) =>
  show === 'all' ? true : show === 'now' ? onTheWay(d) : show === 'done' ? d.state === 'done' : trouble(d);

export function DownloadsPage() {
  const q = useDownloads();
  const v = q.data;
  const [show, setShow] = useState<Show>('all');
  const [filter, setFilter] = useState('');
  const items = v?.items ?? [];
  const now = items.filter(onTheWay);
  const down = now.reduce((n, d) => n + (d.speed ?? 0), 0);
  const up = items.reduce((n, d) => n + (d.uploadSpeed ?? 0), 0);
  const words = filter.trim().toLowerCase();
  const shown = items
    .filter((d) => matches(d, show) && (!words || `${d.titleName} ${d.title}`.toLowerCase().includes(words)))
    // On the way first, then newest first.
    .sort((a, b) => Number(onTheWay(b)) - Number(onTheWay(a)) || b.addedAt - a.addedAt)
    .slice(0, 150);
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
      {q.error && <Notice tone="error">{q.error instanceof ApiFailure ? q.error.message : 'Downloads didn’t load. It tries again by itself every 10 seconds.'}</Notice>}
      {v?.problem && (
        <Notice tone="error">
          qBittorrent: {v.problem.label}. {v.problem.fix} What’s below may be out of date.
        </Notice>
      )}
      {v && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <div role="group" aria-label="Show" className="flex flex-wrap gap-1.5">
              {SHOW.map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  aria-pressed={show === k}
                  onClick={() => setShow(k)}
                  className={cx('h-11 rounded-full border px-4 text-sm font-medium', show === k ? 'border-amber bg-amber text-amber-ink' : 'border-line bg-panel text-soft hover:text-text')}
                >
                  {label} <span className={cx('tabular-nums', show === k ? 'text-amber-ink/70' : 'text-dim')}>{count(k)}</span>
                </button>
              ))}
            </div>
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
          </div>
          {items.length === 0 ? (
            <p className="m-0 text-muted">Nothing downloading yet. Find a copy on a movie or show page and press “Download this”.</p>
          ) : shown.length === 0 ? (
            <p className="m-0 text-muted">Nothing matches that. Try “Everything”, or clear the filter.</p>
          ) : (
            <DownloadTable items={shown} caption="Downloads" />
          )}
        </>
      )}
    </>
  );
}
