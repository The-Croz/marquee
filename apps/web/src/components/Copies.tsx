import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { CopiesResult, CopyView, ProfileKind, ProfilesView, SendResult } from '@marquee/shared';
import { ApiFailure, api, queryClient } from '../api';
import { formatBytes } from './Poster';
import { Button, Card, Notice, cx } from './ui';

/**
 * "Copies we found": searches every Source for a title and shows what
 * Marquee would pick and why, and sends one to qBittorrent with
 * "Download this". Admin only.
 */

/** The profile picker's "let the rules pick" choice. */
const RULES = '__rules';
const errMsg = (e: unknown) => (e instanceof ApiFailure ? e.message : 'Something went wrong.');
const points = (n: number) => (n > 0 ? `+${n.toLocaleString()}` : n.toLocaleString().replace('-', '−'));

function badges(c: CopyView): string[] {
  const d = c.details;
  const hdr = d.hdr.includes('DV') ? (d.hdr.length > 1 ? 'Dolby Vision + HDR' : 'Dolby Vision') : d.hdr.find((h) => h !== 'SDR');
  return [c.qualityLabel, hdr, d.atmos ? 'Atmos' : d.audio, d.service, ...d.editions, d.repack ? 'Fixed re-release' : null].filter((x): x is string => !!x);
}

function sharing(c: CopyView): string {
  if (c.seeders === null) return 'Sharing unknown';
  return c.seeders === 1 ? '1 person sharing' : `${c.seeders.toLocaleString()} people sharing`;
}

function Why({ c, profile }: { c: CopyView; profile: string }) {
  return (
    <div className="flex flex-col gap-2 border-t border-line-strong pt-3">
      <div className="text-[13px] font-semibold text-soft">Why it ranks here</div>
      {c.rules.length === 0 && <p className="m-0 text-sm text-muted">No rules in {profile} match this copy, so it scores 0 points.</p>}
      <ul className="m-0 grid list-none grid-cols-[80px_minmax(0,1fr)] gap-x-3 gap-y-1.5 p-0 text-sm">
        {c.rules.map((r) => (
          <li key={r.trashId} className="contents">
            <span className={cx('text-right font-semibold', r.points > 0 ? 'text-teal' : 'text-warn')}>{points(r.points)}</span>
            <span>
              {r.label} <span className="text-xs text-dim">{r.name}</span>
              {r.explain && <span className="text-muted"> · {r.explain}</span>}
            </span>
          </li>
        ))}
        {c.tier && (
          <li className="contents">
            <span className="text-right text-muted">·</span>
            <span className="text-muted">Quality: {c.qualityLabel}. Quality counts first; points decide between copies of the same quality.</span>
          </li>
        )}
      </ul>
    </div>
  );
}

type Sending = { step: 'idle' } | { step: 'busy' } | { step: 'confirm'; message: string } | { step: 'sent'; message: string } | { step: 'error'; message: string };

/** "Download this", with a "Download anyway?" check when Marquee wouldn't pick it or it isn't better than your file. */
function SendButton({ c, searchId, best }: { c: CopyView; searchId: string; best: boolean }) {
  const [s, setS] = useState<Sending>({ step: 'idle' });
  if (!c.id) return null;
  async function send(anyway: boolean) {
    setS({ step: 'busy' });
    try {
      const res = await api<SendResult>('/downloads', { body: { searchId, copyId: c.id, ...(anyway ? { anyway } : {}) } });
      setS({ step: 'sent', message: res.message });
      await queryClient.invalidateQueries({ queryKey: ['downloads'] });
    } catch (e) {
      if (e instanceof ApiFailure && e.code === 'needs_confirm') setS({ step: 'confirm', message: e.message });
      else setS({ step: 'error', message: errMsg(e) });
    }
  }
  if (s.step === 'sent')
    return (
      <p role="status" className="m-0 text-sm text-teal-hi">
        {s.message}
      </p>
    );
  if (s.step === 'confirm')
    return (
      <div role="alertdialog" aria-label="Download anyway?" className="flex flex-col gap-2 rounded-xl border border-line-strong px-4 py-3 text-sm">
        <p className="m-0 text-soft">{s.message}</p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={() => send(true)}>
            Download anyway
          </Button>
          <Button type="button" variant="ghost" onClick={() => setS({ step: 'idle' })}>
            Cancel
          </Button>
        </div>
      </div>
    );
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button type="button" variant={best ? 'primary' : 'ghost'} className={best ? undefined : 'h-11 px-3.5 text-sm'} disabled={s.step === 'busy'} onClick={() => send(false)}>
        {s.step === 'busy' ? 'Sending…' : 'Download this'}
      </Button>
      {s.step === 'error' && (
        <span role="status" className="text-sm text-warn">
          {s.message}
        </span>
      )}
    </div>
  );
}

