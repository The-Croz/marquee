import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { CollectionView, ListItemView, ListsView, ListView, ProfilesView, SessionUser, ShowPreset } from '@marquee/shared';
import { ApiFailure, api, queryClient } from '../api';
import { Poster } from '../components/Poster';
import { Button, Card, Notice, Switch, cx } from '../components/ui';
import { PageHeader } from '../components/Page';

/** Movie collections, Settings → Lists, and a show's "which episodes" choice. */

const errMsg = (e: unknown) => (e instanceof ApiFailure ? e.message : 'Something went wrong.');
const when = (ms: number) => new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export const SHOW_PRESETS: { value: ShowPreset; label: string; explain: string }[] = [
  { value: 'all', label: 'Every episode', explain: 'Every season, and new ones as they come.' },
  { value: 'future', label: 'Only new episodes', explain: 'Nothing that’s already aired; every episode from now on.' },
  { value: 'latest', label: 'The latest season', explain: 'The newest season, and new ones as they come.' },
  { value: 'first', label: 'The first season', explain: 'Season 1 only, to try it out.' },
  { value: 'none', label: 'Nothing for now', explain: 'Added, but not looked for.' },
];

export function ShowPresetSelect({ id, value, onChange, withNone = true, className }: { id: string; value: ShowPreset; onChange: (v: ShowPreset) => void; withNone?: boolean; className?: string }) {
  return (
    <label htmlFor={id} className={cx('flex flex-col gap-1 text-label text-muted', className)}>
      Which episodes
      <select id={id} value={value} onChange={(e) => onChange(e.target.value as ShowPreset)} className="h-11 rounded-lg border border-line-strong bg-panel px-2.5 text-sm text-text">
        {SHOW_PRESETS.filter((p) => withNone || p.value !== 'none').map((p) => (
          <option key={p.value} value={p.value}>
            {p.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** On a show's page: change which episodes are wanted in one go. */
export function ShowEpisodesChoice({ showId }: { showId: number }) {
  const [value, setValue] = useState<ShowPreset | ''>('');
  const set = useMutation({
    mutationFn: (preset: ShowPreset) => api<{ wanted: number }>(`/shows/${showId}/episodes-wanted`, { method: 'PUT', body: { preset } }),
    onSuccess: () => queryClient.invalidateQueries(),
  });
  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="flex flex-col gap-1 text-label text-muted">
        Which episodes to want
        <select value={value} onChange={(e) => setValue(e.target.value as ShowPreset)} className="h-11 rounded-lg border border-line-strong bg-panel px-2.5 text-sm text-text">
          <option value="">Choose…</option>
          {SHOW_PRESETS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      <Button variant="ghost" disabled={!value || set.isPending} onClick={() => value && set.mutate(value)}>
        Apply
      </Button>
      {set.data && <span className="text-label text-muted">{set.data.wanted} episodes wanted.</span>}
      {set.error && <Notice tone="error">{errMsg(set.error)}</Notice>}
    </div>
  );
}

// ---------------------------------------------------------------- collection page

export function CollectionPage({ user }: { user: SessionUser }) {
  const { id } = useParams();
  const q = useQuery({ queryKey: ['collection', id], queryFn: () => api<CollectionView>(`/collections/${id}`) });
  const done = (v: CollectionView) => queryClient.setQueryData(['collection', id], v);
  const want = useMutation({ mutationFn: () => api<CollectionView & { added: number }>(`/collections/${id}/want`, { body: { followNew: true } }), onSuccess: done });
  const stop = useMutation({ mutationFn: () => api<CollectionView>(`/collections/${id}/stop`, { body: {} }), onSuccess: done });
  if (q.error) return <Notice tone="error">{errMsg(q.error)}</Notice>;
  if (!q.data) return <p className="text-muted">Loading…</p>;
  const c = q.data;
  const have = c.parts.filter((p) => p.have).length;
  return (
    <>
      <PageHeader title={c.name} />
      <p className="m-0 max-w-[72ch] text-sm text-soft">{c.overview}</p>
      <p className="m-0 text-sm text-muted">
        {have} of {c.parts.length} in your library{c.wanted ? ' · new films in it are added as Wanted' : ''}.
      </p>
      {user.role === 'admin' && (
        <div className="flex flex-wrap gap-2">
          {!c.wanted ? (
            <Button onClick={() => want.mutate()} disabled={want.isPending}>
              {want.isPending ? 'Adding…' : 'Want the whole collection'}
            </Button>
          ) : (
            <Button variant="ghost" onClick={() => stop.mutate()} disabled={stop.isPending}>
              Stop adding new films
            </Button>
          )}
          {want.data && <Notice tone="success">Added {want.data.added} and marked them Wanted. New films in it will be added too.</Notice>}
        </div>
      )}
      {(want.error || stop.error) && <Notice tone="error">{errMsg(want.error ?? stop.error)}</Notice>}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-x-[18px] gap-y-7">
        {c.parts.map((p) => (
          <Link key={p.tmdbId} to={p.libraryId ? `/movies/${p.libraryId}` : `/discover/movie/${p.tmdbId}`} className="flex flex-col gap-2 text-text no-underline">
            <Poster title={p.title} path={p.posterPath} />
            <span className="text-sm font-semibold">{p.title}</span>
            <span className="text-xs text-muted">
              {p.year ?? '—'} · {p.have ? 'In your library' : p.wanted ? 'Wanted' : p.released ? 'Not here' : 'Not out yet'}
            </span>
          </Link>
        ))}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- Settings → Lists

const KIND_NAME = { trakt: 'Trakt', imdb: 'IMDb', letterboxd: 'Letterboxd', plex_watchlist: 'Plex watchlist' } as const;

function ListStatus({ l }: { l: ListView }) {
  return (
    <span className={cx('text-label', l.lastOk === false ? 'text-warn' : 'text-muted')}>
      {l.lastSyncAt ? `Read ${when(l.lastSyncAt)}: ${l.lastMessage}` : 'Not read yet.'} {l.seen ? `${l.added} of ${l.seen} added so far.` : ''}
    </span>
  );
}

function Items({ id }: { id: number }) {
  const q = useQuery({ queryKey: ['list-items', id], queryFn: () => api<{ items: ListItemView[] }>(`/lists/${id}/items`) });
  const exclude = useMutation({
    mutationFn: (i: ListItemView) => api<ListsView>('/lists/exclusions', { body: { kind: i.kind, tmdbId: i.tmdbId, title: i.title, year: i.year } }),
    onSuccess: (v) => queryClient.setQueryData(['lists'], v),
  });
  if (!q.data) return null;
  if (!q.data.items.length) return <p className="m-0 text-sm text-muted">Nothing seen on it yet.</p>;
  return (
    <ul className="m-0 flex list-none flex-col p-0">
      {q.data.items.map((i) => (
        <li key={`${i.kind}-${i.tmdbId}`} className="flex flex-wrap items-center justify-between gap-2 border-t border-line py-1.5 text-sm">
          <span>
            {i.title} {i.year ? `(${i.year})` : ''} <span className="text-muted">· {i.outcomeText}</span>
          </span>
          {i.outcome !== 'excluded' && (
            <button type="button" onClick={() => exclude.mutate(i)} className="h-11 text-label text-amber">
              Never add from lists
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

function ListRow({ l, profiles }: { l: ListView; profiles: ProfilesView | undefined }) {
  const [open, setOpen] = useState(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['lists'] });
  const sync = useMutation({ mutationFn: () => api<ListView>(`/lists/${l.id}/sync`, { body: {} }), onSuccess: refresh });
  const patch = useMutation({ mutationFn: (b: Partial<ListView>) => api<ListView>(`/lists/${l.id}`, { method: 'PATCH', body: b }), onSuccess: refresh });
  const remove = useMutation({ mutationFn: () => api(`/lists/${l.id}`, { method: 'DELETE' }), onSuccess: refresh });
  return (
    <li className="flex flex-col gap-2 border-t border-line py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <strong className="text-sm text-text">
            {l.name} <span className="font-normal text-dim">· {KIND_NAME[l.kind]}</span>
          </strong>
          <ListStatus l={l} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Switch checked={l.enabled} onChange={(on) => patch.mutate({ enabled: on })} label={`Follow ${l.name}`} />
          <Button variant="ghost" onClick={() => sync.mutate()} disabled={sync.isPending}>
            {sync.isPending ? 'Reading…' : 'Read now'}
          </Button>
          <Button variant="ghost" onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? 'Hide' : 'What it added'}
          </Button>
          <Button variant="danger" onClick={() => window.confirm(`Stop following ${l.name}? Nothing it added is removed.`) && remove.mutate()}>
            Stop following
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap gap-3">
        <label className="flex flex-col gap-1 text-label text-muted">
          Quality
          <select value={l.profile ?? ''} onChange={(e) => patch.mutate({ profile: e.target.value || null })} className="h-11 rounded-lg border border-line-strong bg-panel px-2.5 text-sm text-text">
            <option value="">Let the profile rules choose</option>
            {[...new Set(profiles?.profiles.map((p) => p.key))].map((k) => (
              <option key={k} value={k}>
                {profiles!.profiles.find((p) => p.key === k)!.name}
              </option>
            ))}
          </select>
        </label>
        <ShowPresetSelect id={`list-preset-${l.id}`} value={l.showPreset} onChange={(v) => patch.mutate({ showPreset: v })} />
      </div>
      {(sync.error || patch.error) && <Notice tone="error">{errMsg(sync.error ?? patch.error)}</Notice>}
      {open && <Items id={l.id} />}
    </li>
  );
}

export function ListsPage() {
  const q = useQuery({ queryKey: ['lists'], queryFn: () => api<ListsView>('/lists') });
  const profiles = useQuery({ queryKey: ['profiles'], queryFn: () => api<ProfilesView>('/settings/profiles') });
  const [kind, setKind] = useState<'trakt' | 'imdb' | 'letterboxd'>('trakt');
  const [url, setUrl] = useState('');
  const [key, setKey] = useState('');
  const set = (v: ListsView) => queryClient.setQueryData(['lists'], v);
  const add = useMutation({
    mutationFn: () => api<ListView>('/lists', { body: { kind, url } }),
    onSuccess: async () => {
      setUrl('');
      await queryClient.invalidateQueries({ queryKey: ['lists'] });
    },
  });
  const watch = useMutation({ mutationFn: (b: { userId: number; on: boolean }) => api<ListsView>(`/lists/watchlists/${b.userId}`, { method: 'PUT', body: { on: b.on } }), onSuccess: set });
  const saveKey = useMutation({ mutationFn: () => api<ListsView>('/lists/trakt-key', { method: 'PUT', body: { clientId: key } }), onSuccess: set });
  const unexclude = useMutation({ mutationFn: (x: { kind: string; tmdbId: number }) => api<ListsView>(`/lists/exclusions/${x.kind}/${x.tmdbId}`, { method: 'DELETE' }), onSuccess: set });
  if (q.error) return <Notice tone="error">{errMsg(q.error)}</Notice>;
  if (!q.data) return <p className="text-muted">Loading…</p>;
  const v = q.data;
  const input = 'h-11 rounded-lg border border-line-strong bg-ink px-3 text-sm text-text focus:border-amber focus:outline-none';
  return (
    <div className="flex flex-col gap-6">
      <Card className="flex flex-col gap-3">
        <h2 className="m-0 text-heading font-semibold">Plex watchlists</h2>
        <p className="m-0 text-label text-muted">
          What someone adds to their Plex watchlist becomes their request, approved as usual for their role. Marquee reads them every 15 minutes. Each person needs to sign in to Marquee with Plex once.
        </p>
        <ul className="m-0 flex list-none flex-col p-0">
          {v.people.map((p) => (
            <li key={p.userId} className="flex flex-col gap-1 border-t border-line py-2">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="text-sm text-text">
                  {p.name} <span className="text-dim">· {p.role}</span>
                </span>
                {p.plexLinked ? (
                  <Switch checked={!!p.watchlist?.enabled} onChange={(on) => watch.mutate({ userId: p.userId, on })} label={`Follow ${p.name}’s Plex watchlist`} />
                ) : (
                  <span className="text-label text-muted">Hasn’t linked Plex</span>
                )}
              </div>
              {p.watchlist && <ListStatus l={p.watchlist} />}
              {p.plexLinked && !p.canRead && <span className="text-label text-warn">Needs to sign in with Plex once before Marquee can read it.</span>}
            </li>
          ))}
        </ul>
        {watch.error && <Notice tone="error">{errMsg(watch.error)}</Notice>}
      </Card>

      <Card className="flex flex-col gap-3">
        <h2 className="m-0 text-heading font-semibold">Trakt, IMDb and Letterboxd lists</h2>
        <p className="m-0 text-label text-muted">New titles on these lists are added to your library as Wanted, every 6 hours. Taking one off the list later changes nothing; Marquee never removes anything.</p>
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate();
          }}
        >
          <label className="flex flex-col gap-1 text-label text-muted">
            Site
            <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} className={input}>
              <option value="trakt">Trakt</option>
              <option value="imdb">IMDb</option>
              <option value="letterboxd">Letterboxd</option>
            </select>
          </label>
          <label className="flex min-w-0 flex-[1_1_280px] flex-col gap-1 text-label text-muted">
            List address
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://letterboxd.com/you/list/family-night/" className={input} />
          </label>
          <Button type="submit" disabled={!url.trim() || add.isPending}>
            {add.isPending ? 'Reading…' : 'Follow it'}
          </Button>
        </form>
        {add.error && <Notice tone="error">{errMsg(add.error)}</Notice>}
        <ul className="m-0 flex list-none flex-col p-0">
          {v.lists.map((l) => (
            <ListRow key={l.id} l={l} profiles={profiles.data} />
          ))}
        </ul>
        <details className="border-t border-line pt-3">
          <summary className="min-h-11 cursor-pointer text-sm font-semibold">For experts: Trakt app key {v.traktKeySet ? '(set)' : '(not set)'}</summary>
          <p className="text-label text-muted">Trakt lists need a free app key: make an app at trakt.tv/oauth/applications and paste its Client ID.</p>
          <div className="flex flex-wrap gap-2">
            <input value={key} onChange={(e) => setKey(e.target.value)} aria-label="Trakt Client ID" className={cx(input, 'flex-[1_1_260px]')} />
            <Button variant="ghost" onClick={() => saveKey.mutate()} disabled={saveKey.isPending}>
              Save key
            </Button>
          </div>
        </details>
      </Card>

      <Card className="flex flex-col gap-3">
        <h2 className="m-0 text-heading font-semibold">Never added from lists</h2>
        {v.exclusions.length === 0 ? (
          <p className="m-0 text-sm text-muted">Nothing yet. Use “Never add from lists” on what a list added.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col p-0">
            {v.exclusions.map((x) => (
              <li key={`${x.kind}-${x.tmdbId}`} className="flex items-center justify-between gap-3 border-t border-line py-1.5 text-sm">
                {x.title} {x.year ? `(${x.year})` : ''}
                <button type="button" className="h-11 text-label text-amber" onClick={() => unexclude.mutate(x)}>
                  Allow again
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
