import { ProblemsList, RequestsLeft } from '../components/Family';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import type { DiscoverTitle, ProfilesView, RequestState, RequestView, SessionUser, ShowPreset } from '@marquee/shared';
import { SHOW_PRESETS } from './GettingIn';
import { api, ApiFailure, queryClient } from '../api';
import { Poster } from '../components/Poster';
import { Button, Card, Notice, cx } from '../components/ui';
import { PageHeader, Tabs } from '../components/Page';

const errMsg = (e: unknown) => (e instanceof ApiFailure ? e.message : 'Something went wrong. Try again.');
const refresh = () => Promise.all([queryClient.invalidateQueries({ queryKey: ['requests'] }), queryClient.invalidateQueries({ queryKey: ['discover'] }), queryClient.invalidateQueries({ queryKey: ['library'] })]);

export const STATE: Record<RequestState, { label: string; tone: string }> = {
  pending: { label: 'Waiting for OK', tone: 'bg-amber/16 text-amber-hi' },
  unreleased: { label: 'Not out yet', tone: 'bg-white/8 text-soft' },
  searching: { label: 'Searching…', tone: 'bg-blue/18 text-blue-hi' },
  looking: { label: 'Looking', tone: 'bg-blue/18 text-blue-hi' },
  downloading: { label: 'Downloading', tone: 'bg-blue/30 text-blue-hi' },
  ready: { label: 'Ready', tone: 'bg-teal/15 text-teal-hi' },
  declined: { label: 'Turned down', tone: 'bg-warn/15 text-warn' },
};

const QUICK = ['We already have it somewhere else.', 'Not right now. Ask again later.', 'This one isn’t for the kids.'];
const when = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const seasonsText = (s: number[] | null) => (s === null ? null : s.length === 1 ? `Season ${s[0]}` : `Seasons ${s.join(', ')}`);