function CopyRow({ c, best, profile, searchId }: { c: CopyView; best: boolean; profile: string; searchId: string }) {
  const [open, setOpen] = useState(best);
  return (
    <li className={cx('flex flex-col gap-3 rounded-[14px] border px-5 py-4', best ? 'border-amber bg-raised' : c.accepted ? 'border-line-strong' : 'border-line')}>
      <div className="flex flex-wrap items-start gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          {c.accepted && (
            <div className="flex flex-wrap gap-2">
              {best && <span className="rounded-full bg-amber px-2.5 py-0.5 text-xs font-bold text-amber-ink">Best pick</span>}
              {badges(c).map((b) => (
                <span key={b} className="rounded-full border border-line-strong px-2.5 py-0.5 text-xs text-text">
                  {b}
                </span>
              ))}
            </div>
          )}
          <div className={cx('font-mono text-[13px] break-all', c.accepted ? 'text-soft' : 'text-muted')}>
            {c.infoUrl ? (
              <a href={c.infoUrl} target="_blank" rel="noreferrer noopener" className="text-inherit">
                {c.title}
              </a>
            ) : (
              c.title
            )}
          </div>
          <div className="text-[13px] text-muted">
            {[c.sizeBytes !== null ? formatBytes(c.sizeBytes) : 'Size unknown', sharing(c), c.sources.map((s) => s.name).join(' and ')].join(' · ')}
          </div>
          {!c.accepted &&
            c.rejections.map((r) => (
              <div key={r.code + r.message} className="text-sm text-warn">
                {r.message}
              </div>
            ))}
          {c.vsYours && <div className={cx('text-sm', c.vsYours.better ? 'text-teal-hi' : 'text-muted')}>{c.vsYours.message}</div>}
          <SendButton c={c} searchId={searchId} best={best} />
        </div>
        <div className="flex flex-none flex-col items-end">
          <div className={cx('font-bold', best ? 'text-[28px] text-amber' : 'text-[20px]', !c.accepted && 'text-muted')}>{points(c.score)}</div>
          <div className="text-xs text-muted">points</div>
          <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="h-11 text-[13px] font-medium text-amber">
            {open ? 'Hide why' : 'Why?'}
          </button>
        </div>
      </div>
      {open && <Why c={c} profile={profile} />}
    </li>
  );
}

export interface CopiesProps {
  kind: ProfileKind;
  titleId: number;
  profile: string;
  /** You picked the profile; otherwise the profile rules did. */
  byHand: boolean;
  /** Shows: seasons with their episode numbers. */
  seasons?: { season: number; episodes: number[] }[];
}

