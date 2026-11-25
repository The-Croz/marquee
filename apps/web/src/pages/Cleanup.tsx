import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import type { CleanupDownloadsView, CleanupResult, CopyGroup, ReconcileTorrent, ReconcileView, SetAsideView, UntrackedFile } from '@marquee/shared';
import { api, ApiFailure, queryClient } from '../api';
import { EmptyState, PageHeader } from '../components/Page';
import { Sheet, useToast } from '../components/Overlay';
import { formatBytes } from '../components/Poster';
import { Button, Notice, cx } from '../components/ui';

/**
 * Library → Clean up: two copies of one title, the recycle bin (set-aside
 * files), downloads nobody uses, and library files with no title. Getting
 * rid of something only sets it aside; the recycle bin is where things are
 * deleted for good, by hand.
 */

type Tab = 'copies' | 'bin' | 'downloads' | 'untracked' | 'downloader';
const TABS: { key: Tab; label: string }[] = [
  { key: 'copies', label: 'Two copies' },
  { key: 'downloader', label: 'In qBittorrent' },
  { key: 'bin', label: 'Recycle bin' },
  { key: 'downloads', label: 'Unused downloads' },
  { key: 'untracked', label: 'No title' },
];

const errMsg = (e: unknown) => (e instanceof ApiFailure ? e.message : 'That didn’t work. Try again.');
const day = (ms: number | null) => (ms ? new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : null);
const CLEANUP = ['cleanup'];

/** Ticked paths, with Select all / Select none. */
function usePicks(initial: () => string[], deps: unknown[]) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setPicked(new Set(initial())), deps);
  const flip = (p: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(p)) n.delete(p);
      else n.add(p);
      return n;
    });
  return { picked, setPicked, flip };
}

function SelectBar({ all, picked, setPicked, children }: { all: string[]; picked: Set<string>; setPicked: (s: Set<string>) => void; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="ghost" onClick={() => setPicked(new Set(all))} disabled={!all.length}>
        Select all
      </Button>
      <Button variant="ghost" onClick={() => setPicked(new Set())} disabled={!picked.size}>
        Select none
      </Button>
      {children}
      <span className="text-label text-muted" aria-live="polite">
        {picked.size} of {all.length} ticked
      </span>
    </div>
  );
}

function Tick({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }) {
  return (
    <label className="flex size-11 flex-none cursor-pointer items-center justify-center">
      <input type="checkbox" checked={checked} onChange={onChange} aria-label={label} className="size-5 accent-amber" />
    </label>
  );
}

const Badge = ({ children, tone = 'quiet' }: { children: ReactNode; tone?: 'quiet' | 'good' | 'warn' }) => (
  <span className={cx('rounded-full px-2 py-0.5 text-caption', tone === 'good' ? 'bg-teal/15 text-teal' : tone === 'warn' ? 'bg-warn/15 text-warn' : 'bg-raised text-muted')}>{children}</span>
);

/** Runs an action, says what happened (and any problems), and refreshes every tab. */
function useAct() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function act(url: string, body: object): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const r = await api<CleanupResult>(url, { body });
      toast({ message: r.message });
      if (r.problems.length) setError(r.problems.join(' '));
      await queryClient.invalidateQueries({ queryKey: CLEANUP });
      await queryClient.invalidateQueries({ queryKey: ['replaced'] });
      return true;
    } catch (e) {
      setError(errMsg(e));
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { act, busy, error };
}

// ---------------------------------------------------------------- two copies

