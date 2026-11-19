import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { ChoicesCheckView, ConditionField, ConditionOp, ConditionView, ProfileChangeView, ProfileChoiceView, ProfileChoicesView, ProfileKind, ProfilesView } from '@marquee/shared';
import { ApiFailure, api, queryClient } from '../api';
import { Button, Card, Notice, cx } from './ui';

/**
 * "Which profile a new title gets": rules made of conditions on what kind of
 * title it is (genre, age rating, year, studio or network, language,
 * keyword). Checked from the top; the first rule whose conditions all hold
 * wins; otherwise "everything else". Profiles picked by hand always stay.
 */

const errMsg = (e: unknown) => (e instanceof ApiFailure ? e.message : 'Something went wrong.');

const FIELDS: { field: ConditionField; label: (k: ProfileKind) => string }[] = [
  { field: 'genre', label: () => 'Genre' },
  { field: 'rating', label: () => 'Age rating' },
  { field: 'year', label: (k) => (k === 'movie' ? 'Released' : 'First aired') },
  { field: 'company', label: (k) => (k === 'movie' ? 'Studio' : 'Network or studio') },
  { field: 'language', label: () => 'Original language' },
  { field: 'keyword', label: () => 'Keyword' },
];
const fieldLabel = (f: ConditionField, k: ProfileKind) => FIELDS.find((x) => x.field === f)!.label(k);

const OPS: Record<Exclude<ConditionOp, 'between'>, string> = { any: 'is any of', all: 'is all of', none: 'is none of' };
const opsFor = (f: ConditionField): Exclude<ConditionOp, 'between'>[] => (f === 'genre' || f === 'keyword' ? ['any', 'all', 'none'] : ['any', 'none']);

/** "Animation or Family", "Animation and Family". */
const list = (xs: string[], word: 'or' | 'and') => (xs.length <= 1 ? (xs[0] ?? '…') : `${xs.slice(0, -1).join(', ')} ${word} ${xs[xs.length - 1]}`);

/** A condition in plain words, e.g. "genre is Animation or Family", "released 2009 or earlier". */
export function describe(c: ConditionView, kind: ProfileKind, languageNames: Record<string, string>): string {
  if (c.field === 'year') {
    const when = kind === 'movie' ? 'released' : 'first aired';
    if (c.min != null && c.max != null) return c.min === c.max ? `${when} in ${c.min}` : `${when} ${c.min}–${c.max}`;
    if (c.min != null) return `${when} ${c.min} or later`;
    if (c.max != null) return `${when} ${c.max} or earlier`;
    return `${when} any year`;
  }
  const values = (c.values ?? []).map((v) => (c.field === 'language' ? (languageNames[v] ?? v) : v));
  const what = { genre: 'genre', rating: 'rated', company: kind === 'movie' ? 'studio' : 'network or studio', language: 'in', keyword: 'keyword' }[c.field];
  if (c.field === 'rating') return c.op === 'none' ? `not rated ${list(values, 'or')}` : `rated ${list(values, 'or')}`;
  if (c.field === 'language') return c.op === 'none' ? `not originally in ${list(values, 'or')}` : `originally in ${list(values, 'or')}`;
  if (c.op === 'none') return `${what} isn’t ${list(values, 'or')}`;
  if (c.op === 'all') return `${what} includes ${list(values, 'and')}`;
  return `${what} is ${list(values, 'or')}`;
}

const sentence = (r: ProfileChoiceView, kind: ProfileKind, names: Record<string, string>) => {
  const s = r.conditions.map((c) => describe(c, kind, names)).join(', ');
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : 'No conditions yet';
};

const blank = (field: ConditionField): ConditionView => (field === 'year' ? { field, op: 'between', min: null, max: null } : { field, op: 'any', values: [] });

// ---------------------------------------------------------------- one condition

