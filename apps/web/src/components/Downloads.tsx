import { useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import type { DownloadActionResult, DownloadDetails, DownloadView, DownloadsView } from '@marquee/shared';
import { ApiFailure, api, queryClient } from '../api';
import { Poster, formatBytes } from './Poster';
import { Menu, MenuDivider, menuItemClass } from './Overlay';
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

  const pct = Math.floor(d.progress * 100);
  const details = [d.size !== null ? formatBytes(d.size) : null, d.quality, d.sourceName, d.adopted ? 'Sent by another app' : null].filter(Boolean).join(' · ');
  const small = (
    label: string,
    onClick: () => void,
  ) => (
    <Button type="button" variant="ghost" className="h-11 px-3.5 text-sm" disabled={busy} onClick={onClick}>
      {busy ? 'Working…' : label}
    </Button>
  );

  return (
    <li
      className={cx('relative isolate flex flex-col gap-3 overflow-hidden rounded-2xl border p-3 sm:p-4', active ? 'border-line-strong bg-raised' : 'border-line')}
      style={d.posterColor ? ({ '--tint': d.posterColor } as React.CSSProperties) : undefined}
    >
      {active && d.posterColor && <div aria-hidden="true" className="absolute inset-0 -z-10 bg-[radial-gradient(60%_120%_at_0%_50%,color-mix(in_oklab,var(--tint)_16%,transparent),transparent_70%)]" />}
      <div className="flex items-start gap-4">
        {showTitle && <Poster title={d.titleName} path={d.posterPath} color={d.posterColor} size="w185" className="w-12 flex-none rounded-lg sm:w-14 [&_span]:hidden" />}
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {showTitle &&
            (d.titleLink ? (
              <Link to={d.titleLink} className="text-heading font-semibold text-text no-underline hover:text-amber">
                {d.titleName}
              </Link>
            ) : (
              <span className="text-heading font-semibold">{d.titleName}</span>
            ))}
          <span className={cx('font-medium', TONE[d.status.tone])}>{d.status.label}</span>
          {d.status.detail && <span className="text-sm text-soft">{d.status.detail}</span>}
          {d.status.nextTryAt && <span className="text-sm text-muted">Marquee tries another copy {at(d.status.nextTryAt)} if it’s still stuck.</span>}
        </div>
        {active && <span className="pt-0.5 text-sm font-semibold text-soft tabular-nums">{pct}%</span>}
        {d.canControl && !confirmRemove && (
          <Menu label={`More for ${d.titleName}`} trigger={<span className="flex size-11 items-center justify-center text-xl leading-none text-muted">⋯</span>} className="-my-1.5 -mr-1.5 flex-none">
            {paused ? (
              <button type="button" role="menuitem" className={menuItemClass} onClick={() => act('resume')}>
                Resume
              </button>
            ) : (
              <button type="button" role="menuitem" className={menuItemClass} onClick={() => act('pause')}>
                Pause
              </button>
            )}
            <button type="button" role="menuitem" className={menuItemClass} onClick={() => act('try-another')}>
              Try another copy
            </button>
            <MenuDivider />
            <button type="button" role="menuitem" className={cx(menuItemClass, 'text-warn hover:text-warn')} onClick={() => setConfirmRemove(true)}>
              Remove…
            </button>
          </Menu>
        )}
      </div>
      {active && (
        <div className="h-1.5 overflow-hidden rounded-full bg-line" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Downloaded">
          <div className={cx('h-full transition-[width] duration-700 motion-reduce:transition-none', BAR[d.status.tone])} style={{ width: `${Math.max(2, d.progress * 100)}%` }} />
        </div>
      )}
      {(d.canImport || d.canRemoveShared || (d.canControl && paused)) && !confirmRemove && (
        <div className="flex flex-wrap gap-2">
          {d.canImport && small('Try again', () => act('import'))}
          {d.canRemoveShared && small('Remove from qBittorrent', () => act('remove', { deleteFiles: true }))}
          {d.canControl && paused && small('Resume', () => act('resume'))}
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
      <details className="text-sm">
        <summary className="flex min-h-11 cursor-pointer items-center text-muted hover:text-text">Details</summary>
        <div className="flex flex-col gap-1 pb-1">
          <span className="font-mono text-caption break-all text-dim">{d.title}</span>
          {details && <span className="text-label text-muted">{details}</span>}
          {d.importedPaths && d.importedPaths.length > 0 && (
            <ul className="m-0 flex list-none flex-col gap-0.5 p-0 font-mono text-caption break-all text-muted">
              {d.importedPaths.map((p) => (
                <li key={p}>→ {p}</li>
              ))}
            </ul>
          )}
        </div>
      </details>
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
  if (!q.data) return null;
  const items = q.data.items.slice(0, 5);
  return (
    <section aria-labelledby="title-downloads" className="flex flex-col gap-3 rounded-2xl border border-line bg-panel p-6">
      <h2 id="title-downloads" className="m-0 text-lg font-semibold">
        Downloads
      </h2>
      {items.length === 0 ? (
        <p className="m-0 text-sm text-muted">Nothing sent to qBittorrent for this yet. Pick a copy under Copies to download one.</p>
      ) : (
        <DownloadList view={{ ...q.data, items }} showTitle={!!filter.seriesId} />
      )}
    </section>
  );
}

// ---------------- The Downloads table ----------------

const rate = (bps: number | null) => (bps && bps > 0 ? `${formatBytes(bps)}/s` : '—');
function left(seconds: number | null): string {
  if (seconds === null) return '—';
  if (seconds < 90) return '1 min';
  const m = Math.round(seconds / 60);
  if (m < 90) return `${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} days`;
}
const span = (seconds: number | null) => (seconds === null || seconds <= 0 ? '—' : left(seconds));
const day = (ms: number | null) => (ms ? new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');
const shortDay = (ms: number) => {
  const d = new Date(ms);
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

/** A row's actions, the same ones a title page has. */
function useDownloadActions(d: DownloadView) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  async function act(path: string, body: object = {}) {
    setBusy(true);
    setNote(null);
    try {
      const r = await api<DownloadActionResult>(`/downloads/${d.id}/${path}`, { body });
      setNote({ ok: true, text: r.message });
      await queryClient.invalidateQueries({ queryKey: ['downloads'] });
      return true;
    } catch (e) {
      setNote({ ok: false, text: errMsg(e) });
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { busy, note, act };
}

function Fact({ label, children, wide }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className={cx('flex min-w-0 flex-col gap-0.5', wide && 'sm:col-span-2')}>
      <dt className="text-caption font-semibold tracking-[.08em] text-dim uppercase">{label}</dt>
      <dd className="m-0 text-sm text-soft [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

/** Everything qBittorrent says about one download, read live while it's open. */
function DownloadDetailsPanel({ d }: { d: DownloadView }) {
  const q = useQuery({ queryKey: ['downloads', 'details', d.id], queryFn: () => api<DownloadDetails>(`/downloads/${d.id}`), refetchInterval: 10_000 });
  const live = q.data?.live ?? null;
  const [allFiles, setAllFiles] = useState(false);
  const files = live?.files ?? [];
  return (
    <div className="flex min-w-0 flex-col gap-4 px-1 py-3">
      <div className="flex flex-col gap-1">
        <span className={cx('font-medium', TONE[d.status.tone])}>{d.status.label}</span>
        {d.status.detail && <span className="text-sm text-soft">{d.status.detail}</span>}
        {d.status.nextTryAt && <span className="text-sm text-muted">Marquee tries another copy {at(d.status.nextTryAt)} if it’s still stuck.</span>}
        {d.message && d.message !== d.status.detail && <span className="text-sm text-muted">{d.message}</span>}
      </div>
      <dl className="m-0 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
        <Fact label="Copy" wide>
          <span className="font-mono text-caption">{d.title}</span>
        </Fact>
        <Fact label="Quality">{[d.quality, d.profileName].filter(Boolean).join(' · ') || '—'}</Fact>
        <Fact label="Source">{d.sourceName ?? (d.adopted ? 'Sent by another app' : '—')}</Fact>
        <Fact label="Size">{live ? formatBytes(live.size) : d.size !== null ? formatBytes(d.size) : '—'}</Fact>
        <Fact label="Fetched">{live?.downloaded != null ? formatBytes(live.downloaded) : '—'}</Fact>
        <Fact label="Shared">{live?.uploaded != null ? `${formatBytes(live.uploaded)} · ${live.ratio.toFixed(2)}×` : d.ratio !== null ? `${d.ratio.toFixed(2)}×` : '—'}</Fact>
        <Fact label="Speed">
          ↓ {rate(live?.downloadSpeed ?? d.speed)} · ↑ {rate(live?.uploadSpeed ?? d.uploadSpeed)}
        </Fact>
        <Fact label="People sharing">{live ? `${live.seedsConnected} connected of ${live.seedsKnown}` : (d.seeds ?? '—')}</Fact>
        <Fact label="Others fetching">{live ? `${live.peersConnected} connected of ${live.peersKnown}` : (d.peers ?? '—')}</Fact>
        <Fact label="Added">{day(live?.addedAt ?? d.addedAt)}</Fact>
        <Fact label="Finished">{day(live?.completedAt ?? d.finishedAt)}</Fact>
        <Fact label="Running for">{span(live?.activeSeconds ?? null)}</Fact>
        <Fact label="Sharing for">{span(live?.seedingSeconds ?? null)}</Fact>
        {live && (
          <>
            <Fact label="Saved in" wide>
              <span className="font-mono text-caption">{live.contentPath || live.savePath}</span>
            </Fact>
            <Fact label="Category">{live.category ?? '—'}</Fact>
            <Fact label="Tracker">{live.tracker ?? '—'}</Fact>
          </>
        )}
        {d.importedPaths && d.importedPaths.length > 0 && (
          <Fact label="In your library as" wide>
            <span className="flex flex-col gap-0.5 font-mono text-caption">
              {d.importedPaths.map((p) => (
                <span key={p}>{p}</span>
              ))}
            </span>
          </Fact>
        )}
        <Fact label="Info-hash" wide>
          <span className="font-mono text-caption">{d.infoHash}</span>
        </Fact>
      </dl>
      {q.isLoading && <p className="m-0 text-sm text-muted">Asking qBittorrent…</p>}
      {q.data?.note && <p className="m-0 text-sm text-muted">{q.data.note}</p>}
      {files.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-caption font-semibold tracking-[.08em] text-dim uppercase">
            {files.length} {files.length === 1 ? 'file' : 'files'}
          </span>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {(allFiles ? files : files.slice(0, 6)).map((f) => (
              <li key={f.name} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 text-caption">
                <span className="truncate font-mono text-muted" title={f.name}>
                  {f.name}
                </span>
                <span className="text-dim tabular-nums">{formatBytes(f.size)}</span>
                <span className="w-10 text-right text-soft tabular-nums">{f.progress === null ? '' : `${Math.floor(f.progress * 100)}%`}</span>
              </li>
            ))}
          </ul>
          {files.length > 6 && (
            <button type="button" onClick={() => setAllFiles(!allFiles)} className="self-start min-h-11 text-sm font-medium text-amber">
              {allFiles ? 'Show fewer' : `Show all ${files.length}`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function TableRow({ d, open, onToggle, cols }: { d: DownloadView; open: boolean; onToggle: () => void; cols: number }) {
  const { busy, note, act } = useDownloadActions(d);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const active = d.state === 'sent' || d.state === 'downloading';
  const paused = d.status.label === 'Paused';
  const pct = Math.floor(d.progress * 100);
  const hasMenu = d.canControl || d.canImport || d.canRemoveShared;
  const td = 'px-2 py-2 align-middle';
  return (
    <>
      <tr className={cx('border-t border-line', open && 'bg-raised/60', !active && d.state !== 'done' && 'opacity-70')}>
        <td className={cx(td, 'pl-0')}>
          <button type="button" aria-expanded={open} onClick={onToggle} className="flex min-h-11 w-full min-w-0 items-center gap-3 text-left">
            <Poster title={d.titleName} path={d.posterPath} color={d.posterColor} size="w185" className="w-8 flex-none rounded [&_span]:hidden" />
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-semibold text-text">{d.titleName}</span>
              <span className="truncate font-mono text-caption text-dim" title={d.title}>
                {d.title}
              </span>
            </span>
            <span aria-hidden="true" className={cx('ml-auto flex-none text-dim transition-transform motion-reduce:transition-none', open && 'rotate-90')}>
              ›
            </span>
          </button>
        </td>
        <td className={td}>
          <span className={cx('line-clamp-2 text-sm font-medium', TONE[d.status.tone])} title={d.status.detail ?? undefined}>
            {d.status.label}
          </span>
          {/* Phones have no Done column, so the bar sits under the status. */}
          <div className="mt-1 h-1 overflow-hidden rounded-full bg-line sm:hidden" aria-hidden="true">
            <div className={cx('h-full', BAR[d.status.tone])} style={{ width: `${Math.max(2, pct)}%` }} />
          </div>
        </td>
        <td className={cx(td, 'hidden sm:table-cell')}>
          <div className="flex flex-col gap-1">
            <span className="text-caption text-soft tabular-nums">{pct}%</span>
            <div className="h-1 overflow-hidden rounded-full bg-line" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Downloaded">
              <div className={cx('h-full', BAR[d.status.tone])} style={{ width: `${Math.max(2, pct)}%` }} />
            </div>
          </div>
        </td>
        <td className={cx(td, 'hidden text-sm text-soft tabular-nums md:table-cell')}>{d.size !== null ? formatBytes(d.size) : '—'}</td>
        <td className={cx(td, 'hidden text-caption text-soft tabular-nums lg:table-cell')}>
          <span className="block">↓ {rate(d.speed)}</span>
          <span className="block text-dim">↑ {rate(d.uploadSpeed)}</span>
        </td>
        <td className={cx(td, 'hidden text-sm text-soft tabular-nums xl:table-cell')}>{left(d.eta)}</td>
        <td className={cx(td, 'hidden text-caption text-soft tabular-nums 2xl:table-cell')} title="People sharing the whole copy · others fetching it">
          {d.seeds ?? '—'} · {d.peers ?? '—'}
        </td>
        <td className={cx(td, 'hidden text-sm text-soft tabular-nums xl:table-cell')}>{d.ratio !== null ? `${d.ratio.toFixed(2)}×` : '—'}</td>
        <td className={cx(td, 'hidden text-caption text-soft 2xl:table-cell')}>
          <span className="block truncate">{d.quality ?? '—'}</span>
          <span className="block truncate text-dim">{d.sourceName ?? (d.adopted ? 'Another app' : '')}</span>
        </td>
        <td className={cx(td, 'hidden text-caption text-dim xl:table-cell')}>{shortDay(d.addedAt)}</td>
        <td className={cx(td, 'pr-0')}>
          {hasMenu && (
            <Menu label={`More for ${d.titleName}`} trigger={<span className="flex size-11 items-center justify-center text-xl leading-none text-muted">⋯</span>} className="w-11">
              {d.canControl &&
                (paused ? (
                  <button type="button" role="menuitem" className={menuItemClass} disabled={busy} onClick={() => act('resume')}>
                    Resume
                  </button>
                ) : (
                  <button type="button" role="menuitem" className={menuItemClass} disabled={busy} onClick={() => act('pause')}>
                    Pause
                  </button>
                ))}
              {d.canControl && (
                <button type="button" role="menuitem" className={menuItemClass} disabled={busy} onClick={() => act('try-another')}>
                  Try another copy
                </button>
              )}
              {d.canImport && (
                <button type="button" role="menuitem" className={menuItemClass} disabled={busy} onClick={() => act('import')}>
                  Put it in the library again
                </button>
              )}
              {d.canRemoveShared && (
                <button type="button" role="menuitem" className={menuItemClass} disabled={busy} onClick={() => act('remove', { deleteFiles: true })}>
                  Remove from qBittorrent (library file stays)
                </button>
              )}
              {d.titleLink && (
                <Link to={d.titleLink} role="menuitem" className={menuItemClass}>
                  Open the title’s page
                </Link>
              )}
              {d.canControl && (
                <>
                  <MenuDivider />
                  <button type="button" role="menuitem" className={cx(menuItemClass, 'text-warn hover:text-warn')} onClick={() => setConfirmRemove(true)}>
                    Remove…
                  </button>
                </>
              )}
            </Menu>
          )}
        </td>
      </tr>
      {(note || confirmRemove) && (
        <tr>
          <td colSpan={cols} className="px-2 pb-3">
            {note && (
              <p role="status" className={cx('m-0 text-sm', note.ok ? 'text-teal-hi' : 'text-warn')}>
                {note.text}
              </p>
            )}
            {confirmRemove && (
              <div role="alertdialog" aria-label="Remove this download?" className="mt-2 flex flex-col gap-2 rounded-xl border border-line-strong px-4 py-3 text-sm">
                <p className="m-0 text-soft">Remove it from qBittorrent? Marquee won’t try another copy; you can search again from the title’s page.</p>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" variant="danger" disabled={busy} onClick={async () => (await act('remove', { deleteFiles: true })) && setConfirmRemove(false)}>
                    Remove and delete its files
                  </Button>
                  <Button type="button" variant="ghost" disabled={busy} onClick={async () => (await act('remove', { deleteFiles: false })) && setConfirmRemove(false)}>
                    Remove, keep the files
                  </Button>
                  <Button type="button" variant="ghost" onClick={() => setConfirmRemove(false)}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </td>
        </tr>
      )}
      {open && (
        <tr className="bg-raised/60">
          <td colSpan={cols} className="px-2">
            <DownloadDetailsPanel d={d} />
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * Downloads as a dense table: one line each with what qBittorrent says
 * (state, progress, size, speeds, time left, people, how much it shared),
 * finished ones included. Open a row for everything else, read live.
 * Narrow screens drop the less important columns.
 */
export function DownloadTable({ items, caption }: { items: DownloadView[]; caption: string }) {
  const [open, setOpen] = useState<Set<number>>(new Set());
  // A row's opened part spans only the columns showing at this width; spanning
  // hidden ones too makes the browser add empty columns that squeeze the title.
  const head = useRef<HTMLTableRowElement>(null);
  const [cols, setCols] = useState(11);
  useLayoutEffect(() => {
    const count = () => setCols([...(head.current?.children ?? [])].filter((th) => getComputedStyle(th).display !== 'none').length || 11);
    count();
    window.addEventListener('resize', count);
    return () => window.removeEventListener('resize', count);
  }, []);
  const toggle = (id: number) => setOpen((s) => new Set(s.has(id) ? [...s].filter((x) => x !== id) : [...s, id]));
  const th = 'px-2 pb-2 text-left text-caption font-semibold tracking-[.08em] text-dim uppercase';
  return (
    <table className="w-full table-fixed border-collapse">
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr ref={head}>
          <th scope="col" className={cx(th, 'pl-0')}>
            Title
          </th>
          <th scope="col" className={cx(th, 'w-[130px] sm:w-[160px]')}>
            Status
          </th>
          <th scope="col" className={cx(th, 'hidden w-[88px] sm:table-cell')}>
            Done
          </th>
          <th scope="col" className={cx(th, 'hidden w-[76px] md:table-cell')}>
            Size
          </th>
          <th scope="col" className={cx(th, 'hidden w-[100px] lg:table-cell')}>
            Speed
          </th>
          <th scope="col" className={cx(th, 'hidden w-[64px] xl:table-cell')}>
            Left
          </th>
          <th scope="col" className={cx(th, 'hidden w-[84px] 2xl:table-cell')} title="People sharing the whole copy · others fetching it">
            People
          </th>
          <th scope="col" className={cx(th, 'hidden w-[64px] xl:table-cell')} title="How much it has shared, compared with its size">
            Shared
          </th>
          <th scope="col" className={cx(th, 'hidden w-[120px] 2xl:table-cell')}>
            Quality
          </th>
          <th scope="col" className={cx(th, 'hidden w-[72px] xl:table-cell')}>
            Added
          </th>
          <th scope="col" className={cx(th, 'w-11 pr-0')}>
            <span className="sr-only">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {items.map((d) => (
          <TableRow key={d.id} d={d} open={open.has(d.id)} onToggle={() => toggle(d.id)} cols={cols} />
        ))}
      </tbody>
    </table>
  );
}
