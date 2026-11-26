import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import type { RemovalPreview, RemovalResult, RenamePlanView, RenameResult, RenameRunView, RenameTitlePlan } from '@marquee/shared';
import { api, ApiFailure, queryClient } from '../api';
import { Menu, Sheet, menuItemClass, useToast } from './Overlay';
import { formatBytes } from './Poster';
import { Button, Notice, cx } from './ui';

/**
 * Looking after a title or the whole library by hand: Remove from Marquee
 * (files stay unless you choose otherwise), Rename files to Marquee's names
 * (always previewed, undo after), and Refresh from TMDB.
 */

const errText = (e: unknown, fallback: string) => (e instanceof ApiFailure ? e.message : fallback);
const base = (p: string) => p.split('/').at(-1) ?? p;
const when = (ms: number) => new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** Everything that shows library data, after a change on disk. */
export async function refreshAfterCare() {
  await Promise.all(['library', 'history', 'downloads', 'discover', 'home', 'unmatched'].map((k) => queryClient.invalidateQueries({ queryKey: [k] })));
}

// ---------------- The title page's tools ----------------

export function TitleTools({ kind, id, title, onReport }: { kind: 'movie' | 'series'; id: number; title: string; onReport?: () => void }) {
  const [open, setOpen] = useState<'remove' | 'rename' | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const path = kind === 'movie' ? 'movies' : 'shows';
  async function refresh() {
    setBusy(true);
    try {
      const r = await api<{ message: string }>(`/${path}/${id}/refresh`, { body: {} });
      await refreshAfterCare();
      toast({ message: r.message });
    } catch (e) {
      toast({ message: errText(e, 'TMDB didn’t answer. Try again in a minute.'), tone: 'error' });
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {/* Up: the title page's hero clips anything that hangs below it. */}
      <Menu
        label={`More for ${title}`}
        placement="up"
        trigger={
          <span className="inline-flex h-12 items-center gap-2 rounded-full border border-white/30 px-5 text-body font-semibold text-text hover:bg-white/10">
            {busy ? 'Refreshing…' : 'More'}
            <span aria-hidden="true" className="text-lg leading-none">
              ⋯
            </span>
          </span>
        }
      >
        {onReport && (
          <button type="button" role="menuitem" className={menuItemClass} onClick={onReport}>
            Something wrong? Report a problem…
          </button>
        )}
        <button type="button" role="menuitem" className={menuItemClass} disabled={busy} onClick={() => void refresh()}>
          Refresh from TMDB
        </button>
        <button type="button" role="menuitem" className={menuItemClass} onClick={() => setOpen('rename')}>
          Rename files to Marquee’s names…
        </button>
        <button type="button" role="menuitem" className={cx(menuItemClass, 'text-warn hover:text-warn focus-visible:text-warn')} onClick={() => setOpen('remove')}>
          Remove from Marquee…
        </button>
      </Menu>
      <RemoveSheet open={open === 'remove'} onClose={() => setOpen(null)} kind={kind} id={id} title={title} />
      <RenameSheet open={open === 'rename'} onClose={() => setOpen(null)} kind={kind === 'movie' ? 'movie' : 'tv'} id={id} title={title} />
    </>
  );
}

// ---------------- Remove ----------------

function RemoveSheet({ open, onClose, kind, id, title }: { open: boolean; onClose: () => void; kind: 'movie' | 'series'; id: number; title: string }) {
  return (
    <Sheet open={open} onClose={onClose} title={`Remove ${title} from Marquee?`}>
      {open && <RemoveForm kind={kind} id={id} onClose={onClose} />}
    </Sheet>
  );
}

function RemoveForm({ kind, id, onClose }: { kind: 'movie' | 'series'; id: number; onClose: () => void }) {
  const path = kind === 'movie' ? 'movies' : 'shows';
  const noun = kind === 'movie' ? 'movie' : 'show';
  const q = useQuery({ queryKey: ['removal', kind, id], queryFn: () => api<RemovalPreview>(`/${path}/${id}/removal`), gcTime: 0 });
  const [leaveOut, setLeaveOut] = useState(false);
  const [onTheWay, setOnTheWay] = useState<'remove' | 'leave'>('remove');
  const [deleteFiles, setDeleteFiles] = useState(false);
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const toast = useToast();
  const p = q.data;

  async function remove() {
    if (!p) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<RemovalResult>(`/${path}/${id}/remove`, { body: { leaveOut, onTheWay, ...(deleteFiles ? { deleteFiles: p.files.map((f) => f.path) } : {}) } });
      await refreshAfterCare();
      onClose();
      navigate(kind === 'movie' ? '/library/movies' : '/library/shows', { replace: true });
      toast({ message: r.problems.length ? `${r.message} ${r.problems.join(' ')}` : r.message, tone: r.problems.length ? 'error' : 'info' });
    } catch (e) {
      setError(errText(e, 'That didn’t work. Try again.'));
      setBusy(false);
      if (e instanceof ApiFailure && e.code === 'files_changed') void q.refetch();
    }
  }

  if (q.isError) return <Notice tone="error">{errText(q.error, 'Couldn’t load what’s on disk.')}</Notice>;
  if (!p) return <p className="text-muted">Looking at what’s on disk…</p>;
  return (
    <div className="flex flex-col gap-5 pt-1 pb-2">
      <p className="m-0 text-sm text-soft">
        Marquee forgets this {noun}: it leaves the Library, stops being looked for, and its History stays. <strong className="font-semibold text-text">Your files stay on disk</strong> unless you choose below.
      </p>

      {p.onTheWay.length > 0 && (
        <fieldset className="m-0 flex flex-col gap-1 rounded-xl border border-line p-4">
          <legend className="px-1 text-sm font-semibold">{p.onTheWay.length === 1 ? 'A download is on its way' : `${p.onTheWay.length} downloads are on their way`}</legend>
          <ul className="m-0 mb-2 flex list-none flex-col gap-1 p-0 text-sm text-muted">
            {p.onTheWay.map((d) => (
              <li key={d.id} className="break-words">
                {d.copy} <span className="text-dim">· {d.status}</span>
              </li>
            ))}
          </ul>
          <label className="flex min-h-11 items-center gap-3 text-sm">
            <input type="radio" name="otw" className="size-5 accent-amber" checked={onTheWay === 'remove'} onChange={() => setOnTheWay('remove')} />
            Stop {p.onTheWay.length === 1 ? 'it' : 'them'} and remove from qBittorrent, with what’s downloaded so far
          </label>
          <label className="flex min-h-11 items-center gap-3 text-sm">
            <input type="radio" name="otw" className="size-5 accent-amber" checked={onTheWay === 'leave'} onChange={() => setOnTheWay('leave')} />
            Leave {p.onTheWay.length === 1 ? 'it' : 'them'} in qBittorrent; Marquee just stops following
          </label>
        </fieldset>
      )}
      {p.sharing > 0 && <p className="m-0 text-sm text-muted">{p.sharing === 1 ? 'One finished download is' : `${p.sharing} finished downloads are`} still sharing in qBittorrent. {p.sharing === 1 ? 'It carries' : 'They carry'} on until the seeding rule is met.</p>}
      {p.requests.length > 0 && <p className="m-0 text-sm text-muted">Asked for by {p.requests.join(', ')}. The request is taken away, so it can be asked for again.</p>}

      <label className="flex min-h-11 items-start gap-3 text-sm">
        <input type="checkbox" className="mt-0.5 size-5 flex-none accent-amber" checked={leaveOut} onChange={(e) => setLeaveOut(e.target.checked)} />
        <span>
          <span className="font-medium text-text">Don’t add it back when scanning</span>
          <span className="block text-muted">Library scans skip its folder. You can let it back in from Library → More → Left out of scans.</span>
        </span>
      </label>

      {p.files.length > 0 ? (
        <div className={cx('flex flex-col gap-3 rounded-xl border p-4', deleteFiles ? 'border-warn/60 bg-warn/6' : 'border-line')}>
          <label className="flex min-h-11 items-start gap-3 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 size-5 flex-none accent-amber"
              checked={deleteFiles}
              onChange={(e) => {
                setDeleteFiles(e.target.checked);
                setSure(false);
              }}
            />
            <span>
              <span className="font-medium text-text">Also delete its files</span>
              <span className="block text-muted">
                {p.files.length} {p.files.length === 1 ? 'file' : 'files'}, {formatBytes(p.totalBytes)}
              </span>
            </span>
          </label>
          {deleteFiles && (
            <>
              <ul aria-label="Files that will be deleted" className="m-0 flex max-h-56 list-none flex-col gap-1 overflow-y-auto rounded-lg bg-ink/60 p-3 font-mono text-xs break-all text-soft">
                {p.files.map((f) => (
                  <li key={f.path}>
                    {f.path} <span className="text-dim">({formatBytes(f.sizeBytes)})</span>
                  </li>
                ))}
              </ul>
              <p className="m-0 text-sm text-warn">Deleting can’t be undone. Only these files go; the folder goes too if nothing else is left in it. Plex and Jellyfin are told.</p>
              <label className="flex min-h-11 items-center gap-3 text-sm font-medium">
                <input type="checkbox" className="size-5 accent-amber" checked={sure} onChange={(e) => setSure(e.target.checked)} />
                I understand these files are gone for good
              </label>
            </>
          )}
        </div>
      ) : (
        <p className="m-0 text-sm text-muted">Marquee doesn’t know of any files for it, so nothing on disk changes.</p>
      )}

      {error && <Notice tone="error">{error}</Notice>}
      <div className="flex flex-wrap gap-3">
        <Button type="button" variant="danger" disabled={busy || (deleteFiles && !sure)} onClick={() => void remove()}>
          {busy ? 'Removing…' : deleteFiles ? `Remove and delete ${p.files.length} ${p.files.length === 1 ? 'file' : 'files'}` : 'Remove from Marquee'}
        </Button>
        <Button type="button" variant="ghost" onClick={onClose}>
          Keep it
        </Button>
      </div>
    </div>
  );
}

