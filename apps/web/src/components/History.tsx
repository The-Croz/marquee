import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import type { HistoryItem, NeverPickItem, NeverPickView } from '@marquee/shared';
import { api, ApiFailure, queryClient } from '../api';
import { formatBytes } from './Poster';
import { Button, cx } from './ui';

/**
 * What happened to downloads (the History page and a title's History) and
 * the copies turned down for a title (Never pick), with Remove from list.
 */

export const HISTORY_KINDS = [
  ['sent', 'Sent'],
  ['in_library', 'In your library'],
  ['upgraded', 'Upgraded'],
  ['replaced', 'Replaced'],
  ['removed', 'Removed'],
  ['import_failed', 'Couldn’t put in library'],
  ['allowed_again', 'Taken off Never pick'],
  ['renamed', 'Renamed'],
  ['title_removed', 'Removed from Marquee'],
] as const;

export const when = (ms: number) => new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

const DOT: Record<HistoryItem['tone'], string> = { good: 'bg-teal', bad: 'bg-warn', quiet: 'bg-line-strong', busy: 'bg-blue' };

/** "WEBDL-1080p · 6.2 GB · from TPB", for a sent copy. */
export function copyFacts(i: Pick<HistoryItem, 'quality' | 'size' | 'source'>): string | null {
  return [i.quality, i.size ? formatBytes(i.size) : null, i.source ? `from ${i.source}` : null].filter(Boolean).join(' · ') || null;
}

/** One row of the History page. */
export function HistoryRow({ item }: { item: HistoryItem }) {
  const facts = item.event === 'sent' ? copyFacts(item) : null;
  return (
    <li className="relative flex flex-col gap-1 border-b border-line py-3 pl-5 last:border-b-0">
      <span aria-hidden="true" className={cx('absolute top-[21px] left-0 size-2 rounded-full', DOT[item.tone])} />
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className={cx('font-medium', item.tone === 'bad' ? 'text-warn' : item.tone === 'good' ? 'text-teal-hi' : 'text-soft')}>{item.label}</span>
        {item.titleLink ? (
          <Link to={item.titleLink} className="font-semibold text-text no-underline hover:text-amber">
            {item.titleName}
          </Link>
        ) : (
          <span className="font-semibold text-text">
            {item.titleName} <span className="text-sm font-normal text-dim">(no longer in your library)</span>
          </span>
        )}
        <time dateTime={new Date(item.at).toISOString()} className="ml-auto text-sm text-dim tabular-nums">
          {when(item.at)}
        </time>
      </div>
      {item.copy && <span className="font-mono text-caption break-all text-muted">{item.copy}</span>}
      {(item.detail || facts || item.who) && (
        <span className="text-sm text-soft">
          {[item.detail, facts, item.who ? `by ${item.who}` : null].filter(Boolean).join(' · ')}
        </span>
      )}
    </li>
  );
}

export function useNeverPick(filter?: { movieId?: number; seriesId?: number }) {
  const qs = filter?.movieId ? `?movieId=${filter.movieId}` : filter?.seriesId ? `?seriesId=${filter.seriesId}` : '';
  return useQuery({ queryKey: ['never-pick', qs], queryFn: () => api<NeverPickView>(`/never-pick${qs}`) });
}

/** Copies turned down, each with why, when, and Remove from list. */
export function NeverPickList({ items, showTitle }: { items: NeverPickItem[]; showTitle: boolean }) {
  return (
    <ul className="m-0 flex list-none flex-col p-0">
      {items.map((i) => (
        <NeverPickRow key={i.id} item={i} showTitle={showTitle} />
      ))}
    </ul>
  );
}

function NeverPickRow({ item, showTitle }: { item: NeverPickItem; showTitle: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await api(`/never-pick/${item.id}`, { method: 'DELETE' });
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['never-pick'] }), queryClient.invalidateQueries({ queryKey: ['history'] })]);
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : 'That didn’t work. Try again in a moment.');
      setBusy(false);
    }
  }
  return (
    <li className="flex flex-wrap items-start gap-x-4 gap-y-2 border-b border-line py-3 last:border-b-0">
      <div className="flex min-w-0 flex-1 basis-[320px] flex-col gap-1">
        {showTitle &&
          (item.titleLink ? (
            <Link to={item.titleLink} className="font-semibold text-text no-underline hover:text-amber">
              {item.titleName}
            </Link>
          ) : (
            <span className="font-semibold">{item.titleName}</span>
          ))}
        <span className="font-mono text-caption break-all text-soft">{item.copy}</span>
        <span className="text-sm text-muted">
          {item.reason} <span className="text-dim">· {when(item.at)}</span>
        </span>
        {error && (
          <span role="alert" className="text-sm text-warn">
            {error}
          </span>
        )}
      </div>
      <Button type="button" variant="ghost" className="h-11 px-3.5 text-sm" disabled={busy} onClick={remove} aria-label={`Remove ${item.copy} from the Never pick list`}>
        {busy ? 'Removing…' : 'Remove from list'}
      </Button>
    </li>
  );
}
