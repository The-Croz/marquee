import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { CompareVerdict, CompareView, ComparisonView, CopyView } from '@marquee/shared';
import { ApiFailure, api, queryClient } from '../api';
import { formatBytes } from '../components/Poster';
import { Button, Card, Notice, cx } from '../components/ui';

/**
 * Compare with Radarr: for each copy Radarr downloaded, what Marquee would
 * have picked. Used to build trust before Marquee takes over movies.
 */

const errMsg = (e: unknown) => (e instanceof ApiFailure ? e.message : 'Something went wrong.');
const points = (n: number) => (n > 0 ? `+${n.toLocaleString()}` : n.toLocaleString().replace('-', '−'));
const when = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

const VERDICTS: { key: CompareVerdict; label: string; tone: string; agree: boolean }[] = [
  { key: 'same', label: 'Same copy', tone: 'text-teal-hi', agree: true },
  { key: 'same_quality', label: 'Same quality, different copy', tone: 'text-teal', agree: true },
  { key: 'higher', label: 'Marquee picks higher quality', tone: 'text-blue-hi', agree: false },
  { key: 'lower', label: 'Marquee picks lower quality', tone: 'text-amber-hi', agree: false },
  { key: 'nothing', label: 'Marquee found nothing', tone: 'text-warn', agree: false },
];
const verdict = (v: CompareVerdict | null) => VERDICTS.find((x) => x.key === v);

type Filter = 'all' | 'differ' | CompareVerdict;

export function ComparePage() {
  const [filter, setFilter] = useState<Filter>('differ');
  const q = useQuery({ queryKey: ['compare'], queryFn: () => api<CompareView>('/compare') });
  const set = (v: CompareView) => queryClient.setQueryData(['compare'], v);
  const run = useMutation({ mutationFn: () => api<{ compared: number; added: number; view: CompareView }>('/compare/run', { body: {} }), onSuccess: (r) => set(r.view) });
  const toggle = useMutation({ mutationFn: (enabled: boolean) => api<CompareView>('/compare/settings', { method: 'PUT', body: { enabled } }), onSuccess: set });

  const v = q.data;
  const items = (v?.items ?? []).filter((i) =>
    filter === 'all' ? true : filter === 'differ' ? i.status !== 'done' || !verdict(i.verdict)?.agree : i.verdict === filter,
  );

  return (
    <>
      <div className="flex flex-col gap-2">
        <h1 className="m-0 font-display text-[56px] leading-none font-normal">Compare with Radarr</h1>
        <p className="m-0 max-w-[720px] text-[15px] leading-relaxed text-muted">
          For each movie Radarr downloads, Marquee works out what it would have picked. When they agree often enough, Marquee is ready to take over movies. Marquee only reads from Radarr and
          downloads nothing.
        </p>
      </div>
      {q.error && <Notice tone="error">{errMsg(q.error)}</Notice>}
      {v && !v.radarrConnected && (
        <Notice>
          Connect Radarr in <Link to="/settings/services">Settings → Services</Link> to start. Marquee only reads its history.
        </Notice>
      )}
      {v && v.radarrConnected && (
        <Card className="flex flex-col gap-5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-baseline gap-4">
              <span className="font-display text-[64px] leading-none">{v.agreement === null ? '—' : `${v.agreement}%`}</span>
              <span className="text-sm text-muted">
                agree on {v.total} {v.total === 1 ? 'download' : 'downloads'}
                {v.waiting > 0 && ` · ${v.waiting} waiting`}
                {v.lastRun && ` · last checked ${new Date(v.lastRun).toLocaleString()}`}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex min-h-11 items-center gap-2 text-sm text-soft">
                <input type="checkbox" checked={v.enabled} disabled={toggle.isPending} onChange={(e) => toggle.mutate(e.target.checked)} className="size-5 accent-amber" />
                Check every hour
              </label>
              <Button type="button" disabled={run.isPending} onClick={() => run.mutate()}>
                {run.isPending ? 'Comparing…' : 'Check now'}
              </Button>
            </div>
          </div>
          <p className="m-0 text-[13px] text-muted">
            Each check brings in Radarr’s new downloads and compares up to 5, newest first. Each one searches your Sources, so they count toward each Source’s daily limit.
          </p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-5">
            {VERDICTS.map((x) => (
              <button
                key={x.key}
                type="button"
                aria-pressed={filter === x.key}
                onClick={() => setFilter(filter === x.key ? 'differ' : x.key)}
                className={cx('flex flex-col gap-1 rounded-xl border px-3 py-3 text-left', filter === x.key ? 'border-amber bg-raised' : 'border-line bg-ink hover:border-line-strong')}
              >
                <span className={cx('text-2xl font-bold', x.tone)}>{v.counts[x.key]}</span>
                <span className="text-xs text-soft">{x.label}</span>
              </button>
            ))}
          </div>
          {run.error && <Notice tone="error">{errMsg(run.error)}</Notice>}
          {toggle.error && <Notice tone="error">{errMsg(toggle.error)}</Notice>}
          {run.data && <Notice tone="success">{run.data.added ? `${run.data.added} new from Radarr. ` : 'Nothing new from Radarr. '}{run.data.compared ? `Compared ${run.data.compared}.` : ''}</Notice>}
        </Card>
      )}
      {v && v.items.length > 0 && (
        <div className="flex flex-col gap-3">
          <div role="tablist" aria-label="Show" className="flex flex-wrap gap-2">
            {(
              [
                ['differ', 'To review'],
                ['all', 'All'],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={filter === k}
                onClick={() => setFilter(k)}
                className={cx('h-11 rounded-full border px-4 text-sm font-medium', filter === k ? 'border-amber bg-amber text-amber-ink' : 'border-line bg-panel text-soft')}
              >
                {label}
              </button>
            ))}
          </div>
          {items.length === 0 && <p className="m-0 text-sm text-muted">Nothing here.</p>}
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {items.map((i) => (
              <Item key={i.id} item={i} />
            ))}
          </ul>
        </div>
      )}
      {v && v.radarrConnected && v.items.length === 0 && <p className="m-0 text-sm text-muted">Nothing compared yet. “Check now” brings in Radarr’s downloads from the last 30 days.</p>}
    </>
  );
}