// ---------------- Rename ----------------

/** The preview of a rename (one title or a whole library), Rename, and the earlier runs with Undo. */
export function RenameSheet({ open, onClose, kind, id, title }: { open: boolean; onClose: () => void; kind: 'movie' | 'tv'; id?: number; title?: string }) {
  return (
    <Sheet open={open} onClose={onClose} title={title ? `Rename ${title}’s files` : `Rename every ${kind === 'movie' ? 'movie' : 'show'}’s files`} className="sm:w-[min(820px,calc(100vw-48px))]">
      {open && <RenamePreview kind={kind} id={id} onClose={onClose} />}
    </Sheet>
  );
}

function RenamePreview({ kind, id, onClose }: { kind: 'movie' | 'tv'; id?: number; onClose: () => void }) {
  const q = useQuery({ queryKey: ['rename', kind, id ?? 'all'], queryFn: () => api<RenamePlanView>(`/library/rename?${new URLSearchParams({ kind, ...(id ? { id: String(id) } : {}) })}`), gcTime: 0 });
  const [left, setLeft] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const plan = q.data;
  const doable = plan?.titles.filter((t) => t.moves.length > 0) ?? [];
  const picked = doable.filter((t) => !left.has(t.id));
  const files = picked.reduce((n, t) => n + t.moves.length, 0);

  async function rename() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<RenameResult>('/library/rename', { body: { kind, ...(id ? { id } : {}), moves: picked.flatMap((t) => t.moves.map(({ from, to }) => ({ from, to }))) } });
      await refreshAfterCare();
      await queryClient.invalidateQueries({ queryKey: ['renames'] });
      onClose();
      const run = r.run;
      toast({
        message: r.problems.length ? `${r.message} ${r.problems.length} couldn’t be moved: ${r.problems[0]}` : r.message,
        tone: r.problems.length ? 'error' : 'info',
        ...(run ? { undo: () => api(`/library/renames/${run.id}/undo`, { body: {} }).then(refreshAfterCare) } : {}),
      });
    } catch (e) {
      setError(errText(e, 'That didn’t work. Try again.'));
      setBusy(false);
      if (e instanceof ApiFailure && e.code === 'plan_changed') void q.refetch();
    }
  }

  if (q.isError) return <Notice tone="error">{errText(q.error, 'Couldn’t work out the new names.')}</Notice>;
  if (!plan) return <p className="text-muted">Working out the new names…</p>;
  return (
    <div className="flex flex-col gap-4 pt-1 pb-2">
      <p className="m-0 text-sm text-soft">
        Nothing has moved yet. This is every change, old name above new. Files move on the same disk (no copying), subtitles are renamed to match, and everything else in a renamed folder comes along. Plex and Jellyfin are told afterwards, and you can undo it.
      </p>
      <p className="m-0 font-mono text-xs break-all text-dim">Pattern: {plan.pattern}</p>
      {plan.titles.length === 0 ? (
        <Notice tone="success">{plan.alreadyRight ? `Every file already has Marquee’s name (${plan.alreadyRight}).` : 'There are no files to rename.'}</Notice>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {plan.titles.map((t) => (
            <RenameTitle key={t.id} t={t} single={!!id} on={!left.has(t.id)} toggle={() => setLeft((s) => new Set(s.has(t.id) ? [...s].filter((x) => x !== t.id) : [...s, t.id]))} />
          ))}
        </ul>
      )}
      {plan.alreadyRight > 0 && plan.titles.length > 0 && <p className="m-0 text-sm text-muted">{plan.alreadyRight} other {plan.alreadyRight === 1 ? 'file already has' : 'files already have'} Marquee’s name.</p>}
      {error && <Notice tone="error">{error}</Notice>}
      <div className="sticky bottom-[calc(-1*max(20px,env(safe-area-inset-bottom)))] pb-[max(20px,env(safe-area-inset-bottom))] -mx-5 flex flex-wrap items-center gap-3 border-t border-line bg-panel px-5 pt-3">
        <Button type="button" disabled={busy || files === 0} onClick={() => void rename()}>
          {busy ? 'Renaming…' : `Rename ${files} ${files === 1 ? 'file' : 'files'}`}
        </Button>
        <Button type="button" variant="ghost" onClick={onClose}>
          Not now
        </Button>
      </div>
      <EarlierRenames kind={kind} />
    </div>
  );
}

