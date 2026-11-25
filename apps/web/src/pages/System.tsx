import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import type { BackupKind, BackupView, BackupsView, ConnectionView, DiskSettingsView, DiskView, HealthView, JobView, LogLevel, LogsView, ReplacedView, RestoreResult } from '@marquee/shared';
import { ApiFailure, api, queryClient, refreshAuth } from '../api';
import { Button, Card, Field, Notice, Progress, cx } from '../components/ui';
import { Chips, EmptyState, StatusDot } from '../components/Page';
import { Sheet } from '../components/Overlay';

/** Settings → Health, Backups and Logs: running Marquee safely. Admin only. */

const errMsg = (e: unknown) => (e instanceof ApiFailure ? e.message : 'Marquee couldn’t do that. Try again in a moment.');

function ago(ms: number, now = Date.now()): string {
  const s = Math.round((now - ms) / 1000);
  if (s < 0) return inTime(ms, now);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

function inTime(ms: number, now = Date.now()): string {
  const s = Math.round((ms - now) / 1000);
  if (s <= 30) return 'any moment';
  const m = Math.round(s / 60);
  if (m < 60) return `in ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `in ${h} h`;
  return `in ${Math.round(h / 24)} days`;
}

const when = (ms: number) => new Date(ms).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

function size(bytes: number): string {
  const GB = 1024 ** 3;
  if (bytes >= 1024 * GB) return `${(bytes / (1024 * GB)).toFixed(1)} TB`;
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function SectionTitle({ children, aside }: { children: string; aside?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h2 className="m-0 text-heading font-semibold">{children}</h2>
      {aside}
    </div>
  );
}

// ---------------- Health ----------------

const HEALTH = ['system', 'health'];

export function HealthPage() {
  const q = useQuery({
    queryKey: HEALTH,
    queryFn: () => api<HealthView>('/system/health'),
    // Keep it fresh while a job is running.
    refetchInterval: (query) => (query.state.data?.jobs.some((j) => j.running) ? 3000 : 60_000),
  });
  if (q.isPending) return <p className="text-muted">Checking everything…</p>;
  if (q.isError) return <Notice tone="error">{errMsg(q.error)}</Notice>;
  const h = q.data;

  return (
    <div className="flex max-w-[860px] flex-col gap-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="m-0 flex items-center gap-2 text-body">
          <StatusDot tone={h.problems ? 'problem' : 'ok'} />
          {h.problems ? `${h.problems} ${h.problems === 1 ? 'thing needs' : 'things need'} you` : 'Everything’s working'}
          <span className="text-sm text-dim">· checked {ago(h.checkedAt)}</span>
        </p>
        <Button variant="ghost" onClick={() => void q.refetch()} disabled={q.isFetching}>
          {q.isFetching ? 'Checking…' : 'Check again'}
        </Button>
      </div>
      <Connections rows={h.connections} />
      <Disks disks={h.disks} settings={h.disk} />
      <Replaced />
      <Jobs jobs={h.jobs} />
    </div>
  );
}

function Connections({ rows }: { rows: ConnectionView[] }) {
  const groups = [...new Set(rows.map((r) => r.group))];
  return (
    <section aria-labelledby="h-connections" className="flex flex-col gap-3">
      <h2 id="h-connections" className="m-0 text-heading font-semibold">
        Connections
      </h2>
      {groups.map((g) => (
        <div key={g} className="flex flex-col gap-1">
          <h3 className="m-0 text-caption font-semibold tracking-widest text-dim uppercase">{g}</h3>
          <ul className="m-0 flex list-none flex-col overflow-hidden rounded-2xl border border-line bg-panel p-0">
            {rows
              .filter((r) => r.group === g)
              .map((r) => (
                <li key={r.key} className="flex flex-wrap items-start gap-x-4 gap-y-1 border-line px-4 py-3 not-last:border-b">
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex items-center gap-2">
                      <StatusDot tone={r.tone} />
                      <span className="font-semibold">{r.name}</span>
                      <span className={cx('text-sm', r.tone === 'problem' ? 'text-warn' : r.tone === 'attention' ? 'text-amber' : 'text-muted')}>{r.state}</span>
                    </span>
                    {r.fix && <span className="text-sm text-soft">{r.fix}</span>}
                    {r.detail && <span className="text-xs break-words text-dim">It said: {r.detail}</span>}
                  </div>
                  {r.tone !== 'ok' && (
                    <Link to={r.to} className="inline-flex min-h-11 items-center text-sm font-medium">
                      {r.tone === 'off' ? 'Set up' : 'Fix'} →
                    </Link>
                  )}
                </li>
              ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

function Disks({ disks, settings }: { disks: DiskView[]; settings: DiskSettingsView }) {
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const folder = String(f.get('downloadsFolder') ?? '').trim();
    const min = String(f.get('minFreeGb') ?? '').trim();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await api<DiskSettingsView>('/system/disk', { method: 'PUT', body: { downloadsFolder: folder || null, minFreeGb: min === '' ? null : Number(min) } });
      await queryClient.invalidateQueries({ queryKey: HEALTH });
      setSaved(true);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="h-disks" className="flex flex-col gap-3">
      <SectionTitle aside={<span className="text-sm text-muted">Marquee keeps {settings.minFreeGb} GB free on each</span>}>Free space</SectionTitle>
      <div className="grid gap-3 sm:grid-cols-3">
        {disks.map((d) => {
          const used = d.free !== null && d.total ? Math.round(((d.total - d.free) / d.total) * 100) : null;
          return (
            <Card key={d.key} className="flex flex-col gap-2 p-4" aria-label={`${d.label} folder`}>
              <span className="flex items-center gap-2 font-semibold">
                <StatusDot tone={d.tone} />
                {d.label}
              </span>
              <span className="font-mono text-xs break-all text-dim">{d.path}</span>
              {used !== null && <Progress value={used} color={d.tone === 'problem' ? 'bg-warn' : 'bg-teal'} />}
              <span className={cx('text-sm', d.tone === 'problem' ? 'text-warn' : 'text-soft')}>
                {d.state}
                {d.total ? ` of ${size(d.total)}` : ''}
              </span>
              {d.fix && <span className="text-sm text-muted">{d.fix}</span>}
            </Card>
          );
        })}
      </div>
      <details className="rounded-xl border border-line px-4 py-3">
        <summary className="cursor-pointer text-sm font-medium text-soft">For experts</summary>
        <form onSubmit={save} className="mt-4 flex flex-col gap-4">
          <Field
            label="Downloads folder"
            name="downloadsFolder"
            id="disk-downloads"
            defaultValue={settings.downloadsFolderSet ? settings.downloadsFolder : ''}
            placeholder={settings.downloadsFolder}
            hint="Where qBittorrent’s downloads are, as Marquee sees it. Leave empty to use the downloader’s folder pair, or /data/torrents."
          />
          <Field
            label="Keep at least this much free (GB)"
            name="minFreeGb"
            id="disk-min"
            type="number"
            min={0}
            step={1}
            defaultValue={settings.minFreeGb}
            hint={`Marquee won’t send a new download, or copy one into the library, if that would leave less than this. Hardlinks take no space, so they still go ahead. 0 turns this off. The default is ${settings.defaultMinFreeGb} GB.`}
          />
          {error && <Notice tone="error">{error}</Notice>}
          {saved && <Notice tone="success">Saved.</Notice>}
          <div>
            <Button type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </form>
      </details>
    </section>
  );
}

/** The files upgrades set aside in .marquee-replaced: how much room they take, and Empty behind a confirm. Never emptied by itself. */
function Replaced() {
  const q = useQuery({ queryKey: ['replaced'], queryFn: () => api<ReplacedView>('/system/replaced') });
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const v = q.data;
  async function empty() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ message: string; problems: string[]; view: ReplacedView }>('/system/replaced/empty', { body: { confirm: true } });
      queryClient.setQueryData(['replaced'], r.view);
      await queryClient.invalidateQueries({ queryKey: HEALTH });
      setDone([r.message, ...r.problems].join(' '));
      setConfirming(false);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-labelledby="h-replaced" className="flex flex-col gap-3">
      <SectionTitle>Replaced files</SectionTitle>
      <Card className="flex flex-col gap-3 p-4">
        <p className="m-0 text-sm text-soft">
          When a better copy comes in, the old file is set aside in a hidden <span className="font-mono text-xs">.marquee-replaced</span> folder in its library folder, in case you want it back. Plex and Jellyfin don’t look there. Marquee never empties it by itself.
        </p>
        {q.isError && <Notice tone="error">{errMsg(q.error)}</Notice>}
        {v && (
          <>
            <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
              <span className="text-heading font-semibold tabular-nums">{v.files ? size(v.bytes) : 'Empty'}</span>
              {v.files > 0 && (
                <span className="text-sm text-muted">
                  {v.files} {v.files === 1 ? 'file' : 'files'}
                  {v.folders.filter((f) => f.files).map((f) => ` · ${f.label} ${size(f.bytes)}`).join('')}
                </span>
              )}
            </div>
            {v.files > 0 && v.freedBytes < v.bytes && (
              <p className="m-0 text-sm text-muted">
                Emptying gives back {size(v.freedBytes)}. The rest is still shared by downloads in qBittorrent (the same file, hardlinked), so it frees up once those are removed.
              </p>
            )}
            {done && <Notice tone="success">{done}</Notice>}
            <p className="m-0 text-sm">
              <Link to="/library/clean-up?tab=bin" className="text-amber">
                Go through it file by file
              </Link>{' '}
              <span className="text-muted">in Library → Clean up, to put things back or delete only some.</span>
            </p>
            {v.files > 0 && (
              <div>
                <Button type="button" variant="danger" onClick={() => setConfirming(true)}>
                  Empty…
                </Button>
              </div>
            )}
          </>
        )}
      </Card>
      <Sheet open={confirming} onClose={() => setConfirming(false)} title="Empty the replaced files?">
        {v && (
          <div className="flex flex-col gap-4 pt-1 pb-2">
            <p className="m-0 text-sm text-soft">
              This deletes {v.files} {v.files === 1 ? 'file' : 'files'} ({size(v.bytes)}) that upgrades set aside, from:
            </p>
            <ul className="m-0 flex list-none flex-col gap-1 p-0 font-mono text-xs break-all text-muted">
              {v.folders.filter((f) => f.files).map((f) => (
                <li key={f.path}>
                  {f.path} ({f.files} {f.files === 1 ? 'file' : 'files'}, {size(f.bytes)})
                </li>
              ))}
            </ul>
            <p className="m-0 text-sm text-warn">It can’t be undone. The files in your library aren’t touched.</p>
            {error && <Notice tone="error">{error}</Notice>}
            <div className="flex flex-wrap gap-3">
              <Button type="button" variant="danger" disabled={busy} onClick={() => void empty()}>
                {busy ? 'Deleting…' : `Delete ${v.files} ${v.files === 1 ? 'file' : 'files'}`}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setConfirming(false)}>
                Keep them
              </Button>
            </div>
          </div>
        )}
      </Sheet>
    </section>
  );
}

function Jobs({ jobs }: { jobs: JobView[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ id: string; text: string } | null>(null);

  async function runNow(id: string) {
    setBusy(id);
    setError(null);
    try {
      await api<{ job: JobView }>(`/system/jobs/${id}/run`, { body: {} });
      await queryClient.invalidateQueries({ queryKey: HEALTH });
    } catch (err) {
      setError({ id, text: errMsg(err) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-labelledby="h-jobs" className="flex flex-col gap-3">
      <h2 id="h-jobs" className="m-0 text-heading font-semibold">
        Background jobs
      </h2>
      <ul className="m-0 flex list-none flex-col overflow-hidden rounded-2xl border border-line bg-panel p-0">
        {jobs.map((j) => (
          <li key={j.id} className="flex flex-wrap items-start gap-x-4 gap-y-2 border-line px-4 py-3 not-last:border-b">
            <div className="flex min-w-0 flex-1 basis-[320px] flex-col gap-0.5">
              <span className="flex items-center gap-2">
                <StatusDot tone={j.tone} />
                <span className="font-semibold">{j.label}</span>
                <span className="text-sm text-dim">{j.every}</span>
              </span>
              <span className="text-sm text-muted">{j.description}</span>
              <span className="text-sm">
                {j.running ? (
                  <span className="text-blue">Running now…</span>
                ) : j.lastStartedAt ? (
                  <span className={j.lastOk === false ? 'text-warn' : 'text-soft'}>
                    {j.lastOk === false ? 'Failed' : 'Last ran'} {ago(j.lastStartedAt)}
                    {j.lastMessage ? ` · ${j.lastMessage}` : ''}
                  </span>
                ) : (
                  <span className="text-dim">Hasn’t run yet</span>
                )}
                {j.nextAt !== null && !j.running && <span className="text-dim"> · next {inTime(j.nextAt)}</span>}
              </span>
              {j.off && <span className="text-sm text-dim">Off. {j.off}</span>}
              {error?.id === j.id && <span className="text-sm text-warn">{error.text}</span>}
            </div>
            <Button variant="ghost" onClick={() => void runNow(j.id)} disabled={j.running || !!j.off || busy === j.id} aria-label={`Run ${j.label} now`}>
              {j.running || busy === j.id ? 'Running…' : 'Run now'}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------- Backups ----------------

const BACKUPS = ['system', 'backups'];
const KIND: Record<BackupKind, string> = { nightly: 'Nightly', by_hand: 'By hand', before_restore: 'Before a restore', before_update: 'Before an update' };

export function BackupsPage() {
  const q = useQuery({ queryKey: BACKUPS, queryFn: () => api<BackupsView>('/system/backups') });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [restoring, setRestoring] = useState<BackupView | null>(null);

  async function backUpNow() {
    setBusy(true);
    setMessage(null);
    try {
      const b = await api<BackupView>('/system/backups', { body: {} });
      await queryClient.invalidateQueries({ queryKey: BACKUPS });
      setMessage({ tone: 'success', text: `Backed up (${size(b.size)}).` });
    } catch (err) {
      setMessage({ tone: 'error', text: errMsg(err) });
    } finally {
      setBusy(false);
    }
  }

  async function restore(b: BackupView) {
    setBusy(true);
    setMessage(null);
    try {
      const r = await api<RestoreResult>(`/system/backups/${encodeURIComponent(b.name)}/restore`, { body: { confirm: true } });
      setRestoring(null);
      setMessage({ tone: 'success', text: r.message.replace(/^Restored that backup\./, `Restored the backup from ${when(r.restored.createdAt)}.`) });
      // Everything may have changed.
      await queryClient.invalidateQueries();
      await refreshAuth();
    } catch (err) {
      setRestoring(null);
      setMessage({ tone: 'error', text: errMsg(err) });
    } finally {
      setBusy(false);
    }
  }

  if (q.isPending) return <p className="text-muted">Loading…</p>;
  if (q.isError) return <Notice tone="error">{errMsg(q.error)}</Notice>;
  const v = q.data;

  return (
    <div className="flex max-w-[760px] flex-col gap-6">
      <p className="m-0 text-soft">
        Everything Marquee knows lives in one database: your library, profiles, Sources, requests, history and settings. Marquee backs it up every night and keeps {v.keepDays} days of backups in{' '}
        <span className="font-mono text-sm break-all">{v.folder}</span>. Keep a copy somewhere else too, like your Unraid backups.
      </p>
      <p className="m-0 text-sm text-muted">
        A new version of Marquee that needs to change the database backs it up first (“Before an update”). To go back to the older version, run its image, then restore that backup here.
      </p>
      <div className="flex flex-wrap items-center gap-4">
        <Button onClick={() => void backUpNow()} disabled={busy}>
          {busy && !restoring ? 'Backing up…' : 'Back up now'}
        </Button>
        <span className="text-sm text-muted">
          {v.lastNightly ? `Last nightly backup ${ago(v.lastNightly)}` : 'No nightly backup yet'}
          {v.nextNightly ? ` · next ${inTime(v.nextNightly)}` : ''}
        </span>
      </div>
      {message && <Notice tone={message.tone}>{message.text}</Notice>}
      {v.backups.length === 0 ? (
        <EmptyState title="No backups yet">The first nightly backup is taken a few minutes after Marquee starts. Or press Back up now.</EmptyState>
      ) : (
        <ul className="m-0 flex list-none flex-col overflow-hidden rounded-2xl border border-line bg-panel p-0" aria-label="Backups">
          {v.backups.map((b) => (
            <li key={b.name} className="flex flex-wrap items-center gap-x-4 gap-y-2 border-line px-4 py-3 not-last:border-b">
              <div className="flex min-w-0 flex-1 basis-[240px] flex-col gap-0.5">
                <span className="font-semibold">{when(b.createdAt)}</span>
                <span className="text-sm text-muted">
                  {KIND[b.kind]} · {size(b.size)} · {ago(b.createdAt)}
                </span>
              </div>
              <a
                href={`/api/system/backups/${encodeURIComponent(b.name)}`}
                download={b.name}
                className="inline-flex h-11 items-center rounded-xl border border-line-strong px-4 text-sm font-medium text-text no-underline hover:bg-raised hover:text-text"
              >
                Download
              </a>
              <Button variant="danger" onClick={() => setRestoring(b)} disabled={busy}>
                Restore…
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Sheet open={!!restoring} onClose={() => !busy && setRestoring(null)} title="Restore this backup?">
        {restoring && (
          <div className="flex flex-col gap-4 pb-2">
            <p className="m-0 text-soft">
              Everything in Marquee goes back to how it was on <strong className="text-text">{when(restoring.createdAt)}</strong>: library, profiles, Sources, requests, history and settings. Anything changed since then is
              replaced.
            </p>
            <p className="m-0 text-sm text-muted">Marquee backs up how things are right now first, so you can restore that one to undo this. Files on your disks aren’t touched. You may need to sign in again.</p>
            <div className="flex flex-wrap gap-3">
              <Button variant="danger" onClick={() => void restore(restoring)} disabled={busy}>
                {busy ? 'Restoring…' : 'Restore this backup'}
              </Button>
              <Button variant="ghost" onClick={() => setRestoring(null)} disabled={busy}>
                Keep things as they are
              </Button>
            </div>
          </div>
        )}
      </Sheet>
    </div>
  );
}

// ---------------- Logs ----------------

type Show = 'all' | 'warn' | 'error';
const SHOW_LEVEL: Record<Show, LogLevel> = { all: 'debug', warn: 'warn', error: 'error' };
const LEVEL: Record<LogLevel, { label: string; cls: string }> = {
  debug: { label: 'Detail', cls: 'text-dim' },
  info: { label: 'Info', cls: 'text-muted' },
  warn: { label: 'Warning', cls: 'text-amber' },
  error: { label: 'Problem', cls: 'text-warn' },
};

export function LogsPage() {
  const [show, setShow] = useState<Show>('all');
  const [search, setSearch] = useState('');
  const params = new URLSearchParams({ level: SHOW_LEVEL[show], ...(search.trim() ? { search: search.trim() } : {}) });
  const q = useQuery({ queryKey: ['system', 'logs', show, search.trim()], queryFn: () => api<LogsView>(`/system/logs?${params}`), refetchInterval: 10_000 });
  const lines = q.data ? [...q.data.lines].reverse() : [];

  return (
    <div className="flex max-w-[960px] flex-col gap-4">
      <p className="m-0 text-soft">
        What Marquee has been doing lately, newest first. Keys, passwords and tokens are taken out before anything is kept, so the download is safe to share in a bug report.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <Chips
          label="Which lines"
          value={show}
          onChange={setShow}
          items={[
            { value: 'all', label: 'Everything' },
            { value: 'warn', label: 'Warnings and problems' },
            { value: 'error', label: 'Problems only' },
          ]}
        />
        <label className="flex min-w-[200px] flex-1 items-center">
          <span className="sr-only">Find in the log</span>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Find words…"
            className="h-11 w-full rounded-xl border border-line-strong bg-ink px-4 text-body text-text placeholder:text-dim focus:border-amber focus:outline-none"
          />
        </label>
        <a
          href={`/api/system/logs/download?${params}`}
          download
          className="inline-flex h-11 items-center rounded-xl border border-line-strong px-4 text-sm font-medium text-text no-underline hover:bg-raised hover:text-text"
        >
          Download
        </a>
      </div>
      {q.isError && <Notice tone="error">{errMsg(q.error)}</Notice>}
      {q.data && (
        <p className="m-0 text-sm text-dim">
          {lines.length} {lines.length === 1 ? 'line' : 'lines'} shown · Marquee keeps the newest {q.data.keepMax.toLocaleString()} until it restarts
        </p>
      )}
      {q.data && lines.length === 0 ? (
        <EmptyState title={search.trim() || show !== 'all' ? 'Nothing matches' : 'Nothing yet'}>
          {search.trim() || show !== 'all' ? 'Try Everything, or other words.' : 'Lines show up here as Marquee works.'}
        </EmptyState>
      ) : (
        <ol className="m-0 flex list-none flex-col overflow-hidden rounded-2xl border border-line bg-panel p-0 font-mono text-xs" aria-label="Log lines">
          {lines.map((l) => (
            <li key={l.id} className="flex flex-wrap gap-x-3 gap-y-0.5 border-line px-4 py-2 not-last:border-b">
              <time dateTime={new Date(l.at).toISOString()} className="text-dim">
                {new Date(l.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </time>
              <span className={cx('w-16 flex-none font-semibold', LEVEL[l.level].cls)}>{LEVEL[l.level].label}</span>
              {l.area && <span className="text-soft">{l.area}</span>}
              <span className="min-w-0 basis-full whitespace-pre-wrap break-words text-text sm:basis-auto sm:flex-1">{l.message}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
