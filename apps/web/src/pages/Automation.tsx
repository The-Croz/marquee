import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import type { AutomationView, WantedRunView } from '@marquee/shared';
import { ApiFailure, api, queryClient } from '../api';
import { Button, Card, Notice, Switch, cx } from '../components/ui';

/** Settings → Automatic searching: Marquee looking for Wanted movies and episodes by itself. */

type Kind = 'movies' | 'tv';
type Look = WantedRunView['kind'];

const KEY = ['automation'];
const errMsg = (e: unknown) => (e instanceof ApiFailure ? e.message : 'Marquee couldn’t do that. Try again in a moment.');

const KINDS: Record<Kind, { title: string; when: string; looks: Look[]; noun: [string, string]; library: string }> = {
  movies: { title: 'Look for wanted movies', when: 'Missing ones every 6 hours, better copies once a day', looks: ['missing', 'better'], noun: ['movie', 'movies'], library: '/library/movies' },
  tv: { title: 'Look for wanted episodes', when: 'New ones every 30 minutes, missing every 6 hours, better copies once a day', looks: ['new', 'missing', 'better'], noun: ['show', 'shows'], library: '/library/shows' },
};

const LOOK_LABEL: Record<Look, string> = { new: 'New episodes', missing: 'Missing', better: 'Better copies' };

