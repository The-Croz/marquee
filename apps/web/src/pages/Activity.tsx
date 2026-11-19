import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import type { ActivityStats, NowPlayingView, PersonSummary, PlayView } from '@marquee/shared';
import { api, ApiFailure, queryClient } from '../api';
import { Button, Card, Notice, Progress, cx } from '../components/ui';
import { formatBytes } from '../components/Poster';

export const SERVER = { plex: 'Plex', jellyfin: 'Jellyfin' } as const;
const STATE = { playing: 'Playing', paused: 'Paused', buffering: 'Buffering' } as const;
const RES: Record<string, string> = { '4k': '4K', '1080': '1080p', '720': '720p', '480': '480p', sd: 'SD' };
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function when(ms: number): string {
  const d = Date.now() - ms;
  if (d < 3_600_000) return `${Math.max(1, Math.round(d / 60_000))} min ago`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)} h ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export const Name = ({ href, children }: { href: string | null; children: string }) => (href ? <Link to={href}>{children}</Link> : <>{children}</>);

interface Feed {
  sessions: NowPlayingView[];
  problems: string[];
  live: { server: 'plex' | 'jellyfin'; live: boolean }[];
}

/**
 * Watching now, pushed by the server the moment it changes. If the live line is
 * blocked (some proxies do that), it falls back to asking every 15 seconds.
 */
function useFeed(): { feed: Feed | null; pushed: boolean } {
  const [feed, setFeed] = useState<Feed | null>(null);
  const [pushed, setPushed] = useState(false);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const poll = () => api<Feed>('/activity/now').then((f) => !stopped && setFeed(f), () => {});
    const es = typeof EventSource === 'undefined' ? null : new EventSource('/api/activity/live');
    if (!es) {
      void poll();
      timer = setInterval(poll, 15_000);
    } else {
      es.addEventListener('sessions', (e) => {
        setPushed(true);
        setFeed(JSON.parse((e as MessageEvent<string>).data) as Feed);
      });
      es.onerror = () => {
        // Blocked or dropped: ask every 15 seconds until it reconnects.
        setPushed(false);
        if (!timer) {
          void poll();
          timer = setInterval(poll, 15_000);
        }
      };
      es.onopen = () => {
        if (timer) clearInterval(timer);
        timer = undefined;
      };
    }
    return () => {
      stopped = true;
      es?.close();
      if (timer) clearInterval(timer);
    };
  }, []);
  return { feed, pushed };
}

function StopBox({ s, done }: { s: NowPlayingView; done: () => void }) {
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function stop() {
    setBusy(true);
    setError(null);
    try {
      await api('/activity/stop', { body: { server: s.server, sessionId: s.sessionId, message } });
      done();
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : "Couldn't stop it.");
      setBusy(false);
    }
  }
  return (
    <div role="alertdialog" aria-label={`Stop ${s.user}'s stream?`} className="mt-1 flex flex-col gap-2 rounded-xl border border-amber px-4 py-3 text-sm">
      <strong>
        Stop {s.user}'s {s.title}?
      </strong>
      <span className="text-soft">It stops playing on their screen right away. They see your message.</span>
      <label htmlFor={`msg-${s.sessionId}`} className="sr-only">
        Message to show them
      </label>
      <input
        id={`msg-${s.sessionId}`}
        value={message}
        maxLength={200}
        onChange={(e) => setMessage(e.target.value)}
        placeholder="Message (optional), e.g. Time for bed!"
        className="h-11 rounded-xl border border-line bg-panel px-3 text-text"
      />
      {error && <Notice tone="error">{error}</Notice>}
      <div className="flex gap-2">
        <Button variant="danger" className="h-11 px-4 text-sm" disabled={busy} onClick={stop}>
          {busy ? 'Stopping…' : 'Stop stream'}
        </Button>
        <Button variant="ghost" className="h-11 px-4 text-sm" onClick={done}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function NowPlaying() {
  const { feed, pushed } = useFeed();
  const [stopping, setStopping] = useState<string | null>(null);
  const lines = feed?.live ?? [];
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="m-0 text-lg font-semibold">Watching now</h2>
        {feed && (
          <span className="text-xs text-dim">
            {pushed && lines.length > 0 && lines.every((l) => l.live)
              ? 'Live: changes show up at once.'
              : pushed
                ? 'Live from Marquee; checking Plex and Jellyfin every few seconds.'
                : 'Checking every 15 seconds.'}
          </span>
        )}
      </div>
      {feed?.problems.map((p) => (
        <Notice key={p} tone="error">
          {p} Check it under Settings → Services.
        </Notice>
      ))}
      {feed && feed.sessions.length === 0 && <p className="m-0 text-sm text-muted">Nobody is watching right now.</p>}
      {feed?.sessions.map((s) => (
        <div key={`${s.server}${s.sessionId}`} className="flex flex-col gap-1.5 border-t border-line pt-3 first:border-t-0 first:pt-0">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-[15px] font-semibold">
              <Name href={s.href}>{s.title}</Name>
              {s.subtitle && <span className="font-normal text-soft"> · {s.subtitle}</span>}
            </span>
            <span className="text-sm text-muted">
              <Link to={`/activity/people/${encodeURIComponent(s.user)}`}>{s.user}</Link> · {s.device} · {SERVER[s.server]}
            </span>
          </div>
          <Progress value={Math.round(s.progress * 100)} />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-dim">
              {STATE[s.state]} · {s.platform}
              {s.resolution && ` · ${RES[s.resolution] ?? s.resolution}`}
              {s.transcoding && ' · being converted for this device (uses extra power on the server)'}
            </span>
            {stopping !== s.sessionId && (
              <Button variant="ghost" className="h-11 px-3.5 text-sm" onClick={() => setStopping(s.sessionId)}>
                Stop…
              </Button>
            )}
          </div>
          {stopping === s.sessionId && <StopBox s={s} done={() => setStopping(null)} />}
        </div>
      ))}
    </Card>
  );
}