function RenameTitle({ t, single, on, toggle }: { t: RenameTitlePlan; single: boolean; on: boolean; toggle: () => void }) {
  const rel = (p: string) => (t.folderTo && p.startsWith(`${t.folderTo}/`) ? p.slice(t.folderTo.length + 1) : t.folderFrom && p.startsWith(`${t.folderFrom}/`) ? p.slice(t.folderFrom.length + 1) : base(p));
  const folderChanges = t.folderFrom !== t.folderTo && t.folderTo;
  const shown = t.moves.filter((m) => m.what !== 'other');
  const others = t.moves.length - shown.length;
  return (
    <li className={cx('rounded-xl border border-line bg-ink/40 p-3', !on && 'opacity-60')}>
      <div className="flex items-center gap-3">
        {!single && t.moves.length > 0 && <input type="checkbox" aria-label={`Rename ${t.title}`} className="size-5 flex-none accent-amber" checked={on} onChange={toggle} />}
        <span className="flex-1 font-semibold">{t.title}</span>
        <span className="text-xs text-dim">
          {t.moves.length} {t.moves.length === 1 ? 'change' : 'changes'}
        </span>
      </div>
      {folderChanges && (
        <p className="m-0 mt-2 text-xs break-all">
          <span className="text-dim">Folder </span>
          <span className="text-muted line-through decoration-dim">{base(t.folderFrom ?? '')}</span>
          <span className="text-dim"> → </span>
          <span className="text-teal-hi">{base(t.folderTo!)}</span>
        </p>
      )}
      {shown.length > 0 && (
        <ul className="m-0 mt-2 flex list-none flex-col gap-2 p-0">
          {shown.map((m) => (
            <li key={m.from} className="flex flex-col gap-0.5 font-mono text-xs break-all">
              <span className="text-muted">{t.folderFrom && m.from.startsWith(`${t.folderFrom}/`) ? m.from.slice(t.folderFrom.length + 1) : base(m.from)}</span>
              <span className="text-teal-hi">→ {rel(m.to)}</span>
            </li>
          ))}
        </ul>
      )}
      {others > 0 && <p className="m-0 mt-2 text-xs text-dim">and {others} other {others === 1 ? 'file' : 'files'} in the folder (posters, extras) come along with the same names</p>}
      {t.skipped.map((s) => (
        <p key={s.path} className="m-0 mt-2 text-xs text-warn">
          {base(s.path)}: {s.reason}
        </p>
      ))}
    </li>
  );
}

