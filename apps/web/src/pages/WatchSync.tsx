import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { WatchSyncPlan, WatchSyncRun, WatchSyncStatus } from '@marquee/shared';
import { api, ApiFailure, queryClient } from '../api';
import { Button, Card, Notice } from '../components/ui';
import { InfoTip } from '../components/Page';

const errMsg = (e: unknown) => (e instanceof ApiFailure ? e.message : 'Something went wrong. Try again.');
const when = (t: number) => new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const ticks = (n: number) => `${n} ${n === 1 ? 'tick' : 'ticks'}`;

function lastLine(r: WatchSyncRun): string {
  const base = r.ticked ? `Last sync ${when(r.at)}: added ${ticks(r.ticked)}.` : `Last sync ${when(r.at)}: everything already matched.`;
  return r.failed ? `${base} ${r.failed} couldn’t be added and will be tried again next time.` : base;
}

/** Settings → Watched sync: keep "watched" the same on Plex and Jellyfin. Admins. */
export function WatchSyncPage() {
  const status = useQuery({ queryKey: ['watch-sync'], queryFn: () => api<WatchSyncStatus>('/watch-sync') });
  const [plan, setPlan] = useState<WatchSyncPlan | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  async function act(what: string, f: () => Promise<string | void>) {
    setBusy(what);
    setError(null);
    setSaid(null);
    try {
      const msg = await f();
      if (msg) setSaid(msg);
      await queryClient.invalidateQueries({ queryKey: ['watch-sync'] });
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(null);
    }
  }
  const check = () => act('check', async () => setPlan(await api<WatchSyncPlan>('/watch-sync/plan')));
  const run = () =>
    act('run', async () => {
      const r = await api<WatchSyncRun>('/watch-sync/run', { body: {} });
      setPlan(null);
      return r.problem ?? lastLine(r);
    });
  const toggle = (enabled: boolean) => act('toggle', async () => void (await api('/watch-sync/enabled', { method: 'PUT', body: { enabled } })));
  const undo = (at: number, n: number) => {
    if (!window.confirm(`Take back the ${ticks(n)} added on ${when(at)}? Those titles go back to unwatched where Marquee ticked them.`)) return;
    void act(`undo${at}`, async () => {
      const r = await api<{ undone: number; failed: number }>('/watch-sync/undo', { body: { at } });
      return `Took back ${ticks(r.undone)}.${r.failed ? ` ${r.failed} couldn’t be reached; try again later.` : ''}`;
    });
  };

  const s = status.data;
  if (!s) return <p className="text-muted">Loading…</p>;
  return (
    <div className="flex max-w-[760px] flex-col gap-6">
      <Card className="flex flex-col gap-4">
        <div>
          <h2 className="m-0 text-lg font-semibold">Watched on one, watched on both</h2>
          <p className="m-0 text-sm text-muted">
            Watch it on Plex and it's ticked on Jellyfin too, and the other way round.{' '}
            <InfoTip className="-my-3.5 align-middle" label="About watched sync">It only ever adds ticks, never takes one away, and every sync can be undone.</InfoTip>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className={s.enabled ? 'text-teal-hi' : 'text-muted'}>{s.enabled ? 'On · syncs every 30 minutes' : 'Off'}</span>
          <Button type="button" variant={s.enabled ? 'ghost' : 'primary'} disabled={busy !== null} onClick={() => toggle(!s.enabled)}>
            {s.enabled ? 'Pause' : 'Turn on'}
          </Button>
          <Button type="button" variant="ghost" disabled={busy !== null} onClick={check}>
            {busy === 'check' ? 'Checking…' : 'See what would change'}
          </Button>
        </div>
        {!s.enabled && !s.last && <Notice>Start with “See what would change”. The first sync can add a lot of ticks if the servers have drifted apart.</Notice>}
        {s.last && (s.last.problem ? <Notice tone="error">{s.last.problem}</Notice> : <p className="m-0 text-sm text-soft">{lastLine(s.last)}</p>)}
        {error && <Notice tone="error">{error}</Notice>}
        {said && <Notice tone="success">{said}</Notice>}
      </Card>

      {plan && (
        <Card className="flex flex-col gap-3">
          <h2 className="m-0 text-lg font-semibold">What a sync would do now</h2>
          {!plan.ready ? (
            <Notice tone="error">{plan.problem}</Notice>
          ) : (
            <>
              {plan.people.length === 0 && <Notice>Nobody is linked to Plex or Jellyfin yet. Link people in Settings → Users.</Notice>}
              <ul className="m-0 flex list-none flex-col p-0">
                {plan.people.map((p) => (
                  <li key={p.userId} className="flex flex-col gap-1 border-t border-line py-3 first:border-0">
                    <span className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="text-body font-semibold">{p.name}</span>
                      {p.state === 'linked' && (
                        <span className="text-sm text-muted">
                          {p.toJellyfin + p.toPlex === 0 ? 'Already the same' : `${ticks(p.toJellyfin)} on Jellyfin · ${ticks(p.toPlex)} on Plex`}
                        </span>
                      )}
                    </span>
                    {p.note && <span className={p.state === 'problem' ? 'text-sm text-warn' : 'text-sm text-dim'}>{p.note}</span>}
                    {p.examples && p.examples.length > 0 && <span className="text-sm text-dim">For example: {p.examples.join(', ')}</span>}
                  </li>
                ))}
              </ul>
              <Button type="button" className="self-start" disabled={busy !== null || plan.total === 0} onClick={run}>
                {busy === 'run' ? 'Syncing…' : plan.total ? `Add these ${ticks(plan.total)} now` : 'Nothing to add'}
              </Button>
            </>
          )}
        </Card>
      )}

      <Card className="flex flex-col gap-2">
        <h2 className="m-0 text-lg font-semibold">Recent syncs</h2>
        {s.runs.length === 0 && <p className="m-0 text-sm text-muted">Nothing synced yet. Syncs that add ticks show here, with a way to undo them.</p>}
        {s.runs.map((r) => (
          <details key={r.at} className="border-t border-line first-of-type:border-0">
            <summary className="flex min-h-11 cursor-pointer flex-wrap items-center justify-between gap-2 py-2 text-body">
              <span>
                {when(r.at)} · {ticks(r.ticks)}
                {r.undone > 0 && <span className="text-dim"> · {r.undone === r.ticks ? 'undone' : `${r.undone} undone`}</span>}
              </span>
              {r.undone < r.ticks && (
                <Button type="button" variant="ghost" disabled={busy !== null} onClick={(e) => (e.preventDefault(), undo(r.at, r.ticks - r.undone))}>
                  {busy === `undo${r.at}` ? 'Undoing…' : 'Undo'}
                </Button>
              )}
            </summary>
            <ul className="m-0 mb-2 flex list-none flex-col gap-1 p-0 text-sm text-soft">
              {r.items.map((i, n) => (
                <li key={n}>
                  {i.title} <span className="text-dim">· {i.person} · ticked on {i.server}</span>
                </li>
              ))}
              {r.ticks > r.items.length && <li className="text-dim">…and {r.ticks - r.items.length} more</li>}
            </ul>
          </details>
        ))}
      </Card>
    </div>
  );
}
