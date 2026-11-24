import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { NameCheckView, OwnRuleMatch, OwnRulesView, OwnRuleView, ProfileKind, ProfilesView, RuleUpdatesView } from '@marquee/shared';
import { ApiFailure, api, queryClient } from '../api';
import { Button, Card, Notice, cx } from './ui';

/**
 * The Quality page's tools around the profiles: the note about the move to
 * Dictionarry, rule updates (Profilarr's job), your own rules, and "Try a
 * name" (paste a copy's name and see how a profile judges it).
 */

const errMsg = (e: unknown) => (e instanceof ApiFailure ? e.message : 'Something went wrong.');
export const points = (n: number) => (n > 0 ? `+${n.toLocaleString()}` : n.toLocaleString().replace('-', '−'));
const day = (at: number) => new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const short = (sha: string) => sha.slice(0, 7);
const kindWord = (k: ProfileKind) => (k === 'movie' ? 'movies' : 'TV');
const refreshProfiles = () => Promise.all([queryClient.invalidateQueries({ queryKey: ['profiles'] }), queryClient.invalidateQueries({ queryKey: ['profile'] })]);

export function MovedToDictionarry({ notice }: { notice: NonNullable<ProfilesView['notice']> }) {
  const dismiss = useMutation({ mutationFn: () => api('/settings/profiles/notice/dismiss', { body: {} }), onSuccess: refreshProfiles });
  const list = (xs: { kind: ProfileKind; name: string }[]) => xs.map((x) => `${x.name} (${kindWord(x.kind)})`).join(', ');
  return (
    <div role="status" className="flex flex-wrap items-start justify-between gap-3 rounded-2xl border border-amber/40 bg-amber/10 px-5 py-4 text-sm text-soft">
      <div className="flex max-w-[70ch] flex-col gap-1.5">
        <strong className="text-text">Your built-in profiles now use Dictionarry’s rules</strong>
        {notice.changed.length > 0 && <span>Moved, since you’d never changed them: {list(notice.changed)}. They favour small x265 encodes that keep the picture.</span>}
        {notice.kept.length > 0 && <span>Left on TRaSH because you’d changed them: {list(notice.kept)}. Open one and press “Put back Dictionarry’s values” to move it too.</span>}
      </div>
      <Button variant="ghost" onClick={() => dismiss.mutate()} disabled={dismiss.isPending}>
        Got it
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------- rule updates

export function RuleUpdates() {
  const q = useQuery({ queryKey: ['rule-updates'], queryFn: () => api<RuleUpdatesView>('/settings/profiles/updates') });
  const [open, setOpen] = useState(false);
  const done = async (v: RuleUpdatesView) => {
    queryClient.setQueryData(['rule-updates'], v);
    await refreshProfiles();
  };
  const check = useMutation({ mutationFn: () => api<RuleUpdatesView>('/settings/profiles/updates/check', { body: {} }), onSuccess: done });
  const apply = useMutation({ mutationFn: () => api<RuleUpdatesView>('/settings/profiles/updates/apply', { body: {} }), onSuccess: done });
  if (!q.data) return q.error ? <Notice tone="error">{errMsg(q.error)}</Notice> : null;
  const v = q.data;
  const p = v.pending;
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="m-0 text-heading font-semibold">Rule updates</h2>
          <span className="text-label text-muted">
            Dictionarry from {v.current.fetchedAt} ({short(v.current.commit)}){v.current.shipped ? ', as this version of Marquee came' : ''}. Checked once a week; nothing changes until you apply it.
          </span>
          {v.lastCheck && (
            <span className={cx('text-label', v.lastCheck.ok ? 'text-muted' : 'text-warn')}>
              Last checked {day(v.lastCheck.at)}: {v.lastCheck.message}
            </span>
          )}
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => check.mutate()} disabled={check.isPending}>
            {check.isPending ? 'Checking…' : 'Check now'}
          </Button>
          {p && (
            <Button onClick={() => apply.mutate()} disabled={apply.isPending}>
              {apply.isPending ? 'Applying…' : 'Apply update'}
            </Button>
          )}
        </div>
      </div>
      {check.error && <Notice tone="error">{errMsg(check.error)}</Notice>}
      {apply.error && <Notice tone="error">{errMsg(apply.error)}</Notice>}
      {p && (
        <div className="flex flex-col gap-2 rounded-xl bg-raised px-4 py-3 text-sm">
          <span className="text-text">
            <strong>Ready:</strong> Dictionarry from {p.to.fetchedAt} ({short(p.to.commit)}): {p.summary}. Points you changed yourself are kept; where Dictionarry changed them too, the rule is flagged so you can choose.
          </span>
          <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="h-11 self-start font-medium text-amber">
            {open ? 'Hide what changes' : 'See what changes'}
          </button>
          {open && (
            <div className="flex flex-col gap-3">
              {p.profiles.map((pr) => (
                <div key={pr.id} className="flex flex-col gap-1">
                  <strong className="text-text">
                    {pr.name} ({kindWord(pr.kind)})
                  </strong>
                  <ul className="m-0 flex list-disc flex-col gap-0.5 pl-5 text-soft">
                    {pr.newPoints.slice(0, 12).map((x) => (
                      <li key={`p-${x.label}`}>
                        {x.label}: {points(x.from)} → {points(x.to)}
                      </li>
                    ))}
                    {pr.newPoints.length > 12 && <li>…and {pr.newPoints.length - 12} more new points</li>}
                    {pr.added.length > 0 && <li>New rules: {pr.added.join(', ')}</li>}
                    {pr.removed.length > 0 && <li>No longer counted: {pr.removed.join(', ')}</li>}
                    {pr.settings.map((s) => (
                      <li key={s}>{s}</li>
                    ))}
                    {pr.conflicts.map((c) => (
                      <li key={`c-${c.label}`} className="text-amber">
                        {c.label}: you have {c.yours}, Dictionarry now says {c.theirs}. Yours is kept and flagged.
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              {p.rules.map((r) =>
                r.added.length + r.removed.length + r.changed.length ? (
                  <div key={r.kind} className="text-soft">
                    <strong className="text-text">Rules for {kindWord(r.kind)}:</strong> {[r.changed.length ? `tests changed for ${r.changed.join(', ')}` : '', r.added.length ? `added ${r.added.join(', ')}` : '', r.removed.length ? `removed ${r.removed.join(', ')}` : ''].filter(Boolean).join('; ')}.
                  </div>
                ) : null,
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- your own rules

const MATCHES: { value: OwnRuleMatch; label: string; hint: string }[] = [
  { value: 'words', label: 'Words in the name', hint: 'Any of these words, separated by commas. “HC, hardcoded” or “IMAX”.' },
  { value: 'group', label: 'Made by a group', hint: 'Group names, separated by commas: the part after the last dash, like FLUX or NTb.' },
  { value: 'language', label: 'Has a language', hint: 'For example “prefer English audio”. A copy that names no language counts as English.' },
  { value: 'pattern', label: 'Pattern (for experts)', hint: 'A regular expression tested against the whole name, ignoring case.' },
];

interface OwnDraft {
  id: number | null;
  name: string;
  kind: ProfileKind | 'both';
  match: OwnRuleMatch;
  value: string;
  points: Record<number, number>;
}

const blank = (): OwnDraft => ({ id: null, name: '', kind: 'both', match: 'words', value: '', points: {} });

export function OwnRules({ view }: { view: ProfilesView }) {
  const q = useQuery({ queryKey: ['own-rules'], queryFn: () => api<OwnRulesView>('/settings/profiles/own-rules') });
  const [draft, setDraft] = useState<OwnDraft | null>(null);
  const done = async (v: OwnRulesView) => {
    queryClient.setQueryData(['own-rules'], v);
    setDraft(null);
    await refreshProfiles();
  };
  const save = useMutation({
    mutationFn: (d: OwnDraft) =>
      api<OwnRulesView>(d.id ? `/settings/profiles/own-rules/${d.id}` : '/settings/profiles/own-rules', {
        method: d.id ? 'PUT' : 'POST',
        body: { name: d.name, kind: d.kind, match: d.match, value: d.value, points: Object.fromEntries(Object.entries(d.points).filter(([, n]) => n !== 0)) },
      }),
    onSuccess: done,
  });
  const remove = useMutation({ mutationFn: (id: number) => api<OwnRulesView>(`/settings/profiles/own-rules/${id}`, { method: 'DELETE' }), onSuccess: done });
  const profileName = (id: number) => view.profiles.find((p) => p.id === id);
  const edit = (r: OwnRuleView) => setDraft({ id: r.id, name: r.name, kind: r.kind, match: r.match, value: r.value, points: r.points });

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="m-0 text-heading font-semibold">Your own rules</h2>
          <span className="text-label text-muted">Words, groups or a language in a copy’s name, with points in the profiles you choose. They count alongside the database’s rules.</span>
        </div>
        {!draft && (
          <Button variant="ghost" onClick={() => setDraft(blank())}>
            Add a rule
          </Button>
        )}
      </div>
      {q.error && <Notice tone="error">{errMsg(q.error)}</Notice>}
      {q.data && q.data.rules.length === 0 && !draft && <p className="m-0 text-sm text-muted">None yet. “Prefer English audio” or “never take hardcoded subtitles” are common ones.</p>}
      {q.data && q.data.rules.length > 0 && (
        <ul className="m-0 flex list-none flex-col p-0">
          {q.data.rules.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 border-t border-line py-2">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-text">{r.name}</div>
                <div className="text-label text-muted">{r.description}</div>
                <div className="text-label text-dim">
                  {Object.keys(r.points).length
                    ? Object.entries(r.points)
                        .map(([id, n]) => {
                          const p = profileName(Number(id));
                          return p ? `${p.name} (${kindWord(p.kind)}) ${points(n)}` : null;
                        })
                        .filter(Boolean)
                        .join(' · ')
                    : 'Not counted in any profile yet'}
                </div>
              </div>
              <div className="flex gap-2">
                <Button variant="ghost" onClick={() => edit(r)}>
                  Edit
                </Button>
                <Button variant="danger" disabled={remove.isPending} onClick={() => window.confirm(`Delete “${r.name}”? It’s taken out of every profile.`) && remove.mutate(r.id)}>
                  Delete
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {draft && <OwnRuleForm draft={draft} setDraft={setDraft} view={view} languages={q.data?.languages ?? []} onSave={() => save.mutate(draft)} saving={save.isPending} error={save.error} />}
    </Card>
  );
}

function OwnRuleForm(props: { draft: OwnDraft; setDraft: (d: OwnDraft | null) => void; view: ProfilesView; languages: string[]; onSave: () => void; saving: boolean; error: unknown }) {
  const { draft, setDraft, view } = props;
  const set = (c: Partial<OwnDraft>) => setDraft({ ...draft, ...c });
  const match = MATCHES.find((m) => m.value === draft.match)!;
  const profiles = view.profiles.filter((p) => draft.kind === 'both' || p.kind === draft.kind);
  const input = 'h-11 rounded-lg border border-line-strong bg-ink px-3 text-sm text-text focus:border-amber focus:outline-none';
  return (
    <form
      className="flex flex-col gap-3 rounded-xl border border-dashed border-line-strong p-4"
      onSubmit={(e) => {
        e.preventDefault();
        props.onSave();
      }}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5 text-label text-muted">
          Name
          <input required maxLength={80} value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder="Prefer English audio" className={input} />
        </label>
        <label className="flex flex-col gap-1.5 text-label text-muted">
          For
          <select value={draft.kind} onChange={(e) => set({ kind: e.target.value as OwnDraft['kind'] })} className={input}>
            <option value="both">Movies and TV</option>
            <option value="movie">Movies</option>
            <option value="tv">TV</option>
          </select>
        </label>
        <label className="flex flex-col gap-1.5 text-label text-muted">
          Looks for
          <select value={draft.match} onChange={(e) => set({ match: e.target.value as OwnRuleMatch, value: e.target.value === 'language' ? 'English' : draft.match === 'language' ? '' : draft.value })} className={input}>
            {MATCHES.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5 text-label text-muted">
          {draft.match === 'language' ? 'Language' : draft.match === 'group' ? 'Groups' : draft.match === 'pattern' ? 'Pattern' : 'Words'}
          {draft.match === 'language' ? (
            <select value={draft.value} onChange={(e) => set({ value: e.target.value })} className={input}>
              {props.languages.map((l) => (
                <option key={l} value={l}>
                  {l === 'Original' ? 'The title’s own language' : l}
                </option>
              ))}
            </select>
          ) : (
            <input required value={draft.value} onChange={(e) => set({ value: e.target.value })} className={cx(input, draft.match === 'pattern' && 'font-mono')} />
          )}
        </label>
      </div>
      <p className="m-0 text-label text-dim">{match.hint}</p>
      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="mb-1 text-label text-muted">Points in each profile (0 leaves it out; −10,000 or less means never pick)</legend>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {profiles.map((p) => (
            <label key={p.id} className="flex items-center justify-between gap-3 text-sm text-soft">
              {p.name} <span className="text-dim">({kindWord(p.kind)})</span>
              <input
                type="number"
                step={50}
                value={draft.points[p.id] ?? 0}
                onChange={(e) => set({ points: { ...draft.points, [p.id]: Math.round(Number(e.target.value) || 0) } })}
                aria-label={`Points in ${p.name} for ${kindWord(p.kind)}`}
                className="ml-auto h-10 w-[120px] rounded-lg border border-line-strong bg-raised px-2.5 text-right text-sm text-text"
              />
            </label>
          ))}
        </div>
      </fieldset>
      {props.error != null && <Notice tone="error">{errMsg(props.error)}</Notice>}
      <div className="flex gap-2">
        <Button type="submit" disabled={props.saving || !draft.name.trim() || !draft.value.trim()}>
          {props.saving ? 'Saving…' : draft.id ? 'Save rule' : 'Add rule'}
        </Button>
        <Button type="button" variant="ghost" onClick={() => setDraft(null)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- try a name

export function TryName({ profileId, profileName }: { profileId: number; profileName: string }) {
  const [name, setName] = useState('');
  const run = useMutation({ mutationFn: (n: string) => api<NameCheckView>(`/settings/profiles/${profileId}/try`, { body: { name: n } }) });
  const r = run.data;
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="m-0 text-heading font-semibold">Try a name</h2>
        <span className="text-label text-muted">Paste a copy’s name to see how {profileName} judges it: each rule’s points, and whether it would be taken.</span>
      </div>
      {/* Not a form: it sits inside the profile's own form. Enter checks the name. */}
      <div role="group" aria-label="Try a name" className="flex flex-wrap gap-2">
        <label className="sr-only" htmlFor={`try-${profileId}`}>
          Copy name
        </label>
        <input
          id={`try-${profileId}`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            if (name.trim()) run.mutate(name.trim());
          }}
          placeholder="Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX"
          className="h-11 min-w-0 flex-[1_1_320px] rounded-lg border border-line-strong bg-raised px-3 font-mono text-sm text-text placeholder:text-dim focus:border-amber focus:outline-none"
        />
        <Button type="button" variant="ghost" disabled={!name.trim() || run.isPending} onClick={() => run.mutate(name.trim())}>
          {run.isPending ? 'Checking…' : 'Check'}
        </Button>
      </div>
      {run.error && <Notice tone="error">{errMsg(run.error)}</Notice>}
      {r && (
        <div className="flex flex-col gap-3" aria-live="polite">
          <div className={cx('rounded-xl px-4 py-3 text-sm', r.taken ? 'bg-teal/12 text-teal-hi' : 'bg-warn/12 text-warn')}>
            <strong>{r.taken ? `${profileName} would take it` : `${profileName} wouldn’t take it`}</strong> · {points(r.score)} points
            {r.reasons.length > 0 && (
              <ul className="m-0 mt-1 list-disc pl-5">
                {r.reasons.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            )}
          </div>
          <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted">Quality</dt>
            <dd className="m-0 text-text">
              {r.qualityLabel}
              {r.tier ? ` · in “${r.tier}”${r.tierAllowed ? '' : ', which it doesn’t take'}` : ''}
            </dd>
            <dt className="text-muted">Read as</dt>
            <dd className="m-0 text-text">
              {[r.details.title, r.details.year, r.details.group && `by ${r.details.group}`, r.details.codec, r.details.hdr.join(' '), r.details.audio, r.details.service].filter(Boolean).join(' · ')}
            </dd>
          </dl>
          {r.rules.length > 0 ? (
            <ul className="m-0 flex list-none flex-col p-0">
              {r.rules.map((x) => (
                <li key={x.trashId} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 border-t border-line py-1.5 text-sm">
                  <span>
                    <span className="font-semibold text-text">{x.label}</span> <span className="text-xs text-dim">{x.name}</span>
                    {x.explain && <span className="block text-label text-muted">{x.explain}</span>}
                  </span>
                  <span className={cx('font-semibold', x.points < 0 ? 'text-warn' : 'text-teal-hi')}>{points(x.points)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="m-0 text-sm text-muted">No rule in {profileName} matches this name.</p>
          )}
        </div>
      )}
    </Card>
  );
}