function Bars({ title, values, labels, peakLabel }: { title: string; values: number[]; labels: string[]; peakLabel?: string }) {
  const peak = Math.max(1, ...values);
  return (
    <Card className="flex flex-col gap-2">
      <h3 className="m-0 text-base font-semibold">{title}</h3>
      <div role="img" aria-label={`${title}: ${values.map((v, i) => `${labels[i]} ${v}`).join(', ')}`} className="flex h-24 items-end gap-[3px]">
        {values.map((v, i) => (
          <div key={i} title={`${labels[i]}: ${v}`} className="flex-1 rounded-t bg-amber/80" style={{ height: `${Math.max(v ? 6 : 2, (v / peak) * 100)}%`, opacity: v ? 1 : 0.25 }} />
        ))}
      </div>
      <div className="flex justify-between text-[11px] text-dim" aria-hidden="true">
        <span>{labels[0]}</span>
        <span>{peakLabel}</span>
        <span>{labels[labels.length - 1]}</span>
      </div>
    </Card>
  );
}

function Top({ title, rows, unit }: { title: string; rows: { name: string; n: number }[]; unit?: string }) {
  return (
    <Card className="flex flex-col gap-2">
      <h3 className="m-0 text-base font-semibold">{title}</h3>
      {rows.length === 0 && <p className="m-0 text-sm text-muted">Nothing yet.</p>}
      <ol className="m-0 flex list-none flex-col gap-1 p-0">
        {rows.map((r) => (
          <li key={r.name} className="flex justify-between gap-3 text-sm">
            <span className="truncate">{RES[r.name] ?? r.name}</span>
            <span className="flex-none text-muted">
              {r.n}
              {unit}
            </span>
          </li>
        ))}
      </ol>
    </Card>
  );
}

const rows = (list: { name: string; plays: number }[]) => list.map((r) => ({ name: r.name, n: r.plays }));

function Stats() {
  const q = useQuery({ queryKey: ['activity', 'stats'], queryFn: () => api<ActivityStats>('/activity/stats') });
  const s = q.data;
  if (!s) return null;
  const hourLabels = s.hours.map((_, h) => `${h}:00`);
  const busiest = s.hours.indexOf(Math.max(...s.hours));
  return (
    <>
      <Card className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="m-0 text-lg font-semibold">Last {s.days} days</h2>
          <span className="text-sm text-muted">
            {s.total} watched · {s.last24h} in the last day · Plex {s.servers.plex}, Jellyfin {s.servers.jellyfin}
          </span>
        </div>
        <div role="img" aria-label={`Watches per day over the last ${s.days} days, ${s.total} in all`} className="flex h-28 items-end gap-[3px]">
          {s.perDay.map((d) => {
            const peak = Math.max(1, ...s.perDay.map((x) => x.plays));
            return <div key={d.day} title={`${d.day}: ${d.plays}`} className="flex-1 rounded-t bg-amber/80" style={{ height: `${Math.max(d.plays ? 6 : 2, (d.plays / peak) * 100)}%`, opacity: d.plays ? 1 : 0.25 }} />;
          })}
        </div>
      </Card>

      {s.live.streams > 0 && (
        <Card className="flex flex-wrap gap-x-8 gap-y-3">
          {[
            ['Time watched', `${s.live.watchHours} h`],
            ['Streams', String(s.live.streams)],
            ['Most at once', String(s.live.peakStreams)],
            ['Played directly', String(s.live.direct)],
            ['Converted', String(s.live.converted)],
          ].map(([k, v]) => (
            <div key={k} className="flex flex-col">
              <span className="text-2xl font-semibold">{v}</span>
              <span className="text-xs text-muted">{k}</span>
            </div>
          ))}
        </Card>
      )}

      <div className="grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-4">
        <Bars title="Busiest hours" values={s.hours} labels={hourLabels} peakLabel={s.total ? `busiest ${busiest}:00` : undefined} />
        <Bars title="Busiest days" values={s.weekdays} labels={DAYS} />
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-4">
        <Top title="Who watches most" rows={rows(s.users)} />
        <Top title="Most watched movies" rows={rows(s.movies)} />
        <Top title="Most watched shows" rows={rows(s.shows)} />
        {s.live.streams > 0 && (
          <>
            <Top title="Time watched by person" rows={s.live.watchTime.map((w) => ({ name: w.name, n: w.hours }))} unit=" h" />
            <Top title="Apps and devices" rows={rows(s.live.platforms)} />
            <Top title="Picture quality" rows={rows(s.live.resolutions)} />
          </>
        )}
      </div>
      {s.library.files > 0 && (
        <Card className="flex flex-col gap-3">
          <h2 className="m-0 text-lg font-semibold">Library</h2>
          <p className="m-0 text-sm text-muted">
            {s.library.files} files · {formatBytes(s.library.bytes)}
          </p>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-4">
            <Top title="By picture size" rows={s.library.resolutions.map((r) => ({ name: r.name, n: r.count }))} />
            <Top title="By video format" rows={s.library.codecs.map((r) => ({ name: r.name, n: r.count }))} />
          </div>
        </Card>
      )}
    </>
  );
}

