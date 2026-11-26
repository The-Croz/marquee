import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { TautulliImportView, UnwatchedView } from '@marquee/shared';
import { ApiFailure, api, queryClient } from '../api';
import { Poster } from './Poster';
import { Button, Card, Field, Notice, cx } from './ui';
import { PageHeader } from './Page';

/** Never watched (W16) and bringing in Tautulli's history (W5). */

const errMsg = (e: unknown) => (e instanceof ApiFailure ? e.message : 'Something went wrong.');
const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

export function UnwatchedPage() {
  const [kind, setKind] = useState<'movie' | 'series'>('movie');
  const [since, setSince] = useState<'never' | 'year'>('never');
  const q = useQuery({ queryKey: ['unwatched', kind, since], queryFn: () => api<UnwatchedView>(`/activity/unwatched?kind=${kind}&since=${since}`) });
  const chip = (on: boolean) => cx('h-11 rounded-full border px-4 text-sm font-medium', on ? 'border-amber bg-amber text-amber-ink' : 'border-line bg-panel text-soft hover:text-text');
  return (
    <>
      <PageHeader title="Not watched" back={{ to: '/library/care', label: 'Library care' }} info="Titles in your library nobody has watched, or not in the last year, from what Plex and Jellyfin say was played. Only a list: Marquee never deletes anything by itself." />
      <div className="flex flex-wrap gap-2">
        <button type="button" aria-pressed={kind === 'movie'} className={chip(kind === 'movie')} onClick={() => setKind('movie')}>
          Movies
        </button>
        <button type="button" aria-pressed={kind === 'series'} className={chip(kind === 'series')} onClick={() => setKind('series')}>
          Shows
        </button>
        <span className="w-4" />
        <button type="button" aria-pressed={since === 'never'} className={chip(since === 'never')} onClick={() => setSince('never')}>
          Never watched
        </button>
        <button type="button" aria-pressed={since === 'year'} className={chip(since === 'year')} onClick={() => setSince('year')}>
          Not in a year
        </button>
      </div>
      {q.error && <Notice tone="error">{errMsg(q.error)}</Notice>}
      {q.data?.note && <Notice>{q.data.note}</Notice>}
      {q.data && <p className="m-0 text-sm text-muted">{q.data.items.length} {kind === 'movie' ? 'movies' : 'shows'}.</p>}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-x-[18px] gap-y-7">
        {q.data?.items.map((i) => (
          <Link key={i.id} to={i.href} className="flex flex-col gap-2 text-text no-underline">
            <Poster title={i.title} path={i.posterPath} />
            <span className="text-sm font-semibold">{i.title}</span>
            <span className="text-xs text-muted">{i.lastPlayed ? `Last watched ${day(i.lastPlayed)}` : `Never watched · added ${day(i.addedAt)}`}</span>
          </Link>
        ))}
      </div>
    </>
  );
}

export function TautulliImport() {
  const q = useQuery({ queryKey: ['tautulli'], queryFn: () => api<TautulliImportView>('/activity/tautulli') });
  const [url, setUrl] = useState('');
  const [key, setKey] = useState('');
  const done = async (v: TautulliImportView) => {
    queryClient.setQueryData(['tautulli'], v);
    await queryClient.invalidateQueries({ queryKey: ['activity'] });
  };
  const run = useMutation({ mutationFn: () => api<TautulliImportView>('/activity/tautulli/import', { body: { url, apiKey: key } }), onSuccess: async (v) => ((setKey(''), await done(v))) });
  const undo = useMutation({ mutationFn: (at: number) => api<TautulliImportView>('/activity/tautulli/undo', { body: { at } }), onSuccess: done });
  return (
    <Card className="flex flex-col gap-3">
      <details>
        <summary className="min-h-11 cursor-pointer text-heading font-semibold">Bring in Tautulli’s history</summary>
        <p className="text-label text-muted">
          Once, before Tautulli goes: copies every play it recorded, so these pages reach further back than Plex’s own history. Plays Marquee already has aren’t added twice, and an import can be undone. The key is used for this and not kept.
        </p>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            run.mutate();
          }}
        >
          <Field label="Tautulli’s address" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://tautulli:8181" required />
          <Field label="API key" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} hint="Tautulli → Settings → Web Interface → API key." required />
          {run.error && <Notice tone="error">{errMsg(run.error)}</Notice>}
          <Button type="submit" className="self-start" disabled={run.isPending}>
            {run.isPending ? 'Bringing it in…' : 'Bring it in'}
          </Button>
        </form>
      </details>
      {q.data && q.data.imports.length > 0 && (
        <ul className="m-0 flex list-none flex-col p-0">
          {q.data.imports.map((i) => (
            <li key={i.at} className="flex flex-wrap items-center justify-between gap-3 border-t border-line py-2 text-sm">
              <span>
                {day(i.at)}: {i.added} plays added, {i.skipped} already here{i.undoneAt ? ` · undone ${day(i.undoneAt)}` : ''}
              </span>
              {!i.undoneAt && (
                <Button variant="ghost" onClick={() => window.confirm('Take these plays back out?') && undo.mutate(i.at)}>
                  Undo
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