function Values({
  c,
  kind,
  data,
  onChange,
}: {
  c: ConditionView;
  kind: ProfileKind;
  data: ProfileChoicesView;
  onChange: (values: string[]) => void;
}) {
  const [typed, setTyped] = useState('');
  const picked = c.values ?? [];
  const nameOf = (v: string) => (c.field === 'language' ? (data.languageNames[v] ?? v) : v);
  const choices =
    c.field === 'genre' ? data.genres[kind] : c.field === 'rating' ? data.ratings[kind] : c.field === 'language' ? data.suggestions[kind].languages : null;
  const suggestions = c.field === 'company' ? data.suggestions[kind].companies : c.field === 'keyword' ? data.suggestions[kind].keywords : [];
  const listId = `suggest-${kind}-${c.field}`;
  const add = (v: string) => {
    const t = v.trim();
    if (t && !picked.some((p) => p.toLowerCase() === t.toLowerCase())) onChange([...picked, t]);
    setTyped('');
  };
  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
      {picked.map((p) => (
        <button
          key={p}
          type="button"
          aria-label={`Remove ${nameOf(p)}`}
          onClick={() => onChange(picked.filter((x) => x !== p))}
          className="inline-flex h-9 items-center gap-1.5 rounded-full border border-line-strong bg-ink px-3 text-label text-text hover:border-warn"
        >
          {nameOf(p)} <span aria-hidden="true" className="text-dim">×</span>
        </button>
      ))}
      {choices ? (
        <select
          aria-label={`Add a ${fieldLabel(c.field, kind).toLowerCase()}`}
          value=""
          onChange={(e) => e.target.value && add(e.target.value)}
          className="h-9 rounded-full border border-dashed border-line-strong bg-transparent px-2.5 text-label text-muted"
        >
          <option value="">+ add</option>
          {choices
            .filter((x) => !picked.includes(x))
            .map((x) => (
              <option key={x} value={x}>
                {nameOf(x)}
              </option>
            ))}
        </select>
      ) : (
        <>
          <input
            list={listId}
            value={typed}
            aria-label={`Add a ${fieldLabel(c.field, kind).toLowerCase()}`}
            placeholder={c.field === 'company' ? (kind === 'movie' ? 'Pixar, A24…' : 'HBO, Disney Junior…') : 'superhero, christmas…'}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                add(typed);
              }
            }}
            onBlur={() => typed && add(typed)}
            className="h-9 w-[190px] rounded-full border border-dashed border-line-strong bg-transparent px-3 text-label text-text placeholder:text-dim focus:border-amber focus:outline-none"
          />
          <datalist id={listId}>
            {suggestions.slice(0, 200).map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </>
      )}
    </div>
  );
}

function ConditionRow({ c, kind, data, onChange, onRemove }: { c: ConditionView; kind: ProfileKind; data: ProfileChoicesView; onChange: (c: ConditionView) => void; onRemove: () => void }) {
  const year = (v: string) => (v.trim() === '' ? null : Math.round(Number(v)) || null);
  return (
    <li className="flex flex-wrap items-center gap-2 border-t border-line py-2 first:border-t-0">
      <select
        aria-label="What to check"
        value={c.field}
        onChange={(e) => onChange(blank(e.target.value as ConditionField))}
        className="h-9 rounded-lg border border-line-strong bg-ink px-2 text-sm text-text"
      >
        {FIELDS.map((f) => (
          <option key={f.field} value={f.field}>
            {f.label(kind)}
          </option>
        ))}
      </select>
      {c.field === 'year' ? (
        <div className="flex flex-wrap items-center gap-2 text-sm text-soft">
          from
          <input
            type="number"
            inputMode="numeric"
            aria-label="From year"
            placeholder="any"
            value={c.min ?? ''}
            onChange={(e) => onChange({ ...c, min: year(e.target.value) })}
            className="h-9 w-[90px] rounded-lg border border-line-strong bg-ink px-2 text-right text-sm text-text placeholder:text-dim"
          />
          to
          <input
            type="number"
            inputMode="numeric"
            aria-label="To year"
            placeholder="any"
            value={c.max ?? ''}
            onChange={(e) => onChange({ ...c, max: year(e.target.value) })}
            className="h-9 w-[90px] rounded-lg border border-line-strong bg-ink px-2 text-right text-sm text-text placeholder:text-dim"
          />
        </div>
      ) : (
        <>
          <select
            aria-label="How to compare"
            value={c.op}
            onChange={(e) => onChange({ ...c, op: e.target.value as ConditionOp })}
            className="h-9 rounded-lg border border-line-strong bg-ink px-2 text-sm text-text"
          >
            {opsFor(c.field).map((o) => (
              <option key={o} value={o}>
                {OPS[o]}
              </option>
            ))}
          </select>
          <Values c={c} kind={kind} data={data} onChange={(values) => onChange({ ...c, values })} />
        </>
      )}
      <button type="button" aria-label="Remove this condition" onClick={onRemove} className="ml-auto size-11 rounded-lg text-warn">
        ×
      </button>
    </li>
  );
}