function EarlierRenames({ kind }: { kind: 'movie' | 'tv' }) {
  const q = useQuery({ queryKey: ['renames', kind], queryFn: () => api<{ items: RenameRunView[] }>(`/library/renames?kind=${kind}`) });
  const [error, setError] = useState<string | null>(null);
  const runs = q.data?.items ?? [];
  if (!runs.length) return null;
  async function undo(r: RenameRunView) {
    setError(null);
    try {
      await api<RenameResult>(`/library/renames/${r.id}/undo`, { body: {} });
      await refreshAfterCare();
      await q.refetch();
    } catch (e) {
      setError(errText(e, 'That couldn’t be undone.'));
    }
  }
  return (
    <details className="rounded-xl border border-line px-4 py-2">
      <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium text-soft">Earlier renames</summary>
      <ul className="m-0 flex list-none flex-col p-0 pb-2">
        {runs.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-x-3 border-t border-line py-2 text-sm">
            <span className="flex-1">
              {r.label} <span className="text-dim">· {r.files} {r.files === 1 ? 'file' : 'files'} · {when(r.at)}{r.who ? ` · ${r.who}` : ''}</span>
            </span>
            {r.undoneAt ? (
              <span className="text-xs text-dim">Undone {when(r.undoneAt)}</span>
            ) : (
              <Button type="button" variant="ghost" className="h-11 px-3 text-sm" onClick={() => void undo(r)}>
                Undo
              </Button>
            )}
          </li>
        ))}
      </ul>
      {error && <Notice tone="error">{error}</Notice>}
    </details>
  );
}
