import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import type { CutoverStep, CutoverView, WantedRunView } from '@marquee/shared';
import { ApiFailure, api, queryClient } from '../api';
import { Button, Card, Notice, cx } from '../components/ui';

/**
 * Switch movies over from Radarr: what Marquee checked for itself, what's
 * left to do (some of it in Radarr), and the switch that has Marquee look
 * for wanted movies from now on.
 */

const errMsg = (e: unknown) => (e instanceof ApiFailure ? e.message : 'Something went wrong.');

const MARK: Record<CutoverStep['state'], { sign: string; label: string; tone: string }> = {
  done: { sign: '✓', label: 'Done', tone: 'border-teal text-teal-hi' },
  todo: { sign: '·', label: 'To do', tone: 'border-line-strong text-soft' },
  warn: { sign: '!', label: 'Worth a look', tone: 'border-amber text-amber-hi' },
  unknown: { sign: '?', label: 'Can’t check', tone: 'border-line-strong text-muted' },
};

function when(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

function RunLine({ r }: { r: WantedRunView }) {
  const what = r.kind === 'missing' ? 'Looked for missing movies' : 'Looked for better copies';
  return (
    <li className="flex flex-col gap-0.5 text-sm">
      <span className="text-soft">
        {what} {when(r.at)} · searched {r.searched} · sent {r.sent.length}
      </span>
      {r.sent.map((s) => (
        <span key={s.movieId} className="text-teal-hi">
          → <Link to={`/movies/${s.movieId}`}>{s.title}</Link> <span className="font-mono text-[12px] text-dim">{s.copy}</span>
        </span>
      ))}
      {r.problems.map((p) => (
        <span key={p} className="text-warn">
          {p}
        </span>
      ))}
    </li>
  );
}

export function SwitchOverPage() {
  const q = useQuery({ queryKey: ['cutover'], queryFn: () => api<CutoverView>('/cutover') });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const v = q.data;

  async function toggle(on: boolean) {
    setBusy(true);
    setError(null);
    try {
      queryClient.setQueryData(['cutover'], await api<CutoverView>('/cutover', { method: 'PUT', body: { lookForWanted: on } }));
      setConfirm(false);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  async function lookNow(kind: 'missing' | 'better') {
    setBusy(true);
    setError(null);
    try {
      await api<WantedRunView>('/cutover/look-now', { body: { kind } });
      await queryClient.invalidateQueries({ queryKey: ['cutover'] });
      await queryClient.invalidateQueries({ queryKey: ['downloads'] });
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  const radarrOff = v?.steps.find((s) => s.key === 'radarr_off');
  return (
    <>
      <div className="flex flex-col gap-2">
        <h1 className="m-0 font-display text-[56px] leading-none font-normal">Switch movies over</h1>
        <p className="m-0 max-w-[720px] text-[15px] leading-relaxed text-muted">
          When these are done, Marquee takes over movies from Radarr: it looks for the movies you want, downloads them, and puts them in your library. Marquee checks what it can by itself; the
          Radarr step you do in Radarr. Nothing here changes Radarr.
        </p>
      </div>
      {q.error && <Notice tone="error">{errMsg(q.error)}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      {!v && !q.error && <p className="text-muted">Checking…</p>}
      {v && (
        <>
          <ol className="m-0 flex list-none flex-col gap-3 p-0">
            {v.steps.map((s, i) => {
              const m = MARK[s.state];
              return (
                <li key={s.key}>
                  <Card className="flex gap-4">
                    <span aria-hidden="true" className={cx('flex size-9 flex-none items-center justify-center rounded-full border-2 font-bold', m.tone)}>
                      {s.state === 'todo' ? i + 1 : m.sign}
                    </span>
                    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                      <h2 className="m-0 text-[17px] font-semibold">
                        {s.title} <span className={cx('text-sm font-normal', m.tone.split(' ')[1])}>· {m.label}</span>
                      </h2>
                      <p className="m-0 text-sm text-soft">{s.detail}</p>
                      {s.action && (
                        <Link to={s.action.to} className="flex min-h-11 items-center self-start text-sm font-medium">
                          {s.action.label} →
                        </Link>
                      )}
                      {s.key === 'take_over' && (
                        <div className="mt-1 flex flex-col gap-3">
                          {!v.lookingForWanted && !confirm && (
                            <Button type="button" className="self-start" disabled={busy} onClick={() => (v.ready ? toggle(true) : setConfirm(true))}>
                              Turn on
                            </Button>
                          )}
                          {confirm && (
                            <div role="alertdialog" aria-label="Turn on before the other steps?" className="flex flex-col gap-2 rounded-xl border border-amber px-4 py-3 text-sm">
                              <p className="m-0 text-soft">
                                Not every step above is done.
                                {radarrOff?.state !== 'done' && ' While Radarr still looks for movies too, a movie could be downloaded twice.'} Turn it on anyway?
                              </p>
                              <div className="flex flex-wrap gap-2">
                                <Button type="button" disabled={busy} onClick={() => toggle(true)}>
                                  Turn on anyway
                                </Button>
                                <Button type="button" variant="ghost" onClick={() => setConfirm(false)}>
                                  Cancel
                                </Button>
                              </div>
                            </div>
                          )}
                          {v.lookingForWanted && (
                            <div className="flex flex-wrap gap-2">
                              <Button type="button" variant="ghost" className="h-11 px-3.5 text-sm" disabled={busy} onClick={() => lookNow('missing')}>
                                {busy ? 'Looking…' : 'Look for missing movies now'}
                              </Button>
                              <Button type="button" variant="ghost" className="h-11 px-3.5 text-sm" disabled={busy} onClick={() => lookNow('better')}>
                                Look for better copies now
                              </Button>
                              <Button type="button" variant="ghost" className="h-11 px-3.5 text-sm" disabled={busy} onClick={() => toggle(false)}>
                                Turn off
                              </Button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </Card>
                </li>
              );
            })}
          </ol>
          {v.runs.length > 0 && (
            <section aria-labelledby="runs" className="flex flex-col gap-2">
              <h2 id="runs" className="m-0 text-xs font-normal tracking-[.08em] text-dim uppercase">
                Marquee’s own searches
              </h2>
              <ul className="m-0 flex list-none flex-col gap-3 p-0">
                {v.runs.map((r) => (
                  <RunLine key={`${r.kind}${r.at}`} r={r} />
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </>
  );
}
