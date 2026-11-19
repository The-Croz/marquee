import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import type { ActivityStats, NowPlayingView, PlayView } from '@marquee/shared';
import { api, ApiFailure, queryClient } from '../api';
import { Button, Card, Notice, Progress } from '../components/ui';

const SERVER = { plex: 'Plex', jellyfin: 'Jellyfin' } as const;
const STATE = { playing: 'Playing', paused: 'Paused', buffering: 'Buffering' } as const;

function when(ms: number): string {
  const d = Date.now() - ms;
  if (d < 3_600_000) return `${Math.max(1, Math.round(d / 60_000))} min ago`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)} h ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const Name = ({ href, children }: { href: string | null; children: string }) => (href ? <Link to={href}>{children}</Link> : <>{children}</>);

function NowPlaying() {
  const q = useQuery({ queryKey: ['activity', 'now'], queryFn: () => api<{ sessions: NowPlayingView[]; problems: string[] }>('/activity/now'), refetchInterval: 15_000 });
  return (
    <Card className="flex flex-col gap-3">
      <h2 className="m-0 text-lg font-semibold">Watching now</h2>
      {q.data?.problems.map((p) => (
        <Notice key={p} tone="error">
          {p} Check it under Settings → Services.
        </Notice>
      ))}
      {q.data && q.data.sessions.length === 0 && <p className="m-0 text-sm text-muted">Nobody is watching right now. This page checks every 15 seconds.</p>}
      {q.data?.sessions.map((s, i) => (
        <div key={i} className="flex flex-col gap-1.5 border-t border-line pt-3 first:border-t-0 first:pt-0">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-[15px] font-semibold">
              <Name href={s.href}>{s.title}</Name>
              {s.subtitle && <span className="font-normal text-soft"> · {s.subtitle}</span>}
            </span>
            <span className="text-sm text-muted">
              {s.user} · {s.device} · {SERVER[s.server]}
            </span>
          </div>
          <Progress value={Math.round(s.progress * 100)} />
          <span className="text-xs text-dim">
            {STATE[s.state]}
            {s.transcoding && ' · Plex or Jellyfin is converting it for this device (uses extra power on the server)'}
          </span>
        </div>
      ))}
    </Card>
  );
}

function Top({ title, rows }: { title: string; rows: { name: string; plays: number }[] }) {
  return (
    <Card className="flex flex-col gap-2">
      <h3 className="m-0 text-base font-semibold">{title}</h3>
      {rows.length === 0 && <p className="m-0 text-sm text-muted">Nothing yet.</p>}
      <ol className="m-0 flex list-none flex-col gap-1 p-0">
        {rows.map((r) => (
          <li key={r.name} className="flex justify-between gap-3 text-sm">
            <span className="truncate">{r.name}</span>
            <span className="flex-none text-muted">{r.plays}</span>
          </li>
        ))}
      </ol>
    </Card>
  );
}

function Stats() {
  const q = useQuery({ queryKey: ['activity', 'stats'], queryFn: () => api<ActivityStats>('/activity/stats') });
  const s = q.data;
  if (!s) return null;
  const peak = Math.max(1, ...s.perDay.map((d) => d.plays));
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
          {s.perDay.map((d) => (
            <div key={d.day} title={`${d.day}: ${d.plays}`} className="flex-1 rounded-t bg-amber/80" style={{ height: `${Math.max(d.plays ? 6 : 2, (d.plays / peak) * 100)}%`, opacity: d.plays ? 1 : 0.25 }} />
          ))}
        </div>
      </Card>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-4">
        <Top title="Who watches most" rows={s.users} />
        <Top title="Most watched movies" rows={s.movies} />
        <Top title="Most watched shows" rows={s.shows} />
      </div>
    </>
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
          <p className="m-0 max-w-[640px] text-[15px] text-muted">Who is watching and what was watched, from Plex and Jellyfin. Marquee only reads from them.</p>
        </div>
        <Button variant="ghost" onClick={update} disabled={busy}>
          {busy ? 'Updating…' : 'Update now'}
        </Button>
      </div>
      {note && <Notice tone={note.tone}>{note.text}</Notice>}
      <NowPlaying />
      <Stats />
      <History />
    </div>
  );
}