export function CopiesPanel({ kind, titleId, profile, byHand, seasons }: CopiesProps) {
  const base = kind === 'movie' ? `/movies/${titleId}` : `/shows/${titleId}`;
  const firstSeason = seasons?.find((s) => s.season > 0) ?? seasons?.[0];
  const [season, setSeason] = useState(firstSeason?.season ?? 1);
  const [episode, setEpisode] = useState<number | 'all'>('all');
  const [showAllDown, setShowAllDown] = useState(false);
  const profiles = useQuery({ queryKey: ['profiles'], queryFn: () => api<ProfilesView>('/settings/profiles') });
  const mine = profiles.data?.profiles.filter((p) => p.kind === kind) ?? [];

  const search = useMutation({
    mutationFn: () => api<CopiesResult>(`${base}/search`, { body: kind === 'tv' ? { season, ...(episode === 'all' ? {} : { episode }) } : {} }),
  });
  const change = useMutation({
    mutationFn: (key: string) => api(`${base}/profile`, { method: 'PUT', body: { profile: key === RULES ? null : key } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['library'] });
      await queryClient.invalidateQueries({ queryKey: ['profiles'] });
      if (search.data) search.mutate();
    },
  });

  const r = search.data;
  const accepted = r?.copies.filter((c) => c.accepted) ?? [];
  const down = r?.copies.filter((c) => !c.accepted) ?? [];
  // A Source you paused or set to TV only isn't news; one that's failing is.
  const failed = r?.sources.filter((s) => s.status === 'failed' || (s.status === 'skipped' && !/^(Paused|Not used)/.test(s.message ?? ''))) ?? [];
  const episodes = seasons?.find((s) => s.season === season)?.episodes ?? [];

  return (
    <Card aria-label="Copies we found" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="m-0 text-xl font-semibold">Copies we found</h2>
          <p className="m-0 text-[13px] text-muted">Searches your Sources and shows what Marquee would pick and why. Nothing downloads until you press “Download this”.</p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-[13px] text-muted">
            Profile
            <select
              value={profile}
              disabled={change.isPending || !mine.length}
              onChange={(e) => change.mutate(e.target.value)}
              className="h-11 rounded-[10px] border border-line-strong bg-ink px-2.5 text-sm font-semibold text-text"
            >
              {!mine.some((p) => p.key === profile) && <option value={profile}>{profile}</option>}
              {byHand && <option value={RULES}>Let the rules pick</option>}
              {mine.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.name}
                </option>
              ))}
            </select>
            <span className="text-xs text-dim">{byHand ? 'You picked it' : 'Picked by the rules'}</span>
          </label>
          {kind === 'tv' && seasons && (
            <>
              <label className="flex flex-col gap-1 text-[13px] text-muted">
                Season
                <select
                  value={season}
                  onChange={(e) => {
                    setSeason(Number(e.target.value));
                    setEpisode('all');
                  }}
                  className="h-11 rounded-[10px] border border-line-strong bg-ink px-2.5 text-sm text-text"
                >
                  {seasons.map((s) => (
                    <option key={s.season} value={s.season}>
                      {s.season === 0 ? 'Specials' : `Season ${s.season}`}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-[13px] text-muted">
                Episode
                <select
                  value={episode}
                  onChange={(e) => setEpisode(e.target.value === 'all' ? 'all' : Number(e.target.value))}
                  className="h-11 rounded-[10px] border border-line-strong bg-ink px-2.5 text-sm text-text"
                >
                  <option value="all">Whole season</option>
                  {episodes.map((n) => (
                    <option key={n} value={n}>
                      Episode {n}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
          <Button type="button" disabled={search.isPending} onClick={() => search.mutate()}>
            {search.isPending ? 'Searching…' : r ? 'Search again' : 'Find copies'}
          </Button>
        </div>
      </div>
      {change.error && <Notice tone="error">{errMsg(change.error)}</Notice>}
      {search.error && <Notice tone="error">{errMsg(search.error)}</Notice>}
      {r && (
        <>
          <p className="m-0 text-[13px] text-muted">
            {r.copies.length} {r.copies.length === 1 ? 'copy' : 'copies'} from {r.sources.filter((s) => s.status === 'searched').length} Sources in {(r.ms / 1000).toFixed(1)} s · {accepted.length}{' '}
            {r.profile.name} would take
            {r.yours && <> · you have {r.yours.qualityLabel}</>}
          </p>
          {failed.map((s) => (
            <Notice key={s.sourceId} tone="error">
              {s.name} {s.status === 'skipped' ? 'wasn’t asked' : 'didn’t answer'}: {s.message}
            </Notice>
          ))}
          {accepted.length === 0 && <Notice>None of these suit {r.profile.name}. The reasons are below each copy; changing the profile can let some through.</Notice>}
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {accepted.map((c, i) => (
              <CopyRow key={r.searchId + c.title + i} c={c} best={i === 0} profile={r.profile.name} searchId={r.searchId} />
            ))}
          </ul>
          {down.length > 0 && (
            <>
              <h3 className="m-0 pt-2 text-xs font-normal tracking-[.08em] text-dim uppercase">Turned down · {down.length}</h3>
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {(showAllDown ? down : down.slice(0, 5)).map((c, i) => (
                  <CopyRow key={r.searchId + c.title + i} c={c} best={false} profile={r.profile.name} searchId={r.searchId} />
                ))}
              </ul>
              {down.length > 5 && (
                <button type="button" onClick={() => setShowAllDown(!showAllDown)} className="h-11 self-start text-sm font-medium text-amber">
                  {showAllDown ? 'Show fewer' : `Show all ${down.length} turned down`}
                </button>
              )}
            </>
          )}
        </>
      )}
    </Card>
  );
}
