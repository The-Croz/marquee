import { useState } from 'react';
import { Link, NavLink } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import type { CutoverStep, CutoverView, WantedRunView } from '@marquee/shared';
import { ApiFailure, api, queryClient } from '../api';
import { Button, Card, Notice, cx } from '../components/ui';

/**
 * Switch movies over from Radarr, or TV from Sonarr: what Marquee checked for
 * itself, what's left to do (some of it in the old app), and the switch that
 * has Marquee look for wanted movies or episodes from now on.
 */

type Kind = 'movie' | 'tv';
type LookKind = WantedRunView['kind'];

const TEXT: Record<Kind, { heading: string; intro: string; oldApp: string; what: string }> = {
  movie: {
    heading: 'Switch movies over',
    intro:
      'When these are done, Marquee takes over movies from Radarr: it looks for the movies you want, downloads them, and puts them in your library. Marquee checks what it can by itself; the Radarr step you do in Radarr. Nothing here changes Radarr.',
    oldApp: 'Radarr',
    what: 'a movie',
  },
  tv: {
    heading: 'Switch TV over',
    intro:
      'When these are done, Marquee takes over TV from Sonarr: it catches new episodes as they come out, finds the ones you’re missing, and puts them in your library. Marquee checks what it can by itself; the Sonarr step you do in Sonarr. Nothing here changes Sonarr.',
    oldApp: 'Sonarr',
    what: 'an episode',
  },
};

const RUN_TEXT: Record<LookKind, { did: string; button: string }> = {
  new: { did: 'Read the newest copies', button: 'Check for new episodes now' },
  missing: { did: 'Looked for missing', button: 'Look for missing now' },
  better: { did: 'Looked for better copies', button: 'Look for better copies now' },
};

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

function RunLine({ r, kind }: { r: WantedRunView; kind: Kind }) {
  const what = r.kind === 'missing' ? `Looked for missing ${kind === 'movie' ? 'movies' : 'episodes'}` : RUN_TEXT[r.kind].did;
  return (
    <li className="flex flex-col gap-0.5 text-sm">
      <span className="text-soft">
        {what} {when(r.at)} · {r.kind === 'new' ? `looked at ${r.searched} ${r.searched === 1 ? 'copy' : 'copies'}` : `searched ${r.searched}`} · sent {r.sent.length}
      </span>
      {r.sent.map((s) => (
        <span key={s.title + s.copy} className="text-teal-hi">
          → <Link to={s.href}>{s.title}</Link> <span className="font-mono text-[12px] text-dim">{s.copy}</span>
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

export function SwitchOverPage({ kind = 'movie' }: { kind?: Kind }) {
  const base = kind === 'movie' ? '/cutover' : '/cutover/tv';
  const key = ['cutover', kind];
  const text = TEXT[kind];
  const q = useQuery({ queryKey: key, queryFn: () => api<CutoverView>(base) });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const v = q.data;

  async function toggle(on: boolean) {
    setBusy(true);
    setError(null);
    try {
      queryClient.setQueryData(key, await api<CutoverView>(base, { method: 'PUT', body: { lookForWanted: on } }));
      setConfirm(false);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  async function lookNow(look: LookKind) {
    setBusy(true);
    setError(null);
    try {
      await api<WantedRunView>(`${base}/look-now`, { body: { kind: look } });
      await queryClient.invalidateQueries({ queryKey: key });
      await queryClient.invalidateQueries({ queryKey: ['downloads'] });
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  const oldAppOff = v?.steps.find((s) => s.key === 'radarr_off' || s.key === 'sonarr_off');
  const looks: LookKind[] = kind === 'movie' ? ['missing', 'better'] : ['new', 'missing', 'better'];
  return (
    <>
      <div className="flex flex-col gap-2">
        <nav aria-label="What to switch over" className="flex gap-2">
          {(
            [
              ['/switch-over', 'Movies'],
              ['/switch-over/tv', 'TV'],
            ] as const
          ).map(([to, label]) => (
            <NavLink
              key={to}
              to={to}
              end
              className={({ isActive }) =>
                cx('flex min-h-11 items-center rounded-full border px-4 text-sm font-medium no-underline', isActive ? 'border-amber bg-amber text-amber-ink' : 'border-line-strong text-soft')
              }
            >
              {label}
            </NavLink>
          ))}
        </nav>
        <h1 className="m-0 font-display text-[56px] leading-none font-normal">{text.heading}</h1>
        <p className="m-0 max-w-[720px] text-[15px] leading-relaxed text-muted">{text.intro}</p>
      </div>
      {q.error && <Notice tone="error">{errMsg(q.error)}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      {busy && <p role="status" className="m-0 text-sm text-muted">Looking… this can take a minute while every Source is asked.</p>}
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
                                {oldAppOff?.state !== 'done' && ` While ${text.oldApp} is still looking too, ${text.what} could be downloaded twice.`} Turn it on anyway?
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
                              {looks.map((l) => (
                                <Button key={l} type="button" variant="ghost" className="h-11 px-3.5 text-sm" disabled={busy} onClick={() => lookNow(l)}>
                                  {l === 'missing' ? `Look for missing ${kind === 'movie' ? 'movies' : 'episodes'} now` : RUN_TEXT[l].button}
                                </Button>
                              ))}
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
                  <RunLine key={`${r.kind}${r.at}`} r={r} kind={kind} />
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </>
  );
}