/** Approve with a profile and (for shows) seasons. */
function ApprovePanel({ r, onDone }: { r: RequestView; onDone: () => void }) {
  const profiles = useQuery({ queryKey: ['profiles'], queryFn: () => api<ProfilesView>('/settings/profiles') });
  const title = useQuery({
    queryKey: ['discover', 'title', r.kind, String(r.tmdbId)],
    queryFn: () => api<DiscoverTitle>(`/discover/title/${r.kind}/${r.tmdbId}`),
    enabled: r.kind === 'series',
  });
  const [profile, setProfile] = useState('');
  const [seasons, setSeasons] = useState<Set<number> | null>(null);
  const [preset, setPreset] = useState<ShowPreset | 'asked'>('asked');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const all = title.data?.seasons.map((s) => s.season) ?? [];
  const chosen = seasons ?? new Set(r.seasons ?? all);
  const kindKey = r.kind === 'movie' ? 'movie' : 'tv';
  const options = (profiles.data?.profiles ?? []).filter((p) => p.kind === kindKey);

  async function approve() {
    setBusy(true);
    setError(null);
    try {
      const picked = r.kind === 'series' && seasons ? (seasons.size === all.length ? null : [...seasons]) : undefined;
      if (r.kind === 'series' && seasons && seasons.size === 0) throw new Error('Tick at least one season, or turn it down.');
      await api(`/requests/${r.id}/approve`, { body: { ...(profile ? { profile } : {}), ...(preset !== 'asked' ? { preset } : picked !== undefined ? { seasons: picked } : {}) } });
      await refresh();
      onDone();
    } catch (e) {
      setError(e instanceof Error && !(e instanceof ApiFailure) ? e.message : errMsg(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-line bg-ink/60 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor={`profile-${r.id}`} className="text-sm text-soft">
          Quality
        </label>
        <select id={`profile-${r.id}`} value={profile} onChange={(e) => setProfile(e.target.value)} className="h-11 rounded-xl border border-line bg-panel px-3 text-sm text-text">
          <option value="">Let the profile rules choose</option>
          {options.map((p) => (
            <option key={p.key} value={p.key}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      {r.kind === 'series' && (
        <label className="flex flex-wrap items-center gap-3 text-sm text-soft">
          Which episodes
          <select value={preset} onChange={(e) => setPreset(e.target.value as ShowPreset | 'asked')} className="h-11 rounded-xl border border-line bg-panel px-3 text-sm text-text">
            <option value="asked">The seasons ticked below</option>
            {SHOW_PRESETS.filter((p) => p.value !== 'none').map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {r.kind === 'series' && all.length > 0 && preset === 'asked' && (
        <fieldset className="m-0 flex flex-wrap gap-x-5 gap-y-1 border-0 p-0">
          <legend className="mb-1 text-sm text-soft">Seasons to get</legend>
          {all.map((n) => (
            <label key={n} className="flex min-h-11 items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-5 accent-amber"
                checked={chosen.has(n)}
                onChange={() => setSeasons(new Set(chosen.has(n) ? [...chosen].filter((x) => x !== n) : [...chosen, n]))}
              />
              Season {n}
            </label>
          ))}
        </fieldset>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      <div className="flex gap-2">
        <Button type="button" disabled={busy} onClick={approve}>
          {busy ? 'Approving…' : 'Approve and look for it'}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function DeclinePanel({ r, onDone }: { r: RequestView; onDone: (undo: boolean) => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function decline() {
    setBusy(true);
    try {
      await api(`/requests/${r.id}/decline`, { body: { reason } });
      await refresh();
      onDone(true);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-line bg-ink/60 p-4">
      <label htmlFor={`reason-${r.id}`} className="text-sm text-soft">
        Why? {r.requestedBy?.name ?? 'They'} will see this.
      </label>
      <input id={`reason-${r.id}`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} className="h-12 rounded-xl border border-line-strong bg-ink px-4 text-body text-text focus:border-amber focus:outline-none" />
      <div className="flex flex-wrap gap-2">
        {QUICK.map((q) => (
          <button key={q} type="button" onClick={() => setReason(q)} className="min-h-11 rounded-full border border-line-strong px-3.5 text-label text-soft hover:text-text">
            {q}
          </button>
        ))}
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="flex gap-2">
        <Button type="button" variant="danger" disabled={busy} onClick={decline}>
          Turn it down
        </Button>
        <Button type="button" variant="ghost" onClick={() => onDone(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function RequestRow({ r, admin }: { r: RequestView; admin: boolean }) {
  const [panel, setPanel] = useState<'approve' | 'decline' | null>(null);
  const [undo, setUndo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const st = STATE[r.state];
  const call = async (path: string, init?: { method?: string }) => {
    setError(null);
    try {
      await api(path, init?.method ? { method: init.method } : { body: {} });
      await refresh();
    } catch (e) {
      setError(errMsg(e));
    }
  };
  return (
    <li>
      <Card className="flex flex-col gap-3 p-4">
        <div className="flex gap-4">
          <Poster title={r.title} path={r.posterPath} className="w-[64px] flex-none rounded-lg" size="w185" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="flex flex-wrap items-baseline gap-x-3">
              <h3 className="m-0 text-heading font-semibold">
                <Link to={`/discover/${r.kind}/${r.tmdbId}`} className="text-text no-underline hover:text-amber">
                  {r.title}
                </Link>{' '}
                {r.year && <span className="text-sm font-normal text-muted">({r.year})</span>}
              </h3>
              <span className="text-xs text-dim">{r.kind === 'movie' ? 'Movie' : 'Show'}</span>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-label">
              <span className={cx('rounded-full px-2.5 py-1 font-semibold', st.tone)}>{st.label}</span>
              {seasonsText(r.seasons) && <span className="text-soft">{seasonsText(r.seasons)}</span>}
              {r.profile && <span className="text-soft">{r.profile}</span>}
            </div>
            <p className="m-0 text-sm text-muted">
              {admin && r.requestedBy ? `${r.requestedBy.name} asked ${when(r.createdAt)}. ` : `Asked ${when(r.createdAt)}. `}
              {r.state === 'declined' ? (r.reason ? `Turned down: ${r.reason}` : 'Turned down.') : r.state === 'pending' ? 'An admin will look at it.' : r.stateText}
              {r.decidedBy && r.state !== 'pending' && ` (${r.decidedBy})`}
            </p>
            {admin && r.searchNote && (
              <p className="m-0 text-sm text-soft">
                Last search, {when(r.searchNote.at)}: {r.searchNote.text}
              </p>
            )}
            {r.href && (
              <Link to={r.href} className="flex min-h-11 items-center self-start text-sm font-semibold">
                Open it →
              </Link>
            )}
          </div>
          <div className="flex flex-none flex-col items-end gap-2">
            {admin && r.state === 'pending' && !panel && (
              <>
                <Button type="button" className="h-11 px-4 text-sm" onClick={() => setPanel('approve')}>
                  Approve
                </Button>
                <Button type="button" variant="ghost" className="h-11 px-4 text-sm" onClick={() => setPanel('decline')}>
                  Turn down
                </Button>
              </>
            )}
            {!admin && r.state === 'pending' && (
              <Button type="button" variant="ghost" className="h-11 px-4 text-sm" onClick={() => call(`/requests/${r.id}`, { method: 'DELETE' })}>
                Take it back
              </Button>
            )}
            {admin && r.state !== 'pending' && (
              <>
                {r.state === 'declined' && (
                  <Button type="button" variant="ghost" className="h-11 px-4 text-sm" onClick={() => call(`/requests/${r.id}/reopen`)}>
                    Put back
                  </Button>
                )}
                <Button type="button" variant="ghost" className="h-11 px-4 text-sm" onClick={() => call(`/requests/${r.id}`, { method: 'DELETE' })}>
                  Remove
                </Button>
              </>
            )}
          </div>
        </div>
        {panel === 'approve' && <ApprovePanel r={r} onDone={() => setPanel(null)} />}
        {panel === 'decline' && (
          <DeclinePanel
            r={r}
            onDone={(did) => {
              setPanel(null);
              if (did) {
                setUndo(true);
                setTimeout(() => setUndo(false), 8000);
              }
            }}
          />
        )}
        {undo && (
          <div role="status" className="flex flex-wrap items-center gap-3 rounded-xl bg-raised px-4 py-2 text-sm">
            Turned down.
            <button type="button" className="min-h-11 font-semibold text-amber" onClick={() => call(`/requests/${r.id}/reopen`).then(() => setUndo(false))}>
              Undo
            </button>
          </div>
        )}
        {error && <Notice tone="error">{error}</Notice>}
      </Card>
    </li>
  );
}

/** Status filter groups, in plain words. */
const STATUS = {
  any: { label: 'Any status', match: () => true },
  pending: { label: 'Waiting for OK', match: (r: RequestView) => r.state === 'pending' },
  working: { label: 'On the way', match: (r: RequestView) => ['unreleased', 'searching', 'looking', 'downloading'].includes(r.state) },
  ready: { label: 'Ready', match: (r: RequestView) => r.state === 'ready' },
  declined: { label: 'Turned down', match: (r: RequestView) => r.state === 'declined' },
} as const;
const SORT = {
  newest: { label: 'Newest first', by: (a: RequestView, b: RequestView) => b.createdAt - a.createdAt },
  oldest: { label: 'Oldest first', by: (a: RequestView, b: RequestView) => a.createdAt - b.createdAt },
  answered: { label: 'Recently answered', by: (a: RequestView, b: RequestView) => (b.decidedAt ?? 0) - (a.decidedAt ?? 0) || b.createdAt - a.createdAt },
  title: { label: 'Title A–Z', by: (a: RequestView, b: RequestView) => a.title.localeCompare(b.title) },
} as const;
/** How far back "Recently answered" reaches under the waiting list, and how many it shows. */
const RECENT_DAYS = 14;
const RECENT_MAX = 10;

const selectClass = 'h-11 rounded-lg border border-line-strong bg-ink px-2.5 text-sm text-text';

export function RequestsPage({ user }: { user: SessionUser }) {
  const admin = user.role === 'admin';
  const [search] = useSearchParams();
  const [tab, setTab] = useState<'waiting' | 'all' | 'mine' | 'problems'>(search.get('tab') === 'problems' ? 'problems' : admin ? 'waiting' : 'mine');
  const [status, setStatus] = useState<keyof typeof STATUS>('any');
  const [kind, setKind] = useState<'any' | 'movie' | 'series'>('any');
  const [who, setWho] = useState<number | 'any'>('any');
  const [sort, setSort] = useState<keyof typeof SORT>('newest');
  const scope = tab === 'mine' ? 'mine' : 'all';
  const { data, isLoading, error } = useQuery({
    queryKey: ['requests', scope],
    queryFn: () => api<{ items: RequestView[] }>(`/requests?scope=${scope}`),
    refetchInterval: 30_000,
  });
  const everything = data?.items ?? [];
  const waiting = admin ? everything.filter((r) => r.state === 'pending').length : 0;
  const people = [...new Map(everything.flatMap((r) => (r.requestedBy ? [[r.requestedBy.id, r.requestedBy.name] as const] : []))).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const showWho = admin && tab !== 'mine' && people.length > 1;
  const filtered = everything.filter((r) => (kind === 'any' || r.kind === kind) && (!showWho || who === 'any' || r.requestedBy?.id === who));
  const items = filtered.filter(tab === 'waiting' ? STATUS.pending.match : STATUS[status].match).sort(SORT[sort].by);
  // Under the waiting list: what was answered lately, so the page isn't empty once everything's handled.
  const since = Date.now() - RECENT_DAYS * 86_400_000;
  const recent = tab === 'waiting' ? filtered.filter((r) => r.state !== 'pending' && (r.decidedAt ?? r.createdAt) >= since).sort(SORT.answered.by).slice(0, RECENT_MAX) : [];
  const filtering = kind !== 'any' || (showWho && who !== 'any') || (tab !== 'waiting' && status !== 'any');
  const tabs: [typeof tab, string][] = admin
    ? [['waiting', 'Waiting for you'], ['all', 'Everyone'], ['mine', 'Mine'], ['problems', 'Something wrong?']]
    : [['mine', 'My requests'], ['problems', 'Problems I reported']];
  const rowAdmin = admin && tab !== 'mine';

  return (
    <>
      <PageHeader
        title="Requests"
        info={admin ? 'Approve what the family asks for. Your own requests go straight through.' : 'Ask for a movie or show from Discover. An admin approves it, and you’ll hear when it’s ready.'}
      />
      <Tabs label="Requests" value={tab} onChange={setTab} items={tabs.map(([v, label]) => ({ value: v, label, count: v === 'waiting' && waiting > 0 ? waiting : undefined }))} />
      {!admin && <RequestsLeft />}
      {tab === 'problems' && <ProblemsList admin={admin} />}
      {tab !== 'problems' && (
        <>
          {everything.length > 1 && (
            <div role="group" aria-label="Sort and filter" className="flex flex-wrap items-center gap-2">
              {tab !== 'waiting' && (
                <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value as keyof typeof STATUS)} className={selectClass}>
                  {Object.entries(STATUS).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v.label}
                    </option>
                  ))}
                </select>
              )}
              <select aria-label="Movies or shows" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} className={selectClass}>
                <option value="any">Movies and shows</option>
                <option value="movie">Movies</option>
                <option value="series">Shows</option>
              </select>
              {showWho && (
                <select aria-label="Who asked" value={who} onChange={(e) => setWho(e.target.value === 'any' ? 'any' : Number(e.target.value))} className={selectClass}>
                  <option value="any">Everyone</option>
                  {people.map(([id, name]) => (
                    <option key={id} value={id}>
                      {name}
                    </option>
                  ))}
                </select>
              )}
              <label className="ml-auto flex items-center gap-2 text-label text-muted">
                Sort
                <select value={sort} onChange={(e) => setSort(e.target.value as keyof typeof SORT)} className={selectClass}>
                  {Object.entries(SORT).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v.label}
                    </option>
                  ))}
                </select>
              </label>
              {filtering && (
                <button
                  type="button"
                  onClick={() => {
                    setStatus('any');
                    setKind('any');
                    setWho('any');
                  }}
                  className="min-h-11 text-sm font-medium text-amber"
                >
                  Clear filters
                </button>
              )}
            </div>
          )}
          {error && <Notice tone="error">{errMsg(error)}</Notice>}
          {isLoading && <p className="text-muted">Loading…</p>}
          {data && items.length === 0 && (
            <Notice>
              {filtering ? 'Nothing matches these filters.' : tab === 'waiting' ? 'Nothing is waiting for you.' : 'No requests yet. Find something in Discover and press Request.'}
            </Notice>
          )}
          <ul className="m-0 flex list-none flex-col gap-3 p-0" hidden={items.length === 0}>
            {items.map((r) => (
              <RequestRow key={r.id} r={r} admin={rowAdmin} />
            ))}
          </ul>
          {recent.length > 0 && (
            <section aria-labelledby="recent-h" className="flex flex-col gap-3 border-t border-line pt-5">
              <h2 id="recent-h" className="m-0 text-xs font-normal tracking-[.08em] text-dim uppercase">
                Recently answered · last {RECENT_DAYS} days
              </h2>
              <ul className="m-0 flex list-none flex-col gap-3 p-0">
                {recent.map((r) => (
                  <RequestRow key={r.id} r={r} admin={rowAdmin} />
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </>
  );
}