// ---------------------------------------------------------------- the card

export function ProfileChoices({ kind, view }: { kind: ProfileKind; view: ProfilesView }) {
  const q = useQuery({ queryKey: ['profile-choices'], queryFn: () => api<ProfileChoicesView>('/settings/profiles/choices') });
  const [draft, setDraft] = useState<ProfileChoiceView[] | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [changes, setChanges] = useState<ProfileChangeView[] | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [tryQuery, setTryQuery] = useState('');
  useEffect(() => {
    if (q.data) setDraft(q.data.rules[kind]);
    setOpen(null);
    setChanges(null);
    setDone(null);
    setTryQuery('');
  }, [q.data, kind]);

  // Counts and "try a title" follow the draft as you edit, a moment after you stop typing.
  const [checkKey, setCheckKey] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setCheckKey(JSON.stringify({ rules: draft ?? [], query: tryQuery })), 300);
    return () => clearTimeout(t);
  }, [draft, tryQuery]);
  const check = useQuery({
    queryKey: ['profile-choices-check', kind, checkKey],
    queryFn: () => api<ChoicesCheckView>(`/settings/profiles/choices/${kind}/check`, { body: JSON.parse(checkKey) }),
    enabled: !!checkKey,
    placeholderData: (prev) => prev,
  });

  const profiles = view.profiles.filter((p) => p.kind === kind);
  const name = (key: string) => profiles.find((p) => p.key === key)?.name ?? key;
  const save = useMutation({
    mutationFn: (rules: ProfileChoiceView[]) => api<{ rules: ProfileChoiceView[] }>(`/settings/profiles/choices/${kind}`, { method: 'PUT', body: { rules } }),
    onSuccess: async () => {
      setChanges(null);
      setOpen(null);
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
      await queryClient.invalidateQueries({ queryKey: ['profile-choices-check'] });
    },
  });
  const setDefault = useMutation({
    mutationFn: (key: string) => api('/settings/profiles/defaults', { method: 'PUT', body: { [kind]: key } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['profiles'] }),
  });

  const names = q.data?.languageNames ?? {};
  const dirty = useMemo(() => !!q.data && !!draft && JSON.stringify(draft) !== JSON.stringify(q.data.rules[kind]), [q.data, draft, kind]);
  if (q.error) return <Notice tone="error">{errMsg(q.error)}</Notice>;
  if (!q.data || !draft) return null;
  const data = q.data;

  const what = kind === 'movie' ? 'movie' : 'show';
  const plural = (n: number) => `${n} ${n === 1 ? what : `${what}s`}`;
  const counts = check.data?.counts;
  const setRule = (i: number, r: ProfileChoiceView) => setDraft(draft.map((x, j) => (j === i ? r : x)));
  const move = (i: number, by: -1 | 1) => {
    const next = [...draft];
    [next[i], next[i + by]] = [next[i + by]!, next[i]!];
    setDraft(next);
    setOpen(open === i ? i + by : open === i + by ? i : open);
  };

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="m-0 text-heading font-semibold">Which profile a new {what} gets</h2>
        <p className="m-0 text-label text-muted">
          Picked by what kind of {what} it is, from TMDB. Checked from the top: the first rule whose conditions all fit wins. A profile you pick on a {what}’s page always stays.
        </p>
      </div>

      <ol className="m-0 flex list-none flex-col gap-2 p-0">
        {draft.map((r, i) => (
          <li key={i} className={cx('rounded-xl border', open === i ? 'border-amber bg-raised' : 'border-line-strong bg-raised')}>
            <div className="flex items-center gap-2 pr-1">
              <button type="button" aria-expanded={open === i} onClick={() => setOpen(open === i ? null : i)} className="flex min-h-14 min-w-0 flex-1 items-center gap-3 px-3 py-2 text-left">
                <span className="w-5 flex-none text-sm text-dim">{i + 1}</span>
                <span className="min-w-0 flex-1 text-sm text-text">
                  {sentence(r, kind, names)} <span className="text-dim">→</span> <span className="font-semibold text-amber-hi">{name(r.profile)}</span>
                </span>
                {counts && <span className="flex-none text-xs text-muted">{plural(counts.rules[i] ?? 0)}</span>}
              </button>
              <button type="button" aria-label={`Move rule ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)} className="size-11 flex-none rounded-lg text-soft disabled:opacity-30">
                ↑
              </button>
              <button type="button" aria-label={`Move rule ${i + 1} down`} disabled={i === draft.length - 1} onClick={() => move(i, 1)} className="size-11 flex-none rounded-lg text-soft disabled:opacity-30">
                ↓
              </button>
            </div>
            {open === i && (
              <div className="flex flex-col gap-3 border-t border-line-strong px-4 py-3">
                <div className="text-xs tracking-[.08em] text-dim uppercase">When all of these fit</div>
                <ul className="m-0 flex list-none flex-col p-0">
                  {r.conditions.map((c, k) => (
                    <ConditionRow
                      key={k}
                      c={c}
                      kind={kind}
                      data={data}
                      onChange={(nc) => setRule(i, { ...r, conditions: r.conditions.map((x, m) => (m === k ? nc : x)) })}
                      onRemove={() => setRule(i, { ...r, conditions: r.conditions.filter((_, m) => m !== k) })}
                    />
                  ))}
                </ul>
                <div className="flex flex-wrap items-center gap-3">
                  <select
                    aria-label="Add a condition"
                    value=""
                    onChange={(e) => e.target.value && setRule(i, { ...r, conditions: [...r.conditions, blank(e.target.value as ConditionField)] })}
                    className="h-11 rounded-lg border border-dashed border-line-strong bg-transparent px-3 text-sm text-amber"
                  >
                    <option value="">+ Add a condition</option>
                    {FIELDS.map((f) => (
                      <option key={f.field} value={f.field}>
                        {f.label(kind)}
                      </option>
                    ))}
                  </select>
                  <label className="flex items-center gap-2 text-sm text-soft">
                    then use
                    <select value={r.profile} onChange={(e) => setRule(i, { ...r, profile: e.target.value })} className="h-11 rounded-lg border border-line-strong bg-ink px-2.5 text-sm font-semibold text-text">
                      {profiles.map((p) => (
                        <option key={p.key} value={p.key}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <Button
                    type="button"
                    variant="danger"
                    className="ml-auto"
                    onClick={() => {
                      setDraft(draft.filter((_, j) => j !== i));
                      setOpen(null);
                    }}
                  >
                    Remove rule
                  </Button>
                </div>
              </div>
            )}
          </li>
        ))}
        <li className="flex flex-wrap items-center gap-3 rounded-xl border border-line px-3 py-2">
          <span className="w-5" />
          <span className="text-sm text-soft">Everything else →</span>
          <select
            aria-label={`Profile for every other ${what}`}
            value={view.defaults[kind]}
            disabled={setDefault.isPending}
            onChange={(e) => setDefault.mutate(e.target.value)}
            className="h-11 rounded-lg border border-line-strong bg-ink px-2.5 text-sm font-semibold text-text"
          >
            {profiles.map((p) => (
              <option key={p.key} value={p.key}>
                {p.name}
              </option>
            ))}
          </select>
          {counts && <span className="ml-auto text-xs text-muted">{plural(counts.rest)}</span>}
        </li>
      </ol>

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            setDraft([...draft, { profile: profiles[0]?.key ?? '', conditions: [blank('genre')] }]);
            setOpen(draft.length);
          }}
        >
          Add a rule
        </Button>
        {dirty && (
          <>
            <Button type="button" disabled={save.isPending} onClick={() => save.mutate(draft)}>
              {save.isPending ? 'Saving…' : 'Save rules'}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setDraft(data.rules[kind])}>
              Undo changes
            </Button>
          </>
        )}
        <Button type="button" variant="ghost" disabled={dirty || preview.isPending} onClick={() => preview.mutate()} title={dirty ? 'Save the rules first' : undefined}>
          Sort my library by these rules…
        </Button>
      </div>
      {dirty && <p className="m-0 text-label text-amber-hi">Not saved yet. The counts already show what these rules would do.</p>}
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
                These {plural(changes.length)} would move. {kind === 'movie' ? 'Movies' : 'Shows'} you picked a profile for yourself aren’t listed and won’t change.
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
                    <span className="w-[110px] text-right text-xs text-dim">{c.rule ? `rule ${c.rule}` : 'everything else'}</span>
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

      <div className="flex flex-col gap-3 border-t border-line pt-4">
        <label className="flex flex-wrap items-center gap-3 text-sm text-soft">
          Try a {what} from your library
          <input
            type="search"
            value={tryQuery}
            onChange={(e) => setTryQuery(e.target.value)}
            placeholder={kind === 'movie' ? 'Inside Out 2' : 'Bluey'}
            className="h-11 w-[260px] rounded-lg border border-line-strong bg-raised px-3 text-sm text-text placeholder:text-dim focus:border-amber focus:outline-none"
          />
        </label>
        {tryQuery.trim() && check.data && check.data.titles.length === 0 && <p className="m-0 text-sm text-muted">No {what} in your library matches that name.</p>}
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {check.data?.titles.map((t) => {
            const f = t.facts;
            const facts = [
              f.genres.join(', '),
              f.certification,
              f.year,
              f.language && (names[f.language] ?? f.language),
              f.companies.slice(0, 3).join(', '),
            ].filter(Boolean);
            // The first rule above the winner that came closest: say what didn't fit.
            const misses = t.rules
              .slice(0, t.picked ? t.picked - 1 : t.rules.length)
              .map((conds, i) => ({ i, failed: conds.flatMap((ok, k) => (ok ? [] : [draft[i]?.conditions[k]])).filter((x): x is ConditionView => !!x) }))
              .filter((m) => m.failed.length > 0);
            return (
              <li key={t.id} className="flex flex-col gap-1 rounded-xl border border-line bg-ink px-4 py-3">
                <div className="flex flex-wrap items-baseline gap-x-3">
                  <span className="text-body font-semibold">
                    {t.title} {t.year && <span className="font-normal text-dim">({t.year})</span>}
                  </span>
                  <span className="text-sm">
                    → <span className="font-semibold text-amber-hi">{name(t.profile)}</span> <span className="text-dim">{t.picked ? `by rule ${t.picked}` : 'everything else'}</span>
                  </span>
                  {t.byHand && <span className="text-xs text-dim">(you picked a profile for this one, so it stays as it is)</span>}
                </div>
                <div className="text-label text-muted">{facts.length ? facts.join(' · ') : 'TMDB hasn’t told Marquee about this one yet. Scan your library to fill it in.'}</div>
                {misses.length > 0 && (
                  <ul className="m-0 list-none p-0 text-label text-dim">
                    {misses.slice(0, 4).map((m) => (
                      <li key={m.i}>
                        Not rule {m.i + 1}: “{m.failed.map((c) => describe(c, kind, names)).join('”, “')}” doesn’t fit.
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </Card>
  );
}
