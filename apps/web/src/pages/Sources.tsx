import { useState, type FormEvent } from 'react';
import { Navigate, useOutletContext } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import type { AuthStatus, ProwlarrSyncResult, SessionUser, SourceCheckResult, SourceState, SourceUpdate, SourceView, SourcesView } from '@marquee/shared';
import { api, ApiFailure, queryClient } from '../api';
import { Button, Card, Field, Notice, cx } from '../components/ui';

/**
 * Settings → Sources: the sites Marquee searches for copies (older apps call
 * them indexers). Prowlarr first, since that's how most people have them.
 */

type Ctx = { status: AuthStatus & { user: SessionUser } };
type Msg = { tone: 'success' | 'error'; text: string } | null;

const errMsg = (e: unknown) => (e instanceof ApiFailure ? e.message : 'Something went wrong.');
const reload = () => queryClient.invalidateQueries({ queryKey: ['sources'] });

export function SourcesPage() {
  const { status } = useOutletContext<Ctx>();
  if (status.user.role !== 'admin') return <Navigate to="/settings/account" replace />;
  return <SourcesAdmin />;
}

function SourcesAdmin() {
  const { data } = useQuery({
    queryKey: ['sources'],
    queryFn: () => api<SourcesView>('/settings/sources'),
    // New Sources are checked in the background after linking; refresh until none are waiting.
    refetchInterval: (q) => (q.state.data?.sources.some((s) => s.state === 'unchecked') ? 3000 : false),
  });
  const [message, setMessage] = useState<Msg>(null);
  if (!data) return <p className="text-muted">Loading…</p>;

  return (
    <div className="flex max-w-[960px] flex-col gap-6">
      <p className="m-0 max-w-[680px] text-[15px] text-muted">
        Sources are the sites Marquee searches for copies of a movie or show. Older apps call them indexers. Marquee only reads from them: nothing is downloaded until you say so.
      </p>
      {message && <Notice tone={message.tone}>{message.text}</Notice>}
      <ProwlarrCard prowlarr={data.prowlarr} setMessage={setMessage} />
      <Card className="flex flex-col gap-1">
        <h2 className="m-0 mb-3 text-lg font-semibold">
          Your Sources <span className="text-sm font-normal text-dim">{data.sources.length || ''}</span>
        </h2>
        {data.sources.length === 0 && (
          <p className="m-0 border-t border-line py-4 text-sm text-muted">None yet. Link Prowlarr above, or add a Torznab feed by hand below.</p>
        )}
        {data.sources.map((s) => (
          <SourceRow key={s.id} source={s} setMessage={setMessage} />
        ))}
      </Card>
      <AddByHand setMessage={setMessage} />
    </div>
  );
}

// ---------------- Prowlarr ----------------