function People() {
  const q = useQuery({ queryKey: ['activity', 'people'], queryFn: () => api<{ people: PersonSummary[] }>('/activity/people') });
  if (!q.data || q.data.people.length === 0) return null;
  return (
    <Card className="flex flex-col gap-1">
      <h2 className="m-0 mb-2 text-lg font-semibold">People</h2>
      {q.data.people.map((p) => (
        <Link key={p.name} to={`/activity/people/${encodeURIComponent(p.name)}`} className={cx('flex min-h-11 flex-wrap items-center justify-between gap-2 border-t border-line py-2 text-[15px] no-underline')}>
          <span className="font-medium text-text">{p.name}</span>
          <span className="text-sm text-muted">
            {p.plays} watched{p.hours > 0 && ` · ${p.hours} h`}
            {p.last && ` · last ${when(p.last)}`}
          </span>
        </Link>
      ))}
    </Card>
  );
}

function History() {
  const [pages, setPages] = useState(1);
  const q = useQuery({ queryKey: ['activity', 'history', pages], queryFn: () => api<{ plays: PlayView[]; total: number }>(`/activity/history?limit=${pages * 30}`) });
  return (
    <Card className="flex flex-col gap-1">
      <h2 className="m-0 mb-2 text-lg font-semibold">History</h2>
      {q.data?.plays.length === 0 && <p className="m-0 text-sm text-muted">No watches copied yet. Marquee copies them from Plex and Jellyfin every 15 minutes; press Update now to do it at once.</p>}
      {q.data?.plays.map((p) => (
        <div key={p.id} className="flex flex-wrap items-baseline justify-between gap-2 border-t border-line py-2.5 text-[15px]">
          <span>
            <Name href={p.href}>{p.title}</Name>
            {p.subtitle && <span className="text-soft"> · {p.subtitle}</span>}
          </span>
          <span className="text-sm text-muted">
            {p.user} · {SERVER[p.server]} · {when(p.at)}
          </span>
        </div>
      ))}
      {q.data && q.data.total > q.data.plays.length && (
        <div className="pt-3">
          <Button variant="ghost" onClick={() => setPages(pages + 1)}>
            Show more
          </Button>
        </div>
      )}
    </Card>
  );
}

export function ActivityPage() {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  async function update() {
    setBusy(true);
    setNote(null);
    try {
      const r = await api<{ added: number; problems: string[] }>('/activity/sync', { body: {} });
      setNote(r.problems.length ? { tone: 'error', text: r.problems.join(' ') } : { tone: 'success', text: r.added ? `Copied ${r.added} new ${r.added === 1 ? 'watch' : 'watches'}.` : 'Already up to date.' });
      queryClient.invalidateQueries({ queryKey: ['activity'] });
    } catch (e) {
      setNote({ tone: 'error', text: e instanceof ApiFailure ? e.message : "Couldn't update." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex max-w-[1000px] flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-2">
          <h1 className="m-0 font-display text-[56px] leading-none font-normal">Activity</h1>
          <p className="m-0 max-w-[640px] text-[15px] text-muted">Who is watching and what was watched, from Plex and Jellyfin. Marquee reads from them, and can stop a stream if you ask it to.</p>
        </div>
        <Button variant="ghost" onClick={update} disabled={busy}>
          {busy ? 'Updating…' : 'Update now'}
        </Button>
      </div>
      {note && <Notice tone={note.tone}>{note.text}</Notice>}
      <NowPlaying />
      <Stats />
      <People />
      <History />
    </div>
  );
}
