import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import type { DownloadActionResult, DownloadView, DownloadsView } from '@marquee/shared';
import { ApiFailure, api, queryClient } from '../api';
import { formatBytes } from './Poster';
import { Button, Notice, cx } from './ui';

/** Download rows with plain-English states and their buttons. Used by the Downloads page and title pages. */

const errMsg = (e: unknown) => (e instanceof ApiFailure ? e.message : 'Something went wrong.');

const TONE: Record<DownloadView['status']['tone'], string> = {
  good: 'text-teal-hi',
  busy: 'text-blue-hi',
  warn: 'text-amber-hi',
  bad: 'text-warn',
  done: 'text-teal',
  quiet: 'text-muted',
};
const BAR: Record<DownloadView['status']['tone'], string> = {
  good: 'bg-teal',
  busy: 'bg-blue',
  warn: 'bg-amber',
  bad: 'bg-warn',
  done: 'bg-teal',
  quiet: 'bg-dim',
};

function at(ms: number): string {
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? `at ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}` : `on ${d.toLocaleDateString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`;
}

export function useDownloads(filter?: { movieId?: number; seriesId?: number }) {
  const qs = filter?.movieId ? `?movieId=${filter.movieId}` : filter?.seriesId ? `?seriesId=${filter.seriesId}` : '';
  return useQuery({
    queryKey: ['downloads', qs],
    queryFn: () => api<DownloadsView>(`/downloads${qs}`),
    refetchInterval: 10_000,
  });
}

function DownloadRow({ d, showTitle }: { d: DownloadView; showTitle: boolean }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const active = d.state === 'sent' || d.state === 'downloading';
  const paused = d.status.label === 'Paused';

  async function act(path: string, body: object = {}) {
    setBusy(true);
    setNote(null);
    try {
      const r = await api<DownloadActionResult>(`/downloads/${d.id}/${path}`, { body });
      setNote({ ok: true, text: r.message });
      setConfirmRemove(false);
      await queryClient.invalidateQueries({ queryKey: ['downloads'] });
    } catch (e) {
      setNote({ ok: false, text: errMsg(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className={cx('flex flex-col gap-3 rounded-[14px] border px-5 py-4', active ? 'border-line-strong bg-raised' : 'border-line')}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {showTitle &&
            (d.titleLink ? (
              <Link to={d.titleLink} className="text-[17px] font-semibold text-text no-underline hover:text-amber">
                {d.titleName}
              </Link>
            ) : (
              <span className="text-[17px] font-semibold">{d.titleName}</span>
            ))}
          <span className={cx('font-medium', TONE[d.status.tone])}>{d.status.label}</span>
          {d.status.detail && <span className="text-sm text-soft">{d.status.detail}</span>}
          {d.status.nextTryAt && <span className="text-sm text-muted">Marquee tries another copy {at(d.status.nextTryAt)} if it’s still stuck.</span>}
          <span className="font-mono text-[12px] break-all text-dim">{d.title}</span>
          <span className="text-[13px] text-muted">
            {[d.size !== null ? formatBytes(d.size) : null, d.sourceName, d.adopted ? 'Sent by another app' : null].filter(Boolean).join(' · ')}
          </span>
        </div>
        {active && <span className="text-sm font-semibold text-soft">{Math.floor(d.progress * 100)}%</span>}
      </div>
      {active && (
        <div className="h-1.5 overflow-hidden rounded-full bg-line" role="progressbar" aria-valuenow={Math.floor(d.progress * 100)} aria-valuemin={0} aria-valuemax={100} aria-label="Downloaded">
          <div className={cx('h-full', BAR[d.status.tone])} style={{ width: `${Math.max(2, d.progress * 100)}%` }} />
        </div>
      )}
      {d.canControl && !confirmRemove && (
        <div className="flex flex-wrap gap-2">
          {paused ? (
            <Button type="button" variant="ghost" className="h-11 px-3.5 text-sm" disabled={busy} onClick={() => act('resume')}>
              Resume
            </Button>
          ) : (
            <Button type="button" variant="ghost" className="h-11 px-3.5 text-sm" disabled={busy} onClick={() => act('pause')}>
              Pause
            </Button>
          )}
          <Button type="button" variant="ghost" className="h-11 px-3.5 text-sm" disabled={busy} onClick={() => act('try-another')}>
            {busy ? 'Working…' : 'Try another copy'}
          </Button>
          <Button type="button" variant="ghost" className="h-11 px-3.5 text-sm" disabled={busy} onClick={() => setConfirmRemove(true)}>
            Remove
          </Button>
        </div>
      )}
      {confirmRemove && (
        <div role="alertdialog" aria-label="Remove this download?" className="flex flex-col gap-2 rounded-xl border border-line-strong px-4 py-3 text-sm">
          <p className="m-0 text-soft">Remove it from qBittorrent? Marquee won’t try another copy; you can search again from the title’s page.</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="danger" disabled={busy} onClick={() => act('remove', { deleteFiles: true })}>
              Remove and delete its files
            </Button>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => act('remove', { deleteFiles: false })}>
              Remove, keep the files
            </Button>
            <Button type="button" variant="ghost" onClick={() => setConfirmRemove(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {note && (
        <p role="status" className={cx('m-0 text-sm', note.ok ? 'text-teal-hi' : 'text-warn')}>
          {note.text}
        </p>
      )}
    </li>
  );
}

export function DownloadList({ view, showTitle = true }: { view: DownloadsView; showTitle?: boolean }) {
  return (
    <>
      {view.problem && (
        <Notice tone="error">
          qBittorrent: {view.problem.label}. {view.problem.fix} These may be out of date.
        </Notice>
      )}
      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {view.items.map((d) => (
          <DownloadRow key={d.id} d={d} showTitle={showTitle} />
        ))}
      </ul>
    </>
  );
}

/** A title page's downloads, shown only when it has some. */
export function TitleDownloads(filter: { movieId?: number; seriesId?: number }) {
  const q = useDownloads(filter);
  if (!q.data || q.data.items.length === 0) return null;
  const items = q.data.items.slice(0, 5);
  return (
    <section aria-labelledby="title-downloads" className="flex flex-col gap-3 rounded-2xl border border-line bg-panel p-6">
      <h2 id="title-downloads" className="m-0 text-lg font-semibold">
        Downloads
      </h2>
      <DownloadList view={{ ...q.data, items }} showTitle={!!filter.seriesId} />
    </section>
  );
}
