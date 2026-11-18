import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { ProfileChangeView, ProfileChoiceView, ProfileChoicesView, ProfileKind, ProfilesView } from '@marquee/shared';
import { ApiFailure, api, queryClient } from '../api';
import { Button, Card, Notice, cx } from './ui';

/**
 * "Which profile a title gets": rules on genre and age rating, checked in
 * order, first match wins, else the library default. Profiles picked by hand
 * on a title's page are never changed.
 */

const errMsg = (e: unknown) => (e instanceof ApiFailure ? e.message : 'Something went wrong.');

function Picks({ label, all, picked, onChange }: { label: string; all: string[]; picked: string[]; onChange: (v: string[]) => void }) {
  const left = all.filter((x) => !picked.includes(x));
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {picked.length === 0 && <span className="text-sm text-dim">any {label}</span>}
      {picked.map((p) => (
        <button
          key={p}
          type="button"
          aria-label={`Remove ${p}`}
          onClick={() => onChange(picked.filter((x) => x !== p))}
          className="inline-flex h-9 items-center gap-1.5 rounded-full border border-line-strong bg-raised px-3 text-[13px] text-text hover:border-warn"
        >
          {p} <span aria-hidden="true" className="text-dim">×</span>
        </button>
      ))}
      {left.length > 0 && (
        <select
          aria-label={`Add a ${label}`}
          value=""
          onChange={(e) => e.target.value && onChange([...picked, e.target.value])}
          className="h-9 rounded-full border border-dashed border-line-strong bg-transparent px-2.5 text-[13px] text-muted"
        >
          <option value="">+ {label}</option>
          {left.map((x) => (
            <option key={x} value={x}>
              {x}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

export function ProfileChoices({ kind, view }: { kind: ProfileKind; view: ProfilesView }) {
  const q = useQuery({ queryKey: ['profile-choices'], queryFn: () => api<ProfileChoicesView>('/settings/profiles/choices') });
  const [draft, setDraft] = useState<ProfileChoiceView[] | null>(null);
  const [changes, setChanges] = useState<ProfileChangeView[] | null>(null);
  const [done, setDone] = useState<string | null>(null);
  useEffect(() => {
    if (q.data) setDraft(q.data.rules[kind]);
    setChanges(null);
    setDone(null);
  }, [q.data, kind]);

  const profiles = view.profiles.filter((p) => p.kind === kind);
  const name = (key: string) => profiles.find((p) => p.key === key)?.name ?? key;
  const save = useMutation({
    mutationFn: (rules: ProfileChoiceView[]) => api<{ rules: ProfileChoiceView[] }>(`/settings/profiles/choices/${kind}`, { method: 'PUT', body: { rules } }),
    onSuccess: async () => {
      setChanges(null);
      await queryClient.invalidateQueries({ queryKey: ['profile-choices'] });
    },
  });
  const preview = useMutation({
    mutationFn: () => api<{ changes: ProfileChangeView[] }>(`/settings/profiles/choices/${kind}/preview`),
    onSuccess: (r) => {
      setDone(null);
      setChanges(r.changes);
    },
  });
  const apply = useMutation({
    mutationFn: () => api<{ changed: number }>(`/settings/profiles/choices/${kind}/apply`, { body: {} }),
    onSuccess: async (r) => {
      setChanges(null);
      setDone(`${r.changed} ${r.changed === 1 ? 'title' : 'titles'} moved.`);
      await queryClient.invalidateQueries({ queryKey: ['profiles'] });
      await queryClient.invalidateQueries({ queryKey: ['library'] });
    },
  });
  const setDefault = useMutation({
    mutationFn: (key: string) => api('/settings/profiles/defaults', { method: 'PUT', body: { [kind]: key } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['profiles'] }),
  });

  if (q.error) return <Notice tone="error">{errMsg(q.error)}</Notice>;
  if (!q.data || !draft) return null;
  const dirty = JSON.stringify(draft) !== JSON.stringify(q.data.rules[kind]);
  const edit = (i: number, change: Partial<ProfileChoiceView>) => setDraft(draft.map((r, j) => (j === i ? { ...r, ...change } : r)));
  const move = (i: number, by: -1 | 1) => {
    const next = [...draft];
    [next[i], next[i + by]] = [next[i + by]!, next[i]!];
    setDraft(next);
  };
  const what = kind === 'movie' ? 'movie' : 'show';

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="m-0 text-[17px] font-semibold">Which profile a new {what} gets</h2>
        <p className="m-0 text-[13px] text-muted">
          Picked by what kind of {what} it is, from TMDB’s genres and age rating. Checked from the top; the first rule that fits wins. A profile you pick on a {what}’s page always stays.
        </p>
      </div>
      <ol className="m-0 flex list-none flex-col gap-2 p-0">
        {draft.map((r, i) => (
          <li key={i} className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-line-strong bg-raised px-3 py-2.5">
            <span className="w-5 text-sm text-dim">{i + 1}</span>
            <span className="text-sm text-soft">If genre is</span>
            <Picks label="genre" all={q.data.genres[kind]} picked={r.genres} onChange={(genres) => edit(i, { genres })} />
            <span className="text-sm text-soft">and rated</span>
            <Picks label="rating" all={q.data.ratings[kind]} picked={r.ratings} onChange={(ratings) => edit(i, { ratings })} />
            <span className="text-sm text-soft">→</span>
            <select aria-label={`Profile for rule ${i + 1}`} value={r.profile} onChange={(e) => edit(i, { profile: e.target.value })} className="h-9 rounded-[10px] border border-line-strong bg-ink px-2.5 text-sm font-semibold text-text">
              {profiles.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.name}
                </option>
              ))}
            </select>
            <span className="ml-auto flex">
              <button type="button" aria-label={`Move rule ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)} className="size-11 rounded-lg text-soft disabled:opacity-30">
                ↑
              </button>
              <button type="button" aria-label={`Move rule ${i + 1} down`} disabled={i === draft.length - 1} onClick={() => move(i, 1)} className="size-11 rounded-lg text-soft disabled:opacity-30">
                ↓
              </button>
              <button type="button" aria-label={`Remove rule ${i + 1}`} onClick={() => setDraft(draft.filter((_, j) => j !== i))} className="size-11 rounded-lg text-warn">
                ×
              </button>
            </span>
          </li>
        ))}
        <li className="flex flex-wrap items-center gap-3 rounded-xl border border-line px-3 py-2.5">
          <span className="w-5" />
          <span className="text-sm text-soft">Everything else →</span>
          <select
            aria-label={`Profile for every other ${what}`}
            value={view.defaults[kind]}
            disabled={setDefault.isPending}
            onChange={(e) => setDefault.mutate(e.target.value)}
            className="h-9 rounded-[10px] border border-line-strong bg-ink px-2.5 text-sm font-semibold text-text"
          >
            {profiles.map((p) => (
              <option key={p.key} value={p.key}>
                {p.name}
              </option>
            ))}
          </select>
        </li>
      </ol>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="ghost" onClick={() => setDraft([...draft, { profile: profiles[0]?.key ?? '', genres: [], ratings: [] }])}>
          Add a rule
        </Button>
        {dirty && (
          <Button type="button" disabled={save.isPending} onClick={() => save.mutate(draft)}>
            {save.isPending ? 'Saving…' : 'Save rules'}
          </Button>
        )}
        <Button type="button" variant="ghost" disabled={dirty || preview.isPending} onClick={() => preview.mutate()} title={dirty ? 'Save the rules first' : undefined}>
          Sort my library by these rules…
        </Button>
      </div>
      {save.error && <Notice tone="error">{errMsg(save.error)}</Notice>}
      {setDefault.error && <Notice tone="error">{errMsg(setDefault.error)}</Notice>}
      {(preview.error || apply.error) && <Notice tone="error">{errMsg(preview.error ?? apply.error)}</Notice>}
      {done && <Notice tone="success">{done}</Notice>}
      {changes && (
        <div className="flex flex-col gap-3 rounded-xl border border-line-strong p-4">
          {changes.length === 0 ? (
            <p className="m-0 text-sm text-soft">Every {what} already has the profile these rules pick. Nothing to change.</p>
          ) : (
            <>
              <p className="m-0 text-sm text-soft">
                These {changes.length} {changes.length === 1 ? what : `${what}s`} would move. {what === 'movie' ? 'Movies' : 'Shows'} you picked a profile for yourself aren’t listed and won’t change.
              </p>
              <ul className={cx('m-0 flex list-none flex-col p-0 text-sm', changes.length > 12 && 'max-h-[360px] overflow-y-auto')}>
                {changes.map((c) => (
                  <li key={c.id} className="flex flex-wrap gap-x-3 border-t border-line py-1.5">
                    <span className="min-w-[180px] flex-1">
                      {c.title} {c.year && <span className="text-dim">({c.year})</span>}
                    </span>
                    <span className="text-muted">
                      {name(c.from)} → <span className="font-semibold text-text">{name(c.to)}</span>
                    </span>
                    <span className="w-[90px] text-right text-xs text-dim">{c.rule ? `rule ${c.rule}` : 'everything else'}</span>
                  </li>
                ))}
              </ul>
              <div className="flex gap-2">
                <Button type="button" disabled={apply.isPending} onClick={() => apply.mutate()}>
                  {apply.isPending ? 'Moving…' : `Move ${changes.length}`}
                </Button>
                <Button type="button" variant="ghost" onClick={() => setChanges(null)}>
                  Cancel
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </Card>
  );
}