function Copies() {
  const q = useQuery({ queryKey: [...CLEANUP, 'copies'], queryFn: () => api<{ groups: CopyGroup[] }>('/cleanup/copies') });
  const groups = q.data?.groups ?? [];
  const all = groups.flatMap((g) => g.files.map((f) => f.path));
  // Every copy but the best one is ticked to start with.
  const { picked, setPicked, flip } = usePicks(() => groups.flatMap((g) => g.files.filter((f) => !f.best).map((f) => f.path)), [q.data]);
  const { act, busy, error } = useAct();
  const noneLeft = groups.filter((g) => g.files.every((f) => picked.has(f.path)));
  const bytes = groups.flatMap((g) => g.files).filter((f) => picked.has(f.path) && !f.shared).reduce((n, f) => n + f.sizeBytes, 0);
  if (q.isError) return <Notice tone="error">{errMsg(q.error)}</Notice>;
  if (!q.data) return <p className="text-muted">Looking…</p>;
  if (!groups.length) return <EmptyState title="No title has two copies">When a movie or an episode has more than one video file in your library, it shows up here.</EmptyState>;
  return (
    <div className="flex flex-col gap-4">
      <p className="m-0 max-w-[760px] text-sm text-soft">
        These movies and episodes have more than one video file. The copy Marquee would keep (sharpest picture, then what its profile likes best) is left unticked. Setting a copy aside moves it into the recycle bin, so Plex and Jellyfin stop showing it; nothing is deleted until you empty the bin.
      </p>
      <SelectBar all={all} picked={picked} setPicked={setPicked}>
        <Button variant="ghost" onClick={() => setPicked(new Set(groups.flatMap((g) => g.files.filter((f) => !f.best).map((f) => f.path))))}>
          Keep the best of each
        </Button>
      </SelectBar>
      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {groups.map((g) => (
          <li key={g.key} className="rounded-2xl border border-line bg-panel p-3">
            <div className="flex flex-wrap items-center justify-between gap-2 px-1 pb-1">
              <Link to={g.href} className="font-semibold text-text no-underline hover:underline">
                {g.title}
              </Link>
              {noneLeft.includes(g) && <Badge tone="warn">Untick one: a title keeps at least one copy</Badge>}
            </div>
            <ul className="m-0 flex list-none flex-col p-0">
              {g.files.map((f) => (
                <li key={f.path} className="flex items-start gap-1 border-t border-line py-1.5">
                  <Tick checked={picked.has(f.path)} onChange={() => flip(f.path)} label={`Set aside ${f.name}`} />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5 py-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-sm text-text">{f.quality ?? f.judged}</span>
                      {f.best && <Badge tone="good">Keep this one</Badge>}
                      {f.shared && <Badge>Shared with a download · frees space once that’s removed</Badge>}
                    </span>
                    <span className="font-mono text-xs break-all text-dim">
                      {f.folder}/{f.name}
                    </span>
                    <span className="text-caption text-muted">
                      {formatBytes(f.sizeBytes)} · {f.judged}
                      {f.addedAt ? ` · arrived ${day(f.addedAt)}` : ''}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="sticky bottom-0 flex flex-wrap items-center gap-3 border-t border-line bg-ink py-3">
        <Button disabled={busy || !picked.size || noneLeft.length > 0} onClick={() => void act('/cleanup/set-aside', { paths: [...picked] })}>
          {busy ? 'Setting aside…' : picked.size ? `Set aside ${picked.size} ${picked.size === 1 ? 'copy' : 'copies'}` : 'Set aside'}
        </Button>
        {picked.size > 0 && <span className="text-label text-muted">Gives back {formatBytes(bytes)} once you empty the recycle bin.</span>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- recycle bin

function Bin() {
  const q = useQuery({ queryKey: [...CLEANUP, 'bin'], queryFn: () => api<SetAsideView>('/cleanup/set-aside') });
  const items = q.data?.items ?? [];
  const all = items.map((i) => i.path);
  const { picked, setPicked, flip } = usePicks(() => [], [q.data]);
  const { act, busy, error } = useAct();
  const [confirm, setConfirm] = useState<'some' | 'all' | null>(null);
  const chosen = items.filter((i) => picked.has(i.path));
  const target = confirm === 'all' ? items : chosen;
  const frees = target.reduce((n, i) => n + i.freedBytes, 0);
  if (q.isError) return <Notice tone="error">{errMsg(q.error)}</Notice>;
  if (!q.data) return <p className="text-muted">Looking…</p>;
  return (
    <div className="flex flex-col gap-4">
      <p className="m-0 max-w-[760px] text-sm text-soft">
        What upgrades replaced and what you set aside here waits in hidden <span className="font-mono text-xs">.marquee-replaced</span> folders, in case you want it back. Plex and Jellyfin don’t look there. Marquee never empties it by itself.
      </p>
      {!items.length ? (
        <EmptyState title="The recycle bin is empty">Files you set aside, and files upgrades replace, wait here until you delete them.</EmptyState>
      ) : (
        <>
          <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
            <span className="text-heading font-semibold tabular-nums">{formatBytes(q.data.bytes)}</span>
            <span className="text-sm text-muted">
              {items.length} {items.length === 1 ? 'file' : 'files'} · deleting everything gives back {formatBytes(q.data.freedBytes)}
            </span>
            <Button variant="danger" onClick={() => setConfirm('all')}>
              Empty the recycle bin…
            </Button>
          </div>
          <SelectBar all={all} picked={picked} setPicked={setPicked} />
          <ul className="m-0 flex list-none flex-col p-0">
            {items.map((i) => (
              <li key={i.path} className="flex items-start gap-1 border-t border-line py-1.5">
                <Tick checked={picked.has(i.path)} onChange={() => flip(i.path)} label={`Choose ${i.name}`} />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5 py-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-sm break-all text-text">{i.name}</span>
                    {i.title && (
                      <Link to={i.title.href} className="text-label text-amber">
                        {i.title.name}
                      </Link>
                    )}
                    {i.freedBytes === 0 && <Badge>Shared with a download · frees nothing yet</Badge>}
                    {!i.canPutBack && <Badge tone="warn">Something else is where it was</Badge>}
                  </span>
                  <span className="font-mono text-xs break-all text-dim">
                    {i.rootLabel} · {i.originalFolder === '.' ? 'the folder itself' : i.originalFolder}
                  </span>
                  <span className="text-caption text-muted">
                    {formatBytes(i.sizeBytes)} · set aside {day(i.setAsideAt)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
          {error && <Notice tone="error">{error}</Notice>}
          <div className="sticky bottom-0 flex flex-wrap items-center gap-3 border-t border-line bg-ink py-3">
            <Button variant="ghost" disabled={busy || !chosen.length || !chosen.some((i) => i.canPutBack)} onClick={() => void act('/cleanup/put-back', { paths: chosen.filter((i) => i.canPutBack).map((i) => i.path) })}>
              Put {chosen.length || ''} back
            </Button>
            <Button variant="danger" disabled={busy || !chosen.length} onClick={() => setConfirm('some')}>
              Delete {chosen.length || ''} for good…
            </Button>
          </div>
        </>
      )}
      <Sheet open={!!confirm} onClose={() => setConfirm(null)} title={confirm === 'all' ? 'Empty the recycle bin?' : `Delete ${target.length} for good?`}>
        <div className="flex flex-col gap-4 pt-1 pb-2">
          <p className="m-0 text-sm text-soft">
            This deletes {target.length} {target.length === 1 ? 'file' : 'files'} ({formatBytes(target.reduce((n, i) => n + i.sizeBytes, 0))}) and gives back {formatBytes(frees)}:
          </p>
          <ul className="m-0 flex max-h-60 list-none flex-col gap-1 overflow-y-auto p-0 font-mono text-xs break-all text-muted">
            {target.map((i) => (
              <li key={i.path}>{i.path}</li>
            ))}
          </ul>
          <p className="m-0 text-sm text-warn">It can’t be undone. Files in your library aren’t touched.</p>
          {error && <Notice tone="error">{error}</Notice>}
          <div className="flex flex-wrap gap-3">
            <Button
              variant="danger"
              disabled={busy}
              onClick={async () => {
                const ok = confirm === 'all' ? await act('/cleanup/delete', { paths: items.map((i) => i.path), confirm: true }) : await act('/cleanup/delete', { paths: chosen.map((i) => i.path), confirm: true });
                if (ok) {
                  setConfirm(null);
                  setPicked(new Set());
                }
              }}
            >
              {busy ? 'Deleting…' : `Delete ${target.length} ${target.length === 1 ? 'file' : 'files'}`}
            </Button>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Keep them
            </Button>
          </div>
        </div>
      </Sheet>
    </div>
  );
}

// ---------------------------------------------------------------- downloads nobody uses

function Downloads() {
  const q = useQuery({ queryKey: [...CLEANUP, 'downloads'], queryFn: () => api<CleanupDownloadsView>('/cleanup/downloads') });
  const items = q.data?.items ?? [];
  const { picked, setPicked, flip } = usePicks(() => [], [q.data]);
  const { act, busy, error } = useAct();
  const frees = items.filter((i) => picked.has(i.path)).reduce((n, i) => n + i.freedBytes, 0);
  if (q.isError) return <Notice tone="error">{errMsg(q.error)}</Notice>;
  if (!q.data) return <p className="text-muted">Asking qBittorrent what it uses…</p>;
  return (
    <div className="flex flex-col gap-4">
      <p className="m-0 max-w-[760px] text-sm text-soft">
        Things in <span className="font-mono text-xs">{q.data.folder}</span> that no torrent in qBittorrent points at, in any category (so Radarr’s and Sonarr’s count as in use). Often left behind when a torrent was removed without its files. Setting one aside moves it into the downloads folder’s own recycle bin.
      </p>
      {!q.data.ok && <Notice tone="error">{q.data.problem}</Notice>}
      {q.data.ok && !items.length && <EmptyState title="Every download is in use">Nothing in the downloads folder is left over.</EmptyState>}
      {items.length > 0 && (
        <>
          <SelectBar all={items.map((i) => i.path)} picked={picked} setPicked={setPicked}>
            <Button variant="ghost" onClick={() => setPicked(new Set(items.filter((i) => !i.inLibrary).map((i) => i.path)))}>
              Only what takes room
            </Button>
          </SelectBar>
          <ul className="m-0 flex list-none flex-col p-0">
            {items.map((i) => (
              <li key={i.path} className="flex items-start gap-1 border-t border-line py-1.5">
                <Tick checked={picked.has(i.path)} onChange={() => flip(i.path)} label={`Set aside ${i.name}`} />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5 py-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-sm break-all text-text">{i.name}</span>
                    {i.inLibrary ? <Badge>Also in your library · frees nothing</Badge> : <Badge tone="warn">Takes {formatBytes(i.freedBytes)}</Badge>}
                  </span>
                  <span className="font-mono text-xs break-all text-dim">{i.folder === '.' ? 'In the downloads folder itself' : i.folder}</span>
                  <span className="text-caption text-muted">
                    {i.isFolder ? `A folder of ${i.files} ${i.files === 1 ? 'file' : 'files'}` : 'A file'} · {formatBytes(i.sizeBytes)} · last changed {day(i.modifiedAt)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
          {error && <Notice tone="error">{error}</Notice>}
          <div className="sticky bottom-0 flex flex-wrap items-center gap-3 border-t border-line bg-ink py-3">
            <Button disabled={busy || !picked.size} onClick={() => void act('/cleanup/set-aside', { paths: [...picked] })}>
              {busy ? 'Setting aside…' : picked.size ? `Set aside ${picked.size}` : 'Set aside'}
            </Button>
            {picked.size > 0 && <span className="text-label text-muted">Gives back {formatBytes(frees)} once you empty the recycle bin.</span>}
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- library files with no title

function Untracked() {
  const q = useQuery({ queryKey: [...CLEANUP, 'untracked'], queryFn: () => api<{ files: UntrackedFile[] }>('/cleanup/untracked') });
  const files = q.data?.files ?? [];
  const { picked, setPicked, flip } = usePicks(() => [], [q.data]);
  const { act, busy, error } = useAct();
  if (q.isError) return <Notice tone="error">{errMsg(q.error)}</Notice>;
  if (!q.data) return <p className="text-muted">Looking…</p>;
  return (
    <div className="flex flex-col gap-4">
      <p className="m-0 max-w-[760px] text-sm text-soft">Video files in your movie and TV folders that Marquee doesn’t count as any title’s, and why. Sort them out where the link points, or set them aside.</p>
      {!files.length && <EmptyState title="Every file belongs to a title">Video files Marquee can’t place show up here.</EmptyState>}
      {files.length > 0 && (
        <>
          <SelectBar all={files.map((f) => f.path)} picked={picked} setPicked={setPicked} />
          <ul className="m-0 flex list-none flex-col p-0">
            {files.map((f) => (
              <li key={f.path} className="flex items-start gap-1 border-t border-line py-1.5">
                <Tick checked={picked.has(f.path)} onChange={() => flip(f.path)} label={`Set aside ${f.name}`} />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5 py-1">
                  <span className="text-sm break-all text-text">{f.name}</span>
                  <span className="font-mono text-xs break-all text-dim">
                    {f.root === 'movies' ? 'Movies' : 'TV'} · {f.folder === '.' ? 'the library folder itself' : f.folder}
                  </span>
                  <span className="text-caption text-muted">
                    {f.reason}{' '}
                    {f.href && (
                      <Link to={f.href} className="text-amber">
                        Sort it out
                      </Link>
                    )}
                  </span>
                  <span className="text-caption text-dim">
                    {formatBytes(f.sizeBytes)}
                    {f.shared ? ' · shared with a download' : ''}
                  </span>
                </span>
              </li>
            ))}
          </ul>
          {error && <Notice tone="error">{error}</Notice>}
          <div className="sticky bottom-0 flex flex-wrap items-center gap-3 border-t border-line bg-ink py-3">
            <Button disabled={busy || !picked.size} onClick={() => void act('/cleanup/set-aside', { paths: [...picked] })}>
              {busy ? 'Setting aside…' : picked.size ? `Set aside ${picked.size}` : 'Set aside'}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- in qBittorrent

/** Groups that are open to start with: the ones with something to do. */
const ACT_ON = new Set(['missing', 'stuck', 'orphan', 'done']);

function InQbittorrent() {
  const [fresh, setFresh] = useState(0);
  const q = useQuery({ queryKey: [...CLEANUP, 'downloader', fresh], queryFn: () => api<ReconcileView>(`/cleanup/downloader${fresh ? '?fresh=1' : ''}`) });
  const v = q.data;
  const all = v?.groups.flatMap((g) => g.items) ?? [];
  const { picked, setPicked, flip } = usePicks(() => [], [v]);
  const [confirm, setConfirm] = useState<'with' | 'without' | null>(null);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosen = all.filter((i) => picked.has(i.hash));
  const frees = chosen.reduce((n, i) => n + i.freedBytes, 0);
  const libraryFolder = chosen.some((i) => i.inLibraryFolder);
  async function remove(deleteFiles: boolean) {
    setBusy(true);
    setError(null);
    try {
      const r = await api<CleanupResult>('/cleanup/downloader/remove', { body: { hashes: chosen.map((i) => i.hash), deleteFiles, confirm: true } });
      toast({ message: r.message });
      if (r.problems.length) setError(r.problems.join(' '));
      setConfirm(null);
      setFresh((n) => n + 1);
      await queryClient.invalidateQueries({ queryKey: ['downloads'] });
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }
  if (q.isError) return <Notice tone="error">{errMsg(q.error)}</Notice>;
  if (!v) return <p className="text-muted">Asking qBittorrent about every torrent… with a few hundred this takes a few seconds.</p>;
  return (
    <div className="flex flex-col gap-4">
      <p className="m-0 max-w-[760px] text-sm text-soft">
        Every torrent in qBittorrent, in every category (yours, Radarr’s and Sonarr’s), and whether it still earns its place. A torrent feeds a title when one of its files is the same file as the library’s (a hardlink). Nothing here is removed by itself.
      </p>
      {!v.ok && <Notice tone="error">{v.problem}</Notice>}
      {v.ok && (
        <>
          <div className="flex flex-wrap items-center gap-3 text-sm text-muted">
            <span>
              {v.total} {v.total === 1 ? 'torrent' : 'torrents'} · checked {new Date(v.checkedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
            </span>
            <Button variant="ghost" disabled={q.isFetching} onClick={() => setFresh((n) => n + 1)}>
              {q.isFetching ? 'Checking…' : 'Check again'}
            </Button>
          </div>
          <SelectBar all={all.map((i) => i.hash)} picked={picked} setPicked={setPicked}>
            <Button variant="ghost" onClick={() => setPicked(new Set(v.groups.find((g) => g.key === 'orphan')!.items.map((i) => i.hash)))}>
              All not in your library
            </Button>
            <Button variant="ghost" onClick={() => setPicked(new Set(v.groups.find((g) => g.key === 'done')!.items.map((i) => i.hash)))}>
              All done sharing
            </Button>
          </SelectBar>
          {v.groups.map((g) => (
            <details key={g.key} open={ACT_ON.has(g.key) && g.items.length > 0} className="rounded-2xl border border-line bg-panel">
              <summary className="flex min-h-12 cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2">
                <span className="font-semibold text-text">{g.label}</span>
                <span className="text-sm text-muted tabular-nums">{g.items.length}</span>
                {g.freedBytes > 0 && <span className="text-sm text-warn">removing frees {formatBytes(g.freedBytes)}</span>}
              </summary>
              <p className="m-0 border-t border-line px-4 py-2 text-caption text-muted">{g.explain}</p>
              {g.items.length > 0 && (
                <ul className="m-0 flex list-none flex-col p-0 px-2">
                  {g.items.map((i) => (
                    <TorrentRow key={i.hash} i={i} picked={picked.has(i.hash)} onFlip={() => flip(i.hash)} />
                  ))}
                </ul>
              )}
            </details>
          ))}
          {error && <Notice tone="error">{error}</Notice>}
          <div className="sticky bottom-0 flex flex-wrap items-center gap-3 border-t border-line bg-ink py-3">
            <Button variant="danger" disabled={busy || !chosen.length || libraryFolder} onClick={() => setConfirm('with')}>
              {chosen.length ? `Remove ${chosen.length} with files…` : 'Remove with files…'}
            </Button>
            <Button variant="ghost" disabled={busy || !chosen.length} onClick={() => setConfirm('without')}>
              {chosen.length ? `Remove ${chosen.length}, keep files…` : 'Remove, keep files…'}
            </Button>
            {chosen.length > 0 && <span className="text-label text-muted">With files gives back {formatBytes(frees)}.</span>}
            {libraryFolder && <span className="text-label text-warn">One you picked is saved inside your library folder: remove it keeping its files.</span>}
          </div>
        </>
      )}
      <Sheet open={!!confirm} onClose={() => setConfirm(null)} title={confirm === 'with' ? `Remove ${chosen.length} with their files?` : `Remove ${chosen.length} from qBittorrent?`}>
        <div className="flex flex-col gap-4 pt-1 pb-2">
          <p className="m-0 text-sm text-soft">
            {confirm === 'with'
              ? `qBittorrent removes these and deletes their files, giving back about ${formatBytes(frees)}. Library copies stay (they’re their own hardlinks).`
              : 'qBittorrent stops sharing these; their files stay where they are (they then show under Unused downloads).'}
          </p>
          <ul className="m-0 flex max-h-60 list-none flex-col gap-1 overflow-y-auto p-0 text-xs break-all text-muted">
            {chosen.map((i) => (
              <li key={i.hash}>
                {i.name} <span className="text-dim">· {i.sentBy}{i.isPrivate ? ' · private site' : ''}</span>
              </li>
            ))}
          </ul>
          {chosen.some((i) => i.isPrivate && i.group !== 'done') && <p className="m-0 text-sm text-warn">Some are from private sites and haven’t met a sharing rule: removing them early can count against your account there.</p>}
          {confirm === 'with' && <p className="m-0 text-sm text-warn">Deleting can’t be undone.</p>}
          {error && <Notice tone="error">{error}</Notice>}
          <div className="flex flex-wrap gap-3">
            <Button variant="danger" disabled={busy} onClick={() => void remove(confirm === 'with')}>
              {busy ? 'Removing…' : `Remove ${chosen.length}`}
            </Button>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Keep them
            </Button>
          </div>
        </div>
      </Sheet>
    </div>
  );
}

function TorrentRow({ i, picked, onFlip }: { i: ReconcileTorrent; picked: boolean; onFlip: () => void }) {
  const pct = Math.floor(i.progress * 100);
  return (
    <li className="flex items-start gap-1 border-t border-line py-1.5">
      <Tick checked={picked} onChange={onFlip} label={`Choose ${i.name}`} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 py-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-sm break-all text-text">{i.name}</span>
          <Badge>{i.sentBy}</Badge>
          {i.isPrivate && <Badge tone="warn">Private site</Badge>}
          {i.feeds && (
            <Link to={i.feeds.href} className="text-label text-amber">
              {i.feeds.name}
            </Link>
          )}
        </span>
        <span className="text-caption text-muted">
          {i.status}
          {pct < 100 ? ` · ${pct}%` : ''} · {formatBytes(i.sizeBytes)} · ratio {i.ratio.toFixed(2)}
          {i.sharingDays ? ` · shared ${i.sharingDays} ${i.sharingDays === 1 ? 'day' : 'days'}` : ''}
          {i.group === 'done' || i.group === 'sharing' ? ` · rule: ${i.rule}` : ''}
        </span>
        <span className="text-caption text-dim">
          {i.freedBytes ? `Removing with files frees ${formatBytes(i.freedBytes)}` : 'Removing frees nothing (its files are also in your library, or gone)'}
          {i.inLibraryFolder ? ' · saved inside your library folder' : ''}
        </span>
      </span>
    </li>
  );
}

export function CleanupPage() {
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find((t) => t.key === params.get('tab'))?.key ?? 'copies') as Tab;
  const body = useMemo(() => ({ copies: <Copies />, bin: <Bin />, downloads: <Downloads />, untracked: <Untracked />, downloader: <InQbittorrent /> })[tab], [tab]);
  return (
    <>
      <PageHeader
        title="Clean up"
        back={{ to: '/library', label: 'Library' }}
        info="Finds what takes room for nothing: titles with two copies, downloads nobody uses, and files that belong to no title. Getting rid of something only sets it aside in the recycle bin, which you can undo; deleting for good happens in the recycle bin, by hand."
      />
      <div role="tablist" aria-label="What to clean up" className="mb-5 flex max-w-[760px] flex-wrap rounded-xl border border-line bg-panel p-1">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setParams({ tab: t.key }, { replace: true })}
            className={cx('h-11 min-w-[120px] flex-1 rounded-lg px-3 text-sm', tab === t.key ? 'bg-raised font-semibold text-text' : 'font-medium text-muted')}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" aria-label={TABS.find((t) => t.key === tab)!.label}>
        {body}
      </div>
    </>
  );
}
