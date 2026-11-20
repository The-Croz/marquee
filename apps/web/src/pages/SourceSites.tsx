import { useMemo, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { SiteField, SiteForm, SiteSettingsView, SitesView, SiteSummary, SolverView, SourceCheckResult, SourceView } from '@marquee/shared';
import { api, ApiFailure, queryClient } from '../api';
import { Button, Card, Field, Notice, cx } from '../components/ui';
import { InfoTip } from '../components/Page';

/**
 * Sites Marquee searches itself: picking one from the list (Prowlarr's
 * catalogue, your own files, and the ones built in), the form each site asks
 * for, and bot-check solving.
 */

type Msg = { tone: 'success' | 'error'; text: string } | null;
const errMsg = (e: unknown) => (e instanceof ApiFailure ? e.message : 'Something went wrong.');
const reloadSources = () => queryClient.invalidateQueries({ queryKey: ['sources'] });

const KIND_LABEL: Record<SiteSummary['type'], string> = {
  public: 'Public',
  private: 'Private',
  semiPrivate: 'Account helps',
};

function ago(t: number): string {
  const min = Math.round((Date.now() - t) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} ${h === 1 ? 'hour' : 'hours'} ago` : new Date(t).toLocaleDateString();
}

// ---------------- the form a site asks for ----------------

/** Reads a site's settings back out of a form. Blank secrets are left out, so the saved ones stay. */
export function readSiteFields(form: HTMLFormElement, fields: SiteField[], prefix: string): Record<string, string | string[] | boolean> {
  const d = new FormData(form);
  const out: Record<string, string | string[] | boolean> = {};
  for (const f of fields) {
    const key = `${prefix}${f.name}`;
    if (f.type === 'info') continue;
    if (f.type === 'checkbox') out[f.name] = d.get(key) === 'on';
    else if (f.type === 'multiselect') out[f.name] = d.getAll(key).map(String);
    else {
      const v = String(d.get(key) ?? '');
      if (f.secret && !v.trim()) continue;
      out[f.name] = v;
    }
  }
  return out;
}

export function SiteFields({ fields, values, prefix }: { fields: SiteField[]; values: SiteSettingsView | null; prefix: string }) {
  if (!fields.length) return <p className="m-0 text-sm text-muted">Nothing to fill in: it’s a public site.</p>;
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-4">
      {fields.map((f) => {
        const id = `${prefix}${f.name}`;
        const v = values?.[f.name];
        const saved = typeof v === 'object' && v !== null && !Array.isArray(v) && 'saved' in v ? v.saved : false;
        const current = typeof v === 'object' && v !== null && !Array.isArray(v) ? null : (v ?? f.default ?? null);
        if (f.type === 'info')
          return (
            <p key={id} className="m-0 self-end rounded-xl bg-raised px-3 py-2 text-label text-muted [grid-column:1/-1]">
              {f.label && <span className="font-medium text-soft">{f.label}: </span>}
              {f.text}
            </p>
          );
        if (f.type === 'checkbox')
          return (
            <label key={id} htmlFor={id} className="inline-flex min-h-11 cursor-pointer items-center gap-2 self-end text-body">
              <input id={id} name={id} type="checkbox" defaultChecked={current === true || current === 'true'} className="size-5 accent-amber" />
              {f.label}
            </label>
          );
        if (f.type === 'select')
          return (
            <div key={id} className="flex flex-col gap-2">
              <label htmlFor={id} className="text-sm font-medium text-soft">
                {f.label}
              </label>
              <select id={id} name={id} defaultValue={typeof current === 'string' ? current : undefined} className="h-11 rounded-xl border border-line-strong bg-ink px-3 text-body">
                {f.options?.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          );
        if (f.type === 'multiselect')
          return (
            <fieldset key={id} className="m-0 flex flex-col gap-1 border-0 p-0">
              <legend className="mb-2 text-sm font-medium text-soft">{f.label}</legend>
              {f.options?.map((o) => (
                <label key={o.value} className="inline-flex min-h-11 items-center gap-2 text-body">
                  <input type="checkbox" name={id} value={o.value} defaultChecked={Array.isArray(current) && current.includes(o.value)} className="size-5 accent-amber" />
                  {o.label}
                </label>
              ))}
            </fieldset>
          );
        return (
          <Field
            key={id}
            id={id}
            name={id}
            label={f.label}
            type={f.secret ? 'password' : 'text'}
            autoComplete="off"
            defaultValue={f.secret ? '' : typeof current === 'string' ? current : ''}
            placeholder={saved ? '••••••••••••' : ''}
            hint={saved ? 'Saved. Leave blank to keep it.' : undefined}
          />
        );
      })}
    </div>
  );
}

/** A site's own settings and address, inside its Source settings. */
export function SiteSettingsEditor({ source: s, setMessage }: { source: SourceView; setMessage: (m: Msg) => void }) {
  const q = useQuery({
    queryKey: ['site', s.siteId],
    queryFn: () => api<SiteForm>(`/settings/sources/sites/${s.siteId}`),
    enabled: !!s.siteId,
  });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SourceCheckResult | null>(null);
  const prefix = `s${s.id}-`;
  if (q.error) return <Notice tone="error">{errMsg(q.error)}</Notice>;
  if (!q.data) return <p className="m-0 text-sm text-muted">Loading the site’s settings…</p>;
  const form = q.data;

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const el = e.currentTarget;
    setBusy(true);
    setMessage(null);
    setResult(null);
    try {
      const url = String(new FormData(el).get(`${prefix}address`) ?? '');
      setResult(
        await api<SourceCheckResult>(`/settings/sources/${s.id}/site`, {
          method: 'PUT',
          body: { url, settings: readSiteFields(el, form.fields, prefix) },
        }),
      );
      await reloadSources();
    } catch (err) {
      setMessage({ tone: 'error', text: errMsg(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-4 rounded-xl border border-line px-4 py-4">
      <h3 className="m-0 text-body font-semibold">{form.name}: address and sign-in</h3>
      {form.links.length > 1 && (
        <div className="flex max-w-[420px] flex-col gap-2">
          <label htmlFor={`${prefix}address`} className="text-sm font-medium text-soft">
            Address
          </label>
          <select id={`${prefix}address`} name={`${prefix}address`} defaultValue={s.url} className="h-11 rounded-xl border border-line-strong bg-ink px-3 text-body">
            {form.links.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
          <p className="m-0 text-label text-dim">If the site stops answering, another of its addresses often still works.</p>
        </div>
      )}
      <SiteFields fields={form.fields} values={s.siteSettings} prefix={prefix} />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="ghost" disabled={busy}>
          {busy ? 'Checking…' : 'Save and check'}
        </Button>
        {result && (
          <span role="status" className={cx('text-sm', result.ok ? 'text-teal-hi' : 'text-warn')}>
            {result.message}
          </span>
        )}
      </div>
    </form>
  );
}

// ---------------- adding a site ----------------

export function AddSiteCard({ setMessage }: { setMessage: (m: Msg) => void }) {
  const list = useQuery({
    queryKey: ['sites'],
    queryFn: () => api<SitesView>('/settings/sources/sites'),
  });
  const [filter, setFilter] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const matches = useMemo(() => {
    const n = filter.trim().toLowerCase();
    const all = list.data?.sites ?? [];
    return n ? all.filter((s) => s.name.toLowerCase().includes(n) || s.description.toLowerCase().includes(n)) : all;
  }, [list.data, filter]);
  const shown = showAll || filter ? matches.slice(0, 200) : matches.slice(0, 12);

  async function refresh() {
    setRefreshing(true);
    setMessage(null);
    try {
      const r = await api<{ ok: boolean; message: string; view: SitesView }>('/settings/sources/sites/refresh', { body: {} });
      queryClient.setQueryData(['sites'], r.view);
      setMessage({ tone: r.ok ? 'success' : 'error', text: r.message });
    } catch (e) {
      setMessage({ tone: 'error', text: errMsg(e) });
    } finally {
      setRefreshing(false);
    }
  }

  const cat = list.data?.catalogue;
  return (
    <Card className="flex flex-col gap-4">
      <div>
        <h2 className="m-0 text-lg font-semibold">Add a site</h2>
        <p className="m-0 mt-1 max-w-[640px] text-sm text-muted">
          Pick a site and fill in what it asks for; Marquee checks it straight away.{' '}
          <InfoTip className="-my-3.5 align-middle" label="About adding sites">Marquee can search hundreds of sites itself, no Prowlarr needed. Private sites need your username and password, or a cookie.</InfoTip>
        </p>
      </div>
      {list.error && <Notice tone="error">{errMsg(list.error)}</Notice>}
      {picked ? (
        <AddSiteForm siteId={picked} onDone={() => setPicked(null)} setMessage={setMessage} />
      ) : (
        <>
          <Field label="Find a site" id="site-filter" name="siteFilter" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="1337x, EZTV, IPTorrents…" autoComplete="off" />
          {list.data && matches.length === 0 && <p className="m-0 text-sm text-muted">No site by that name in the list. Update the list below, or add a Torznab feed by hand.</p>}
          <ul className="m-0 flex list-none flex-col p-0">
            {shown.map((s) => (
              <li key={s.id} className="border-t border-line">
                <button
                  type="button"
                  onClick={() => setPicked(s.id)}
                  disabled={!!s.unsupported}
                  className="flex min-h-11 w-full flex-col items-start gap-0.5 bg-transparent px-1 py-2.5 text-left disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <span className="flex flex-wrap items-center gap-2 text-body font-semibold text-text">
                    {s.name}
                    <span className="rounded-full border border-line-strong px-2 py-0.5 text-xs font-medium text-soft">{KIND_LABEL[s.type]}</span>
                    {s.origin === 'builtin' && <span className="rounded-full border border-teal px-2 py-0.5 text-xs font-medium text-teal-hi">Built in</span>}
                    {s.origin === 'custom' && <span className="rounded-full border border-amber px-2 py-0.5 text-xs font-medium text-amber-hi">Your file</span>}
                    <span className="text-xs font-normal text-dim">{s.movies && s.tv ? 'Movies and TV' : s.movies ? 'Movies' : 'TV'}</span>
                  </span>
                  <span className="text-label text-muted">{s.unsupported ? `Not supported yet: ${s.unsupported}` : s.description}</span>
                </button>
              </li>
            ))}
          </ul>
          {!filter && !showAll && matches.length > shown.length && (
            <Button type="button" variant="ghost" className="h-11 self-start px-4 text-sm" onClick={() => setShowAll(true)}>
              Show all {matches.length}
            </Button>
          )}
        </>
      )}
      {cat && (
        <div className="flex flex-wrap items-center gap-3 border-t border-line pt-3 text-label text-dim">
          <span>
            {cat.count} sites
            {cat.refreshedAt ? ` · list updated ${ago(cat.refreshedAt)}` : ' · list not downloaded yet'}. Your own site files go in <code className="font-mono break-all">{cat.customFolder}</code>.
          </span>
          <Button type="button" variant="ghost" className="h-11 px-3.5 text-sm" onClick={refresh} disabled={refreshing}>
            {refreshing ? 'Updating…' : 'Update the list of sites'}
          </Button>
        </div>
      )}
    </Card>
  );
}

function AddSiteForm({ siteId, onDone, setMessage }: { siteId: string; onDone: () => void; setMessage: (m: Msg) => void }) {
  const q = useQuery({
    queryKey: ['site', siteId],
    queryFn: () => api<SiteForm>(`/settings/sources/sites/${siteId}`),
  });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SourceCheckResult | null>(null);
  const prefix = 'new-site-';
  if (q.error) return <Notice tone="error">{errMsg(q.error)}</Notice>;
  if (!q.data) return <p className="m-0 text-sm text-muted">Loading…</p>;
  const form = q.data;

  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const el = e.currentTarget;
    const d = new FormData(el);
    setBusy(true);
    setMessage(null);
    setResult(null);
    try {
      const r = await api<{ source: SourceView; check: SourceCheckResult }>('/settings/sources/sites', {
        body: {
          siteId: form.id,
          name: String(d.get(`${prefix}name`) ?? ''),
          url: String(d.get(`${prefix}address`) ?? ''),
          settings: readSiteFields(el, form.fields, prefix),
        },
      });
      setResult(r.check);
      await reloadSources();
      if (r.check.ok) {
        setMessage({
          tone: 'success',
          text: `${r.source.name} added. ${r.check.message}`,
        });
        onDone();
      }
    } catch (err) {
      setMessage({ tone: 'error', text: errMsg(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={add} className="flex flex-col gap-4">
      <div>
        <h3 className="m-0 text-heading font-semibold">{form.name}</h3>
        {form.description && <p className="m-0 mt-1 text-sm text-muted">{form.description}</p>}
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-4">
        <Field label="Name" id={`${prefix}name`} name={`${prefix}name`} defaultValue={form.name} required />
        {form.links.length > 1 && (
          <div className="flex flex-col gap-2">
            <label htmlFor={`${prefix}address`} className="text-sm font-medium text-soft">
              Address
            </label>
            <select id={`${prefix}address`} name={`${prefix}address`} className="h-11 rounded-xl border border-line-strong bg-ink px-3 text-body">
              {form.links.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      <SiteFields fields={form.fields} values={null} prefix={prefix} />
      <p className="m-0 text-label text-dim">Passwords and cookies stay on your server and are never shown again.</p>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={busy}>
          {busy ? 'Adding…' : 'Add and check'}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          {result && !result.ok ? 'Done' : 'Back to the list'}
        </Button>
        {result && !result.ok && (
          <span role="status" className="text-sm text-warn">
            Added, but: {result.message} You can fix it in its Settings below.
          </span>
        )}
      </div>
    </form>
  );
}

// ---------------- bot checks ----------------

export function SolverCard() {
  const q = useQuery({
    queryKey: ['solver'],
    queryFn: () => api<SolverView>('/settings/sources/solver'),
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const v = q.data;
  if (!v) return null;

  async function save(enabled: boolean, url?: string | null) {
    setBusy('save');
    setError(null);
    setTest(null);
    try {
      queryClient.setQueryData(
        ['solver'],
        await api<SolverView>('/settings/sources/solver', {
          method: 'PUT',
          body: { enabled, ...(url !== undefined ? { url: url ?? '' } : {}) },
        }),
      );
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(null);
    }
  }

  async function runTest() {
    setBusy('test');
    setError(null);
    try {
      const r = await api<{ ok: boolean; message: string; view?: SolverView }>('/settings/sources/solver/test', { body: {} });
      setTest(r);
      if (r.view) queryClient.setQueryData(['solver'], r.view);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(null);
    }
  }

  const tone = v.state === 'ready' ? 'text-teal-hi' : v.state === 'off' ? 'text-muted' : v.state === 'starting' ? 'text-amber-hi' : 'text-warn';
  return (
    <Card className="flex flex-col gap-4">
      <div>
        <h2 className="m-0 text-lg font-semibold">Bot checks</h2>
        <p className="m-0 mt-1 max-w-[640px] text-sm text-muted">
          Gets past “checking your browser” pages in front of some sites.{' '}
          <InfoTip className="-my-3.5 align-middle" label="About bot checks">
            Some sites put a Cloudflare check in front of their search. With this on, Marquee solves it itself, only when a site needs it, and keeps the pass for later searches.
          </InfoTip>
        </p>
      </div>
      <label htmlFor="solver-on" className="inline-flex min-h-11 cursor-pointer items-center gap-3 text-body font-medium">
        <input id="solver-on" type="checkbox" checked={v.enabled} disabled={!!busy} onChange={(e) => save(e.target.checked)} className="size-5 accent-amber" />
        Solve bot checks
      </label>
      <p role="status" className={cx('m-0 text-sm', tone)}>
        {v.message}
      </p>
      {error && <Notice tone="error">{error}</Notice>}
      <details className="rounded-xl border border-line px-4 py-3" open={v.state === 'missing'}>
        <summary className="cursor-pointer text-sm font-medium text-soft">For experts</summary>
        <form
          className="mt-4 flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void save(v.enabled, String(new FormData(e.currentTarget).get('solverUrl') ?? '').trim() || null);
          }}
        >
          <Field
            label="Use another solver"
            id="solver-url"
            name="solverUrl"
            defaultValue={v.url ?? ''}
            placeholder="http://192.168.1.100:8191"
            hint={`Any FlareSolverr-compatible solver (FlareSolverr, Byparr…). Leave blank to use the one inside Marquee${v.bundled ? '' : ' (not in this install)'}.`}
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" variant="ghost" disabled={!!busy}>
              Save
            </Button>
            <Button type="button" variant="ghost" disabled={!!busy || !v.enabled} onClick={runTest}>
              {busy === 'test' ? 'Testing… (starting it can take a minute)' : 'Test'}
            </Button>
            {test && (
              <span role="status" className={cx('text-sm', test.ok ? 'text-teal-hi' : 'text-warn')}>
                {test.message}
              </span>
            )}
          </div>
        </form>
      </details>
    </Card>
  );
}