function CopyBox({ who, c, extra }: { who: string; c: CopyView | null; extra?: string }) {
  return (
    <div className="flex min-w-0 flex-1 basis-[300px] flex-col gap-2 rounded-xl border border-line bg-ink p-4">
      <div className="text-xs tracking-[.08em] text-dim uppercase">{who}</div>
      {!c ? (
        <p className="m-0 text-sm text-muted">Nothing it would take.</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full border border-line-strong px-2.5 py-0.5 text-xs">{c.qualityLabel}</span>
            <span className={cx('text-sm font-semibold', c.accepted ? 'text-text' : 'text-muted')}>{points(c.score)} points in Marquee</span>
            {extra && <span className="text-xs text-dim">{extra}</span>}
          </div>
          <div className="font-mono text-[13px] break-all text-soft">{c.title}</div>
          <div className="text-xs text-muted">{c.sizeBytes ? formatBytes(c.sizeBytes) : 'Size unknown'}</div>
          {c.rejections.map((r) => (
            <div key={r.code + r.message} className="text-sm text-warn">
              {r.message}
            </div>
          ))}
          {c.rules.length > 0 && (
            <ul className="m-0 grid list-none grid-cols-[70px_minmax(0,1fr)] gap-x-2 gap-y-1 p-0 text-[13px]">
              {c.rules.slice(0, 8).map((r) => (
                <li key={r.trashId} className="contents">
                  <span className={cx('text-right font-semibold', r.points > 0 ? 'text-teal' : 'text-warn')}>{points(r.points)}</span>
                  <span className="text-soft">
                    {r.label} <span className="text-dim">{r.name}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function Item({ item }: { item: ComparisonView }) {
  const [open, setOpen] = useState(false);
  const update = (v: ComparisonView) => queryClient.setQueryData<CompareView>(['compare'], (old) => old && { ...old, items: old.items.map((i) => (i.id === v.id ? v : i)) });
  const explain = useMutation({ mutationFn: () => api<ComparisonView>(`/compare/${item.id}/explain`, { body: {} }), onSuccess: update });
  const again = useMutation({ mutationFn: () => api<ComparisonView>(`/compare/${item.id}/again`, { body: {} }), onSuccess: update });
  const v = verdict(item.verdict);
  return (
    <li className="flex flex-col gap-3 rounded-[16px] border border-line bg-panel px-5 py-4">
      <div className="flex flex-wrap items-start gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-baseline gap-3">
            {item.movieId ? (
              <Link to={`/movies/${item.movieId}`} className="text-[17px] font-semibold text-text no-underline hover:underline">
                {item.title}
              </Link>
            ) : (
              <span className="text-[17px] font-semibold">{item.title}</span>
            )}
            <span className="text-xs text-dim">Radarr downloaded it {when(item.grabbedAt)}</span>
          </div>
          <div className={cx('text-sm font-semibold', v?.tone ?? (item.status === 'failed' ? 'text-warn' : 'text-muted'))}>
            {v?.label ?? (item.status === 'failed' ? 'Couldn’t compare' : 'Waiting')}
            {item.mode === 'same_list' && <span className="font-normal text-dim"> · judged on Radarr’s own list</span>}
          </div>
          <p className="m-0 text-sm text-soft">{item.summary}</p>
        </div>
        {item.status !== 'waiting' && (
          <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="h-11 text-sm font-medium text-amber">
            {open ? 'Hide details' : 'Details'}
          </button>
        )}
      </div>
      {open && (
        <>
          <div className="flex flex-wrap gap-3">
            <CopyBox who="Radarr downloaded" c={item.radarrCopy} extra={`Radarr: ${item.radarrQuality}, ${points(item.radarrScore)} points`} />
            <CopyBox who={`Marquee would pick${item.profileName ? ` (${item.profileName})` : ''}`} c={item.marqueeCopy} />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="ghost" disabled={explain.isPending} onClick={() => explain.mutate()}>
              {explain.isPending ? 'Asking Radarr…' : 'Judge Radarr’s own list'}
            </Button>
            <Button type="button" variant="ghost" disabled={again.isPending} onClick={() => again.mutate()}>
              {again.isPending ? 'Searching…' : 'Search my Sources again'}
            </Button>
          </div>
          <p className="m-0 text-xs text-dim">“Judge Radarr’s own list” asks Radarr for the copies it saw for this movie, so both are judged on exactly the same choices. It can take a minute.</p>
          {(explain.error || again.error) && <Notice tone="error">{errMsg(explain.error ?? again.error)}</Notice>}
        </>
      )}
    </li>
  );
}
