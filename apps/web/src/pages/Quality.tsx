import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { ProfileDetail, ProfileKind, ProfileRuleView, ProfilesView, QualityTier, SizeLimitView } from '@marquee/shared';
import { ApiFailure, api, queryClient } from '../api';
import { Button, Card, Notice, cx } from '../components/ui';
import { ProfileChoices } from '../components/ProfileChoices';
import { MovedToDictionarry, OwnRules, RuleUpdates, TryName, points } from '../components/QualityTools';

/**
 * Quality: the profiles that decide which copy Marquee picks for a title.
 * Everything in a profile can be changed here; the built-in ones are only
 * starting points (on Dictionarry's rules) and can be put back to its values.
 */

const errMsg = (e: unknown) => (e instanceof ApiFailure ? e.message : 'Something went wrong.');
const NEVER = -10000;
const DB_NAME = { dictionarry: 'Dictionarry', trash: 'TRaSH' } as const;

export function QualityPage() {
  const [kind, setKind] = useState<ProfileKind>('movie');
  const [selected, setSelected] = useState<number | null>(null);
  const list = useQuery({ queryKey: ['profiles'], queryFn: () => api<ProfilesView>('/settings/profiles') });
  const mine = list.data?.profiles.filter((p) => p.kind === kind) ?? [];
  const current = mine.find((p) => p.id === selected) ?? mine[0];

  return (
    <>
      {list.error && <Notice tone="error">{errMsg(list.error)}</Notice>}
      {list.data?.notice && <MovedToDictionarry notice={list.data.notice} />}
      <div className="flex flex-wrap items-start gap-8">
        <section aria-label="Profiles" className="flex w-full flex-col gap-4 2xl:w-[300px] 2xl:flex-none">
          <div role="tablist" aria-label="Library" className="flex rounded-xl border border-line bg-panel p-1">
            {(['movie', 'tv'] as const).map((k) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={kind === k}
                onClick={() => {
                  setKind(k);
                  setSelected(null);
                }}
                className={cx('h-11 flex-1 rounded-lg text-sm', kind === k ? 'bg-raised font-semibold text-text' : 'font-medium text-muted')}
              >
                {k === 'movie' ? 'Movies' : 'TV'}
              </button>
            ))}
          </div>
          <div className="flex flex-col gap-2">
            {mine.map((p) => (
              <button
                key={p.id}
                type="button"
                aria-current={current?.id === p.id}
                onClick={() => setSelected(p.id)}
                className={cx('flex flex-col gap-1.5 rounded-2xl border px-4 py-3.5 text-left', current?.id === p.id ? 'border-amber bg-raised' : 'border-line bg-panel hover:border-line-strong')}
              >
                <span className="flex w-full flex-wrap items-center justify-between gap-2">
                  <span className="text-body font-semibold text-text">{p.name}</span>
                  <span className="flex gap-1">
                    {p.defaultFor.map((d) => (
                      <span key={d} className={cx('rounded-full px-2 py-0.5 text-xs', d === 'kids' ? 'border border-line-strong text-soft' : 'bg-amber text-amber-ink')}>
                        {d === 'kids' ? "Kids' requests" : 'Default'}
                      </span>
                    ))}
                  </span>
                </span>
                <span className="text-label text-muted">
                  {p.titles} {kind === 'movie' ? (p.titles === 1 ? 'movie' : 'movies') : p.titles === 1 ? 'show' : 'shows'} · {DB_NAME[p.database]}
                </span>
              </button>
            ))}
          </div>
          {list.data && <NewProfile kind={kind} view={list.data} onCreated={setSelected} />}
          {list.data && <Defaults view={list.data} />}
        </section>
        <div className="flex min-w-0 flex-[999_1_560px] flex-col gap-6">
          {list.data && <ProfileChoices kind={kind} view={list.data} />}
          <RuleUpdates />
          {list.data && <OwnRules view={list.data} />}
          {current ? <ProfileEditor key={current.id} id={current.id} /> : list.isLoading ? <p className="text-muted">Loading…</p> : null}
        </div>
      </div>
    </>
  );
}