function when(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

function RunResult({ r, kind }: { r: WantedRunView; kind: Kind }) {
  const what = `${kind === 'movies' ? 'Movies' : 'TV'} · ${LOOK_LABEL[r.kind].toLowerCase()}`;
  return (
    <li className="flex flex-col gap-0.5 border-t border-line py-3 text-sm first:border-t-0">
      <div className="flex flex-wrap justify-between gap-x-4">
        <span className="text-text">{what}</span>
        <span className="text-dim">
          {when(r.at)} · {r.kind === 'new' ? `${r.searched} looked at` : `${r.searched} searched`} · {r.sent.length} sent{r.capped ? ' · stopped at the daily limit' : ''}
        </span>
      </div>
      {r.sent.map((s) => (
        <span key={s.title + s.copy} className="text-teal-hi">
          <Link to={s.href}>{s.title}</Link> <span className="font-mono text-xs text-dim">{s.copy}</span>
        </span>
      ))}
      {r.problems.map((p) => (
        <span key={p} className="text-warn">
          {p}
        </span>
      ))}
    </li>
  );
}

export function AutomationPage() {
  const q = useQuery({ queryKey: KEY, queryFn: () => api<AutomationView>('/automation') });
  const [limit, setLimit] = useState<string | null>(null);
  const [previewOnly, setPreviewOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ kind: Kind; run: WantedRunView } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }
  const save = (body: Partial<{ movies: boolean; tv: boolean; dailyLimit: number }>) =>
    act(async () => {
      queryClient.setQueryData(KEY, await api<AutomationView>('/automation', { method: 'PUT', body }));
    });
  const lookNow = (kind: Kind, look: Look) =>
    act(async () => {
      const run = await api<WantedRunView>(`/automation/${kind}/look-now`, { body: { kind: look, ...(previewOnly ? { preview: true } : {}) } });
      setResult({ kind, run });
      if (!previewOnly) await queryClient.invalidateQueries({ queryKey: KEY });
    });
  function saveLimit() {
    const n = Number(limit);
    if (limit === null || !Number.isInteger(n) || n < 0) return setError('The daily limit is a whole number, 0 or more.');
    setLimit(null);
    void save({ dailyLimit: n });
  }

  if (q.isLoading) return <p className="text-muted">Loading…</p>;
  if (q.error || !q.data) return <Notice tone="error">{errMsg(q.error)}</Notice>;
  const v = q.data;
  const runs = [...v.movies.runs.map((r) => ({ r, kind: 'movies' as const })), ...v.tv.runs.map((r) => ({ r, kind: 'tv' as const }))].sort((a, b) => b.r.at - a.r.at).slice(0, 8);

  return (
    <>
      {error && <Notice tone="error">{error}</Notice>}
      <Card aria-labelledby="auto-h" className="flex max-w-[760px] flex-col">
        <h2 id="auto-h" className="m-0 mb-2 text-lg font-semibold">
          Automatic searching
        </h2>
        {(['movies', 'tv'] as const).map((k) => {
          const kv = v[k];
          const t = KINDS[k];
          return (
            <div key={k} className="flex items-center gap-4 border-t border-line py-4">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span id={`auto-${k}`} className="text-body font-medium">
                  {t.title}
                </span>
                <span className="text-sm text-dim">
                  {t.when} ·{' '}
                  <Link to={t.library} className={cx(kv.wanted === 0 && kv.on ? 'text-amber' : 'text-muted')}>
                    {kv.wanted === 0 ? `No ${t.noun[1]} are Wanted yet` : `${kv.wanted} ${kv.wanted === 1 ? t.noun[0] : t.noun[1]} Wanted`}
                  </Link>
                </span>
              </div>
              <Switch checked={kv.on} label={t.title} disabled={busy} onChange={(on) => void save({ [k]: on })} />
            </div>
          );
        })}
        <div className="flex flex-wrap items-center gap-4 border-t border-line py-4">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <label htmlFor="daily-limit" className="text-body font-medium">
              Copies it sends by itself each day
            </label>
            <span className="text-sm text-dim">
              {v.sentToday} sent in the last 24 hours · 0 means no limit
            </span>
          </div>
          <div className="flex items-center gap-2">
            <input
              id="daily-limit"
              inputMode="numeric"
              value={limit ?? String(v.dailyLimit)}
              onChange={(e) => setLimit(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && saveLimit()}
              className="h-11 w-20 rounded-xl border border-line-strong bg-ink px-3 text-right text-text tabular-nums focus:border-amber focus:outline-none"
            />
            {limit !== null && limit !== String(v.dailyLimit) && (
              <Button type="button" className="h-11 px-4 text-sm" disabled={busy} onClick={saveLimit}>
                Save
              </Button>
            )}
          </div>
        </div>
      </Card>

      <Card aria-labelledby="look-h" className="flex max-w-[760px] flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="look-h" className="m-0 text-lg font-semibold">
            Look now
          </h2>
          <label className="flex items-center gap-1 text-sm text-soft">
            Preview only
            <Switch checked={previewOnly} label="Preview only: show what it would send, send nothing" onChange={setPreviewOnly} />
          </label>
        </div>
        {(['movies', 'tv'] as const).map((k) => (
          <div key={k} className="flex flex-wrap items-center gap-2">
            <span className="w-16 text-sm text-dim">{k === 'movies' ? 'Movies' : 'TV'}</span>
            {KINDS[k].looks.map((l) => (
              <Button key={l} type="button" variant="ghost" className="h-11 px-3.5 text-sm" disabled={busy} onClick={() => lookNow(k, l)}>
                {LOOK_LABEL[l]}
              </Button>
            ))}
          </div>
        ))}
        {result && (
          <div role="status" className="flex flex-col rounded-xl border border-line px-4 py-1">
            {result.run.preview && <strong className="pt-3 text-sm">Preview · nothing was sent</strong>}
            {result.run.sent.length === 0 && result.run.problems.length === 0 && <p className="m-0 py-3 text-sm text-soft">Nothing Wanted needs a copy right now.</p>}
            <ul className="m-0 list-none p-0">
              <RunResult r={result.run} kind={result.kind} />
            </ul>
          </div>
        )}
      </Card>

      {runs.length > 0 && (
        <Card aria-labelledby="runs-h" className="flex max-w-[760px] flex-col gap-1">
          <h2 id="runs-h" className="m-0 mb-1 text-lg font-semibold">
            Recent runs
          </h2>
          <ul className="m-0 list-none p-0">
            {runs.map(({ r, kind }) => (
              <RunResult key={`${kind}${r.kind}${r.at}`} r={r} kind={kind} />
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