function ProwlarrCard({ prowlarr, setMessage }: { prowlarr: SourcesView['prowlarr']; setMessage: (m: Msg) => void }) {
  const [editing, setEditing] = useState(!prowlarr.linked);
  const [busy, setBusy] = useState<string | null>(null);
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);
  const [sync, setSync] = useState<ProwlarrSyncResult | null>(null);
  const [unlinking, setUnlinking] = useState(false);

  const values = () => ({
    url: (document.getElementById('prowlarrUrl') as HTMLInputElement | null)?.value.trim() || undefined,
    apiKey: (document.getElementById('prowlarrKey') as HTMLInputElement | null)?.value.trim() || undefined,
  });

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setMessage(null);
    try {
      await fn();
    } catch (e) {
      setMessage({ tone: 'error', text: errMsg(e) });
    } finally {
      setBusy(null);
    }
  }

  const onTest = () => run('test', async () => setTest(await api('/settings/sources/prowlarr/test', { body: values() })));
  const onLink = (e: FormEvent) => {
    e.preventDefault();
    void run('link', async () => {
      const r = await api<ProwlarrSyncResult>('/settings/sources/prowlarr', { method: 'PUT', body: values() });
      setSync(r);
      setTest(null);
      setEditing(false);
      await reload();
    });
  };
  const onSync = () =>
    run('sync', async () => {
      const r = await api<ProwlarrSyncResult>('/settings/sources/prowlarr/sync', { body: {} });
      setSync(r);
      if (!r.ok) setMessage({ tone: 'error', text: r.message });
      await reload();
    });
  const onUnlink = (removeSources: boolean) =>
    run('unlink', async () => {
      await api('/settings/sources/prowlarr/unlink', { body: { removeSources } });
      setUnlinking(false);
      setSync(null);
      setEditing(true);
      setMessage({ tone: 'success', text: removeSources ? 'Prowlarr unlinked and its Sources removed.' : 'Prowlarr unlinked. Its Sources stay, and you manage them here now.' });
      await reload();
    });

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="m-0 text-lg font-semibold">
            Prowlarr {prowlarr.linked && <span className="text-sm font-normal text-teal-hi">linked</span>}
          </h2>
          <p className="m-0 mt-1 max-w-[620px] text-sm text-muted">
            {prowlarr.linked
              ? `Marquee brings in every torrent site from ${prowlarr.url} that has movies or TV, and checks again every 6 hours. Names, priority and limits you change here stay as you set them.`
              : 'Already use Prowlarr? Link it and every one of its torrent sites with movies or TV becomes a Source. Marquee only reads from Prowlarr.'}
          </p>
          {prowlarr.linked && prowlarr.syncedAt && (
            <p className="m-0 mt-2 text-[13px] text-dim">
              Last synced {ago(prowlarr.syncedAt)}
              {prowlarr.syncMessage && ` · ${prowlarr.syncMessage}`}
            </p>
          )}
        </div>
        {prowlarr.linked && !editing && (
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="ghost" className="h-11 px-4 text-sm" onClick={onSync} disabled={!!busy}>
              {busy === 'sync' ? 'Syncing…' : 'Sync now'}
            </Button>
            <Button type="button" variant="ghost" className="h-11 px-4 text-sm" onClick={() => setEditing(true)}>
              Change
            </Button>
            <Button type="button" variant="danger" className="h-11 px-4 text-sm" onClick={() => setUnlinking(true)}>
              Unlink
            </Button>
          </div>
        )}
      </div>

      {unlinking && (
        <div role="group" aria-label="Unlink Prowlarr" className="flex flex-col gap-3 rounded-xl border border-line-strong bg-raised p-4">
          <p className="m-0 text-sm">What should happen to the Sources that came from Prowlarr?</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="danger" className="h-11 px-4 text-sm" onClick={() => onUnlink(true)} disabled={!!busy}>
              Remove them
            </Button>
            <Button type="button" variant="ghost" className="h-11 px-4 text-sm" onClick={() => onUnlink(false)} disabled={!!busy}>
              Keep them as my own
            </Button>
            <Button type="button" variant="ghost" className="h-11 px-4 text-sm" onClick={() => setUnlinking(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {editing && (
        <form onSubmit={onLink} className="flex flex-col gap-4">
          <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-4">
            <Field label="Address" id="prowlarrUrl" name="prowlarrUrl" defaultValue={prowlarr.url ?? ''} placeholder="http://192.168.1.100:9696" required />
            <Field
              label="API key"
              id="prowlarrKey"
              name="prowlarrKey"
              type="password"
              autoComplete="off"
              placeholder={prowlarr.linked ? '••••••••••••' : ''}
              hint={prowlarr.linked ? 'Saved. Leave blank to keep it.' : 'Prowlarr → Settings → General → API Key'}
            />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={!!busy}>
              {busy === 'link' ? 'Linking…' : prowlarr.linked ? 'Save and sync' : 'Link Prowlarr'}
            </Button>
            <Button type="button" variant="ghost" onClick={onTest} disabled={!!busy}>
              {busy === 'test' ? 'Testing…' : 'Test'}
            </Button>
            {prowlarr.linked && (
              <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            )}
            {test && (
              <span role="status" className={cx('text-sm', test.ok ? 'text-teal-hi' : 'text-warn')}>
                {test.message}
              </span>
            )}
          </div>
        </form>
      )}

      {sync && sync.ok && (
        <div role="status" className="rounded-xl bg-raised px-4 py-3 text-sm text-soft">
          <p className="m-0">{sync.message}</p>
          {sync.added.length > 0 && <p className="m-0 mt-1 text-muted">Added: {sync.added.join(', ')}.</p>}
          {sync.removed.length > 0 && <p className="m-0 mt-1 text-muted">Removed (gone from Prowlarr): {sync.removed.join(', ')}.</p>}
          {sync.skipped.length > 0 && (
            <ul className="m-0 mt-1 list-none p-0 text-muted">
              {sync.skipped.map((s) => (
                <li key={s.name}>
                  Left out {s.name}: {s.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}

// ---------------- one Source ----------------

const STATE_COLOR: Record<SourceState, string> = {
  working: 'bg-teal',
  unchecked: 'bg-dim',
  paused: 'bg-dim',
  slowed_down: 'bg-amber',
  set_aside: 'bg-amber',
  unreachable: 'bg-warn',
  key_refused: 'bg-warn',
  blocked: 'bg-warn',
  not_a_feed: 'bg-warn',
  error: 'bg-warn',
};

function SourceRow({ source: s, setMessage }: { source: SourceView; setMessage: (m: Msg) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [check, setCheck] = useState<SourceCheckResult | null>(null);
  const [open, setOpen] = useState(false);
  const failing = !['working', 'unchecked', 'paused'].includes(s.state);

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setMessage(null);
    try {
      await fn();
      await reload();
    } catch (e) {
      setMessage({ tone: 'error', text: errMsg(e) });
    } finally {
      setBusy(null);
    }
  }

  const onCheck = () => run('check', async () => setCheck(await api<SourceCheckResult>(`/settings/sources/${s.id}/check`, { body: {} })));
  const setEnabled = (enabled: boolean) => run('pause', async () => void (await api(`/settings/sources/${s.id}`, { method: 'PUT', body: { enabled } })));
  const onRemove = () => {
    if (!window.confirm(`Remove ${s.name}? Marquee will stop searching it.`)) return;
    void run('remove', async () => {
      await api(`/settings/sources/${s.id}`, { method: 'DELETE' });
      setMessage({ tone: 'success', text: `${s.name} removed.` });
    });
  };

  const used = s.forMovies && s.forTv ? 'For movies and TV' : s.forMovies ? 'For movies' : s.forTv ? 'For TV' : 'Not used for anything';

  return (
    <div className="flex flex-col gap-3 border-t border-line py-4">
      <div className="flex flex-wrap items-center gap-4">
        <div className="min-w-[220px] flex-1">
          <div className="flex flex-wrap items-center gap-2 text-[15px] font-semibold">
            {s.name}
            {s.private && <span className="rounded-full border border-line-strong px-2 py-0.5 text-xs font-medium text-soft">Private</span>}
            {s.fromProwlarr && <span className="rounded-full border border-line-strong px-2 py-0.5 text-xs font-medium text-dim">From Prowlarr</span>}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted">
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden="true" className={cx('size-2 rounded-full', STATE_COLOR[s.state])} />
              <span className={cx(failing ? 'text-warn' : s.state === 'working' ? 'text-teal-hi' : 'text-soft')}>{s.stateLabel}</span>
            </span>
            <span>{used}</span>
            {s.week.avgMs !== null && <span>Usually answers in {seconds(s.week.avgMs)}</span>}
            <span>
              {s.week.searchesToday} {s.week.searchesToday === 1 ? 'search' : 'searches'} today{s.dailyLimit > 0 && ` of ${s.dailyLimit}`}
            </span>
            {s.week.failures > 0 && (
              <span>
                {s.week.failures} of {s.week.calls} calls failed this week
              </span>
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="ghost" className="h-11 px-4 text-sm" onClick={onCheck} disabled={!!busy}>
            {busy === 'check' ? 'Checking…' : failing ? 'Try now' : 'Test'}
          </Button>
          <Button type="button" variant="ghost" className="h-11 px-4 text-sm" onClick={() => setEnabled(!s.enabled)} disabled={!!busy}>
            {s.enabled ? 'Pause' : 'Resume'}
          </Button>
          <Button type="button" variant="ghost" className="h-11 px-4 text-sm" aria-expanded={open} aria-controls={`source-${s.id}-settings`} onClick={() => setOpen(!open)}>
            {open ? 'Close' : 'Settings'}
          </Button>
        </div>
      </div>

      {failing && (
        <div className="rounded-xl bg-warn/10 px-4 py-3 text-sm">
          {s.stateMessage && <p className="m-0 text-warn">{s.stateMessage}</p>}
          {s.fix && <p className="m-0 mt-1 text-soft">{s.fix}</p>}
          {s.retryAt && <p className="m-0 mt-1 text-dim">Marquee tries again by itself at {new Date(s.retryAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.</p>}
        </div>
      )}
      {check && (
        <p role="status" className={cx('m-0 text-sm', check.ok ? 'text-teal-hi' : 'text-warn')}>
          {check.message}
        </p>
      )}
      {!check && s.state === 'working' && s.searchesById && <p className="m-0 text-[13px] text-dim">{s.searchesById}</p>}

      {open && <SourceSettings source={s} onSaved={() => setOpen(false)} onRemove={s.fromProwlarr ? null : onRemove} setMessage={setMessage} />}
    </div>
  );
}

function SourceSettings({ source: s, onSaved, onRemove, setMessage }: { source: SourceView; onSaved: () => void; onRemove: (() => void) | null; setMessage: (m: Msg) => void }) {
  const [busy, setBusy] = useState(false);
  const id = (name: string) => `source-${s.id}-${name}`;

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    const n = (k: string) => Number(d.get(k));
    const body: SourceUpdate = {
      name: String(d.get('name') ?? ''),
      forMovies: d.get('forMovies') === 'on',
      forTv: d.get('forTv') === 'on',
      priority: n('priority'),
      minSeeders: n('minSeeders'),
      dailyLimit: n('dailyLimit'),
      minGapMs: Math.round(n('minGapSeconds') * 1000),
      timeoutSeconds: n('timeoutSeconds'),
    };
    if (!s.fromProwlarr) {
      body.url = String(d.get('url') ?? '');
      const key = String(d.get('apiKey') ?? '').trim();
      if (key) body.apiKey = key;
    }
    setBusy(true);
    setMessage(null);
    try {
      await api(`/settings/sources/${s.id}`, { method: 'PUT', body });
      setMessage({ tone: 'success', text: `${body.name} saved.` });
      await reload();
      onSaved();
    } catch (err) {
      setMessage({ tone: 'error', text: errMsg(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form id={`source-${s.id}-settings`} onSubmit={save} className="flex flex-col gap-4 rounded-xl border border-line bg-ink/40 p-4">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-4">
        <Field label="Name" id={id('name')} name="name" defaultValue={s.name} required />
        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
          <legend className="mb-2 text-sm font-medium text-soft">Search it for</legend>
          <div className="flex gap-5">
            <Check id={id('movies')} name="forMovies" label="Movies" defaultChecked={s.forMovies} />
            <Check id={id('tv')} name="forTv" label="TV" defaultChecked={s.forTv} />
          </div>
        </fieldset>
        {!s.fromProwlarr && (
          <>
            <Field label="Torznab address" id={id('url')} name="url" defaultValue={s.url} required />
            <Field label="API key" id={id('key')} name="apiKey" type="password" autoComplete="off" placeholder={s.hasKey ? '••••••••••••' : ''} hint={s.hasKey ? 'Saved. Leave blank to keep it.' : undefined} />
          </>
        )}
      </div>
      {s.fromProwlarr && <p className="m-0 text-[13px] text-dim">The address and key come from Prowlarr: {s.url}</p>}

      <details className="rounded-xl border border-line px-4 py-3">
        <summary className="cursor-pointer text-sm font-medium text-soft">For experts</summary>
        <div className="mt-4 grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-4">
          <Field label="Priority" id={id('priority')} name="priority" type="number" min={1} max={50} defaultValue={s.priority} hint="1 to 50. Lower wins ties between equally good copies." />
          <Field label="Fewest people sharing" id={id('seeders')} name="minSeeders" type="number" min={0} defaultValue={s.minSeeders} hint="Copies with fewer seeders are skipped." />
          <Field label="Most searches a day" id={id('limit')} name="dailyLimit" type="number" min={0} defaultValue={s.dailyLimit} hint="0 means no limit. Private sites often cap this." />
          <Field label="Gap between searches (seconds)" id={id('gap')} name="minGapSeconds" type="number" min={0} step={0.5} defaultValue={s.minGapMs / 1000} hint="Keeps Marquee from rushing the site." />
          <Field label="Give up after (seconds)" id={id('timeout')} name="timeoutSeconds" type="number" min={1} max={300} defaultValue={s.timeoutSeconds} hint="Slow sites are left out of that search." />
        </div>
      </details>

      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy}>
          Save
        </Button>
        {onRemove && (
          <Button type="button" variant="danger" onClick={onRemove}>
            Remove
          </Button>
        )}
      </div>
    </form>
  );
}

function Check({ id, name, label, defaultChecked }: { id: string; name: string; label: string; defaultChecked: boolean }) {
  return (
    <label htmlFor={id} className="inline-flex min-h-11 cursor-pointer items-center gap-2 text-[15px]">
      <input id={id} name={name} type="checkbox" defaultChecked={defaultChecked} className="size-5 accent-amber" />
      {label}
    </label>
  );
}

// ---------------- add by hand ----------------

function AddByHand({ setMessage }: { setMessage: (m: Msg) => void }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SourceCheckResult | null>(null);

  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const d = new FormData(form);
    setBusy(true);
    setMessage(null);
    setResult(null);
    try {
      const r = await api<{ source: SourceView; check: SourceCheckResult }>('/settings/sources', { body: { name: d.get('name'), url: d.get('url'), apiKey: d.get('apiKey') ?? '' } });
      setResult(r.check);
      form.reset();
      await reload();
    } catch (err) {
      setMessage({ tone: 'error', text: errMsg(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <details>
        <summary className="cursor-pointer text-lg font-semibold">Add a Source by hand</summary>
        <p className="m-0 mt-2 text-sm text-muted">For a Torznab feed from Jackett or a site that offers one. Marquee checks it as soon as you add it.</p>
        <form onSubmit={add} className="mt-4 grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-4">
          <Field label="Name" name="name" id="new-source-name" required />
          <Field label="Torznab address" name="url" id="new-source-url" placeholder="http://192.168.1.100:9117/api/v2.0/indexers/…/results/torznab" required />
          <Field label="API key" name="apiKey" id="new-source-key" type="password" autoComplete="off" />
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={busy}>
              {busy ? 'Adding…' : 'Add and check'}
            </Button>
            {result && (
              <span role="status" className={cx('text-sm', result.ok ? 'text-teal-hi' : 'text-warn')}>
                {result.message}
              </span>
            )}
          </div>
        </form>
      </details>
    </Card>
  );
}

// ---------------- helpers ----------------

function seconds(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function ago(t: number): string {
  const min = Math.round((Date.now() - t) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} ${h === 1 ? 'hour' : 'hours'} ago`;
  return new Date(t).toLocaleDateString();
}