function NewProfile({ kind, view, onCreated }: { kind: ProfileKind; view: ProfilesView; onCreated: (id: number) => void }) {
  const [from, setFrom] = useState('');
  const [name, setName] = useState('');
  const options = [
    ...view.profiles.filter((p) => p.kind === kind).map((p) => ({ value: `copy:${p.id}`, label: `A copy of ${p.name}` })),
    ...view.starters.filter((t) => t.kind === kind && t.database === 'dictionarry').map((t) => ({ value: `dictionarry:${t.name}`, label: `Dictionarry: ${t.name}` })),
    ...view.starters.filter((t) => t.kind === kind && t.database === 'trash').map((t) => ({ value: `trash:${t.name}`, label: `TRaSH: ${t.name}` })),
  ];
  const starter = view.starters.find((t) => t.kind === kind && `${t.database}:${t.name}` === (from || options[0]?.value));
  const value = from && options.some((o) => o.value === from) ? from : (options[0]?.value ?? '');
  const create = useMutation({
    mutationFn: () => {
      const [how, what] = [value.slice(0, value.indexOf(':')), value.slice(value.indexOf(':') + 1)];
      return api<ProfileDetail>('/settings/profiles', { body: { kind, name, ...(how === 'copy' ? { copyFrom: Number(what) } : how === 'dictionarry' ? { fromDictionarry: what } : { fromTrash: what }) } });
    },
    onSuccess: async (p) => {
      setName('');
      await queryClient.invalidateQueries({ queryKey: ['profiles'] });
      onCreated(p.id);
    },
  });
  return (
    <form
      className="flex flex-col gap-3 rounded-2xl border border-dashed border-line-strong p-4"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <h2 className="m-0 text-sm font-semibold">New profile</h2>
      <label className="flex flex-col gap-1.5 text-label text-muted">
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} className="h-11 rounded-lg border border-line-strong bg-ink px-3 text-sm text-text focus:border-amber focus:outline-none" />
      </label>
      <label className="flex flex-col gap-1.5 text-label text-muted">
        Start from
        <select value={value} onChange={(e) => setFrom(e.target.value)} className="h-11 rounded-lg border border-line-strong bg-ink px-2.5 text-sm text-text">
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      {starter && <p className="m-0 text-label text-dim">{starter.description}</p>}
      {create.error && <Notice tone="error">{errMsg(create.error)}</Notice>}
      <Button type="submit" variant="ghost" disabled={!name.trim() || create.isPending}>
        Create
      </Button>
    </form>
  );
}

function Defaults({ view }: { view: ProfilesView }) {
  const save = useMutation({
    mutationFn: (body: Partial<ProfilesView['defaults']>) => api('/settings/profiles/defaults', { method: 'PUT', body }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['profiles'] }),
  });
  const keysFor = (kind: ProfileKind) => view.profiles.filter((p) => p.kind === kind);
  // Kids' requests can be movies or shows, so the profile must exist in both.
  const kidsKeys = keysFor('movie').filter((m) => keysFor('tv').some((t) => t.key === m.key));
  // New movies and shows are picked by the rules card; this is only for kids' requests.
  const rows: { slot: keyof ProfilesView['defaults']; label: string; options: { key: string; name: string }[] }[] = [{ slot: 'kids', label: "Kids' requests", options: kidsKeys }];
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-line bg-panel p-4">
      <h2 className="m-0 text-sm font-semibold">Requests from kids</h2>
      {rows.map((r) => (
        <label key={r.slot} className="flex items-center justify-between gap-3 text-label text-muted">
          {r.label}
          <select
            value={view.defaults[r.slot]}
            onChange={(e) => save.mutate({ [r.slot]: e.target.value })}
            className="h-11 max-w-[170px] rounded-lg border border-line-strong bg-ink px-2.5 text-sm text-text"
          >
            {r.options.map((o) => (
              <option key={o.key} value={o.key}>
                {o.name}
              </option>
            ))}
          </select>
        </label>
      ))}
      {save.error && <Notice tone="error">{errMsg(save.error)}</Notice>}
    </div>
  );
}

// ---------------------------------------------------------------- editing one profile

interface Draft {
  name: string;
  description: string;
  tiers: QualityTier[];
  cutoff: string;
  upgrades: boolean;
  minScore: number;
  cutoffScore: number;
  minUpgradeScore: number;
  preferRepacks: boolean;
  rules: Record<string, { enabled: boolean; score: number }>;
  sizes: Record<string, { min: number; preferred: number; max: number }>;
  /** Sizes you touched (or had already changed), so only those are saved. */
  sizesChanged: Set<string>;
}

function toDraft(p: ProfileDetail): Draft {
  return {
    name: p.name,
    description: p.description,
    tiers: p.tiers,
    cutoff: p.cutoff,
    upgrades: p.upgrades,
    minScore: p.minScore,
    cutoffScore: p.cutoffScore,
    minUpgradeScore: p.minUpgradeScore,
    preferRepacks: p.preferRepacks,
    rules: Object.fromEntries(p.rules.map((r) => [r.trashId, { enabled: r.enabled, score: r.score }])),
    sizes: Object.fromEntries(p.sizes.map((s) => [s.quality, { min: s.min, preferred: s.preferred, max: s.max }])),
    sizesChanged: new Set(p.sizes.filter((s) => s.changed).map((s) => s.quality)),
  };
}

function ProfileEditor({ id }: { id: number }) {
  const q = useQuery({ queryKey: ['profile', id], queryFn: () => api<ProfileDetail>(`/settings/profiles/${id}`) });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (q.data) setDraft(toDraft(q.data));
  }, [q.data]);

  const refresh = async (p: ProfileDetail) => {
    queryClient.setQueryData(['profile', id], p);
    await queryClient.invalidateQueries({ queryKey: ['profiles'] });
  };
  const save = useMutation({
    mutationFn: (d: Draft) =>
      api<ProfileDetail>(`/settings/profiles/${id}`, {
        method: 'PATCH',
        body: {
          name: d.name,
          description: d.description,
          tiers: d.tiers,
          cutoff: d.cutoff,
          upgrades: d.upgrades,
          minScore: d.minScore,
          cutoffScore: d.cutoffScore,
          minUpgradeScore: d.minUpgradeScore,
          preferRepacks: d.preferRepacks,
          rules: Object.entries(d.rules).map(([trashId, r]) => ({ trashId, ...r })),
          sizes: Object.fromEntries([...d.sizesChanged].map((k) => [k, d.sizes[k]!])),
        },
      }),
    onSuccess: async (p) => {
      await refresh(p);
      setSaved(true);
    },
  });
  const reset = useMutation({ mutationFn: () => api<ProfileDetail>(`/settings/profiles/${id}/reset`, { body: {} }), onSuccess: refresh });
  const settle = useMutation({
    mutationFn: (b: { trashId: string; use: 'theirs' | 'mine' }) => api<ProfileDetail>(`/settings/profiles/${id}/settle`, { body: b }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: () => api(`/settings/profiles/${id}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['profiles'] }),
  });

  if (q.error) return <Notice tone="error">{errMsg(q.error)}</Notice>;
  if (!q.data || !draft) return <p className="text-muted">Loading…</p>;
  const p = q.data;
  const dirty = JSON.stringify({ ...draft, sizesChanged: [...draft.sizesChanged] }) !== JSON.stringify({ ...toDraft(p), sizesChanged: [...toDraft(p).sizesChanged] });
  const edit = (change: Partial<Draft>) => {
    setSaved(false);
    setDraft({ ...draft, ...change });
  };

  return (
    <form
      aria-label={p.name}
      className="flex flex-col gap-6"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(draft);
      }}
    >
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex min-w-[260px] flex-1 flex-col gap-1.5">
          <label htmlFor="profile-name" className="text-label text-muted">
            Name
          </label>
          <input
            id="profile-name"
            value={draft.name}
            maxLength={60}
            onChange={(e) => edit({ name: e.target.value })}
            className="h-11 max-w-[360px] rounded-lg border border-line-strong bg-panel px-3 text-xl font-semibold text-text focus:border-amber focus:outline-none"
          />
          <span className="text-label text-dim">
            {p.preset
              ? `Built in, on ${DB_NAME[p.database]}${p.base ? `’s ${p.base}` : ''}. Change anything; “Put back Dictionarry’s values” undoes it.`
              : `Your own profile, on ${DB_NAME[p.database]}${p.base ? `’s ${p.base}` : ''}.`}
            {p.database === 'dictionarry' && p.base ? ' Rule updates change only what you haven’t.' : ''}
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          {p.preset && (
            <Button type="button" variant="ghost" disabled={reset.isPending} onClick={() => window.confirm(`Put ${p.name} back to Dictionarry's values? Your changes to it are lost.`) && reset.mutate()}>
              Put back Dictionarry’s values
            </Button>
          )}
          <Button type="button" variant="danger" disabled={remove.isPending} onClick={() => window.confirm(`Delete ${p.name}?`) && remove.mutate()}>
            Delete
          </Button>
          <Button type="submit" disabled={!dirty || save.isPending}>
            {save.isPending ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      </div>
      {save.error && <Notice tone="error">{errMsg(save.error)}</Notice>}
      {reset.error && <Notice tone="error">{errMsg(reset.error)}</Notice>}
      {remove.error && <Notice tone="error">{errMsg(remove.error)}</Notice>}
      {saved && !dirty && <Notice tone="success">Saved. The next search uses it.</Notice>}

      {settle.error && <Notice tone="error">{errMsg(settle.error)}</Notice>}
      <TryName profileId={p.id} profileName={p.name} />
      <Tiers draft={draft} labels={p.qualityLabels} edit={edit} />
      <Rules saved={p.rules} draft={draft} edit={edit} database={p.database} onSettle={(trashId, use) => settle.mutate({ trashId, use })} />
      <Experts draft={draft} edit={edit} />
      <Sizes sizes={p.sizes} draft={draft} kind={p.kind} database={p.database} edit={edit} />
      {dirty && (
        <div className="sticky bottom-4 flex justify-end">
          <Button type="submit" disabled={save.isPending} className="shadow-2xl">
            {save.isPending ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      )}
    </form>
  );
}

function Tiers({ draft, labels, edit }: { draft: Draft; labels: Record<string, string>; edit: (c: Partial<Draft>) => void }) {
  const [showOff, setShowOff] = useState(false);
  // A group of many qualities (Dictionarry's way) is named for itself; its points decide between them.
  const tierLabel = (t: QualityTier) =>
    (t.qualities.length === 1 ? labels[t.qualities[0]!] : t.qualities.length === 2 ? `${labels[t.qualities[0]!]?.replace(/ web (download|capture)$/, ' web')} (download or capture)` : `${t.name}: ${t.qualities.length} qualities`) ?? t.name;
  const bigGroup = draft.tiers.find((t) => t.allowed && t.qualities.length > 2);
  const on = draft.tiers.filter((t) => t.allowed);
  const off = draft.tiers.filter((t) => !t.allowed);
  const move = (name: string, by: -1 | 1) => {
    const order = [...on];
    const i = order.findIndex((t) => t.name === name);
    const j = i + by;
    if (j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j]!, order[i]!];
    edit({ tiers: [...order, ...off] });
  };
  const toggle = (name: string) => {
    const t = draft.tiers.find((x) => x.name === name)!;
    // Turning one on puts it last among the ones you take; turning one off moves it out of the order.
    const next = t.allowed ? [...on.filter((x) => x.name !== name), { ...t, allowed: false }, ...off] : [...on, { ...t, allowed: true }, ...off.filter((x) => x.name !== name)];
    edit({ tiers: next, cutoff: t.allowed && draft.cutoff === name ? (on.find((x) => x.name !== name)?.name ?? draft.cutoff) : draft.cutoff });
  };
  return (
    <Card className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="m-0 text-heading font-semibold">Qualities, best first</h2>
        <span className="text-label text-muted">Marquee takes the highest one it can find. Switch one off to never take it.</span>
      </div>
      {bigGroup && (
        <p className="m-0 text-label text-muted">
          “{bigGroup.name}” takes {bigGroup.qualities.map((q) => labels[q] ?? q).join(', ')}. Within it, the rules’ points pick the best copy, so a trusted small encode can beat a bigger one.
        </p>
      )}
      <ol className="m-0 flex list-none flex-col gap-2 p-0">
        {on.map((t, i) => (
          <li key={t.name} className="flex items-center gap-3 rounded-lg border border-line-strong bg-raised px-3 py-1.5">
            <span className="w-6 text-sm text-dim">{i + 1}</span>
            <span className="flex-1 text-sm">{tierLabel(t)}</span>
            {draft.cutoff === t.name && <span className="rounded-full bg-amber px-2 py-0.5 text-xs text-amber-ink">Good enough</span>}
            <button type="button" aria-label={`Move ${tierLabel(t)} up`} disabled={i === 0} onClick={() => move(t.name, -1)} className="size-11 rounded-lg text-soft disabled:opacity-30">
              ↑
            </button>
            <button type="button" aria-label={`Move ${tierLabel(t)} down`} disabled={i === on.length - 1} onClick={() => move(t.name, 1)} className="size-11 rounded-lg text-soft disabled:opacity-30">
              ↓
            </button>
            <label className="flex size-11 items-center justify-center">
              <input type="checkbox" checked aria-label={`Take ${tierLabel(t)}`} onChange={() => toggle(t.name)} className="size-5 accent-amber" />
            </label>
          </li>
        ))}
      </ol>
      <button type="button" onClick={() => setShowOff(!showOff)} aria-expanded={showOff} className="h-11 self-start text-sm font-medium text-amber">
        {showOff ? 'Hide the qualities you don’t take' : `Show ${off.length} qualities you don’t take`}
      </button>
      {showOff && (
        <ul className="m-0 grid list-none grid-cols-1 gap-2 p-0 sm:grid-cols-2">
          {off.map((t) => (
            <li key={t.name} className="flex items-center gap-3 rounded-lg border border-line px-3 py-1 text-muted">
              <span className="flex-1 text-sm">{tierLabel(t)}</span>
              <label className="flex size-11 items-center justify-center">
                <input type="checkbox" checked={false} aria-label={`Take ${tierLabel(t)}`} onChange={() => toggle(t.name)} className="size-5 accent-amber" />
              </label>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-6 border-t border-line pt-4">
        <label className="flex items-center gap-3 text-sm text-soft">
          Good enough at
          <select value={draft.cutoff} onChange={(e) => edit({ cutoff: e.target.value })} className="h-11 rounded-lg border border-line-strong bg-raised px-2.5 text-sm text-text">
            {on.map((t) => (
              <option key={t.name} value={t.name}>
                {tierLabel(t)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-3 text-sm text-soft">
          <input type="checkbox" checked={draft.upgrades} onChange={(e) => edit({ upgrades: e.target.checked })} className="size-5 accent-amber" />
          Keep looking for a better copy until it’s good enough
        </label>
      </div>
    </Card>
  );
}

function groupName(r: ProfileRuleView): string {
  if (r.conflict !== null) return 'Changed by a rule update · you choose';
  if (!r.enabled) return 'Optional · off until you turn them on';
  if (r.score <= NEVER) return 'Never pick';
  if (!r.group) return 'Always counted';
  return r.group.replace(/^\[[^\]]+\]\s*/, '');
}

const SOURCE_NAME = { dictionarry: 'Dictionarry', trash: 'TRaSH', own: 'Yours' } as const;

function Rules(props: { saved: ProfileRuleView[]; draft: Draft; edit: (c: Partial<Draft>) => void; database: 'dictionarry' | 'trash'; onSettle: (trashId: string, use: 'theirs' | 'mine') => void }) {
  const { saved, draft, edit } = props;
  const [find, setFind] = useState('');
  // Grouped by how the profile was last saved, so a rule doesn't jump around while you edit it.
  const groups = useMemo(() => {
    const out = new Map<string, ProfileRuleView[]>();
    const order = (name: string) => (name.startsWith('Changed by') ? -1 : name === 'Never pick' ? 0 : name.startsWith('Optional') ? 2 : 1);
    for (const r of [...saved].sort((a, b) => order(groupName(a)) - order(groupName(b)) || b.score - a.score)) {
      const g = groupName(r);
      out.set(g, [...(out.get(g) ?? []), r]);
    }
    return [...out.entries()];
  }, [saved]);
  const needle = find.trim().toLowerCase();
  const shown = (r: ProfileRuleView) => !needle || `${r.label} ${r.name} ${r.explain}`.toLowerCase().includes(needle);
  const set = (id: string, change: Partial<{ enabled: boolean; score: number }>) => edit({ rules: { ...draft.rules, [id]: { ...draft.rules[id]!, ...change } } });

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="m-0 text-heading font-semibold">Rules and points</h2>
        <label className="flex items-center gap-3 text-sm text-soft">
          Find a rule
          <input
            type="search"
            value={find}
            onChange={(e) => setFind(e.target.value)}
            placeholder="Dolby Vision, Netflix, x265…"
            className="h-11 w-[240px] rounded-lg border border-line-strong bg-raised px-3 text-sm text-text placeholder:text-dim focus:border-amber focus:outline-none"
          />
        </label>
      </div>
      <p className="m-0 text-label text-muted">
        A copy’s points are the sum of the rules it matches; more points wins. A rule at −10,000 or less means never pick a copy that matches it.
        {props.database === 'dictionarry' && ' Dictionarry’s points run large on purpose: the big ones (hundreds of thousands) rank whole kinds of copy, the small ones break ties.'}
      </p>
      {groups.map(([name, rules]) => {
        const visible = rules.filter(shown);
        if (!visible.length) return null;
        return (
          <details key={name} open={name !== 'Optional · off until you turn them on' || !!needle} className="group">
            <summary className="flex min-h-11 cursor-pointer items-center text-xs tracking-[.08em] text-dim uppercase">
              {name} · {visible.length} {visible.length === 1 ? 'rule' : 'rules'}
            </summary>
            <ul className="m-0 flex list-none flex-col p-0">
              {visible.map((r) => {
                const d = draft.rules[r.trashId]!;
                const changed = r.databaseScore !== null && d.score !== r.databaseScore;
                return (
                  <li key={r.trashId} className={cx('grid grid-cols-[44px_minmax(0,1fr)_120px] items-center gap-3 border-t border-line py-2', !d.enabled && 'text-muted')}>
                    <label className="flex size-11 items-center justify-center">
                      <input type="checkbox" checked={d.enabled} aria-label={`Use ${r.label}`} onChange={(e) => set(r.trashId, { enabled: e.target.checked })} className="size-5 accent-amber" />
                    </label>
                    <div className="min-w-0">
                      <div className={cx('text-sm font-semibold', d.enabled ? 'text-text' : 'text-soft')}>
                        {r.label}{' '}
                        <span className="text-xs font-normal text-dim">
                          {SOURCE_NAME[r.source]}
                          {r.source !== 'own' && `: ${r.name}`}
                          {changed && r.databaseScore !== null && ` · ${SOURCE_NAME[r.source]} gives ${points(r.databaseScore)}`}
                        </span>
                      </div>
                      {r.explain && <div className="text-label text-muted">{r.explain}</div>}
                      {r.conflict !== null && (
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-label text-amber">
                          A rule update made this {points(r.conflict)}; you’d set {points(r.score)}.
                          <button type="button" className="h-11 rounded-lg px-2 font-semibold underline" onClick={() => props.onSettle(r.trashId, 'theirs')}>
                            Use {points(r.conflict)}
                          </button>
                          <button type="button" className="h-11 rounded-lg px-2 font-semibold underline" onClick={() => props.onSettle(r.trashId, 'mine')}>
                            Keep mine
                          </button>
                        </div>
                      )}
                    </div>
                    <input
                      type="number"
                      step={50}
                      value={d.score}
                      aria-label={`Points for ${r.label}`}
                      onChange={(e) => set(r.trashId, { score: Math.round(Number(e.target.value) || 0) })}
                      className={cx(
                        'h-10 rounded-lg border bg-raised px-2.5 text-right text-sm font-semibold focus:border-amber focus:outline-none',
                        changed ? 'border-amber text-amber' : 'border-line-strong',
                        !changed && d.score <= NEVER ? 'text-warn' : !changed && 'text-text',
                      )}
                    />
                  </li>
                );
              })}
            </ul>
          </details>
        );
      })}
      <label className="flex flex-wrap items-center gap-3 border-t border-line pt-4 text-sm text-soft">
        Turn down copies under
        <input
          type="number"
          value={draft.minScore}
          aria-label="Minimum points"
          onChange={(e) => edit({ minScore: Math.round(Number(e.target.value) || 0) })}
          className="h-10 w-[110px] rounded-lg border border-line-strong bg-raised px-2.5 text-right text-sm font-semibold text-text"
        />
        points
      </label>
    </Card>
  );
}

function Experts({ draft, edit }: { draft: Draft; edit: (c: Partial<Draft>) => void }) {
  const num = 'h-10 w-[130px] rounded-lg border border-line-strong bg-raised px-2.5 text-right text-sm font-semibold text-text';
  return (
    <details className="rounded-2xl border border-line bg-panel p-6">
      <summary className="min-h-11 cursor-pointer text-heading font-semibold">For experts: points and fixed copies</summary>
      <div className="mt-3 flex flex-col gap-4 text-sm text-soft">
        <label className="flex flex-wrap items-center gap-3">
          Good enough at
          <input type="number" value={draft.cutoffScore} aria-label="Good enough at points" onChange={(e) => edit({ cutoffScore: Math.round(Number(e.target.value) || 0) })} className={num} />
          points (with the “good enough” quality)
        </label>
        <p className="m-0 -mt-2 text-label text-muted">
          {draft.cutoffScore >= 1_000_000
            ? 'At 1,000,000 nothing is ever good enough by points: Marquee keeps checking for a better copy now and then (a few titles a day), as Dictionarry intends.'
            : 'Once a copy has this many points at the good-enough quality, Marquee stops looking for a better one.'}
        </p>
        <label className="flex flex-wrap items-center gap-3">
          Upgrade only for at least
          <input type="number" min={1} value={draft.minUpgradeScore} aria-label="Smallest gain worth an upgrade" onChange={(e) => edit({ minUpgradeScore: Math.max(1, Math.round(Number(e.target.value) || 1)) })} className={num} />
          more points
        </label>
        <label className="flex items-start gap-3">
          <input type="checkbox" checked={draft.preferRepacks} onChange={(e) => edit({ preferRepacks: e.target.checked })} className="mt-0.5 size-5 accent-amber" />
          <span>
            A fixed copy (proper or repack) beats others of the same quality before points are counted
            <span className="block text-label text-muted">Dictionarry turns this off and gives fixed copies a few points instead, so a fix never beats a better copy.</span>
          </span>
        </label>
      </div>
    </details>
  );
}

function Sizes({ sizes, draft, kind, database, edit }: { sizes: SizeLimitView[]; draft: Draft; kind: ProfileKind; database: 'dictionarry' | 'trash'; edit: (c: Partial<Draft>) => void }) {
  const top = kind === 'movie' ? 2000 : 1000;
  const set = (quality: string, field: 'min' | 'preferred' | 'max', value: number) =>
    edit({ sizes: { ...draft.sizes, [quality]: { ...draft.sizes[quality]!, [field]: value } }, sizesChanged: new Set([...draft.sizesChanged, quality]) });
  return (
    <details className="rounded-2xl border border-line bg-panel p-6">
      <summary className="min-h-11 cursor-pointer text-heading font-semibold">For experts: sizes per quality</summary>
      <p className="mt-3 mb-4 text-label text-muted">
        In MB per minute of runtime{database === 'trash' ? ', from TRaSH' : '. Dictionarry sets no limits: its rules already favour sensible sizes'}. Copies smaller than the smallest are usually poor or mislabeled. Among equal copies, the one
        closest to the preferred size wins. A largest of {top} means no limit.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] border-collapse text-sm">
          <thead>
            <tr className="text-left text-dim">
              <th className="py-2 font-normal">Quality</th>
              <th className="py-2 font-normal">Smallest</th>
              <th className="py-2 font-normal">Preferred</th>
              <th className="py-2 font-normal">Largest</th>
            </tr>
          </thead>
          <tbody>
            {sizes.map((s) => (
              <tr key={s.quality} className="border-t border-line">
                <th scope="row" className="py-1.5 pr-3 text-left font-normal">
                  {s.label}
                  {draft.sizesChanged.has(s.quality) && <span className="ml-2 text-xs text-amber">changed</span>}
                </th>
                {(['min', 'preferred', 'max'] as const).map((f) => (
                  <td key={f} className="py-1.5 pr-2">
                    <input
                      type="number"
                      min={0}
                      max={top}
                      step={0.1}
                      value={draft.sizes[s.quality]![f]}
                      aria-label={`${f === 'min' ? 'Smallest' : f === 'max' ? 'Largest' : 'Preferred'} size for ${s.label}`}
                      onChange={(e) => set(s.quality, f, Number(e.target.value) || 0)}
                      className="h-10 w-[100px] rounded-lg border border-line-strong bg-raised px-2.5 text-right text-sm text-text"
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
