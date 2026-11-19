import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import type { PersonView } from '@marquee/shared';
import { api, ApiFailure } from '../api';
import { Button, Card, Notice } from '../components/ui';
import { Name, SERVER, when } from './Activity';

const RES: Record<string, string> = { '4k': '4K', '1080': '1080p', '720': '720p', '480': '480p', sd: 'SD' };

/** One person's watching: what they watch most, on what, and the latest. */
export function PersonPage() {
  const { name = '' } = useParams();
  const q = useQuery({ queryKey: ['activity', 'person', name], queryFn: () => api<PersonView>(`/activity/people/${encodeURIComponent(name)}`) });
  const p = q.data;
  return (
    <div className="flex max-w-[1000px] flex-col gap-5">
      <div className="flex flex-col gap-2">
        <Link to="/activity" className="flex min-h-11 items-center self-start text-sm">
          ← Activity
        </Link>
        <h1 className="m-0 font-display text-[56px] leading-none font-normal">{p?.name ?? name}</h1>
        {p && (
          <p className="m-0 text-[15px] text-muted">
            {p.plays} watched{p.hours > 0 && ` · ${p.hours} hours since Marquee started watching`}
            {p.last && ` · last ${when(p.last)}`}
            {p.devices.length > 0 && ` · ${p.devices.join(', ')}`}
          </p>
        )}
      </div>
      {q.error && <Notice tone="error">{q.error instanceof ApiFailure ? q.error.message : 'Something went wrong.'}</Notice>}
      {p && <PersonBody p={p} />}
    </div>
  );
}

/** What someone watches most, their recent streams and their history. */
function PersonBody({ p, more }: { p: PersonView; more?: React.ReactNode }) {
  return (
    <>
          <Card className="flex flex-col gap-2">
            <h2 className="m-0 text-lg font-semibold">Watches most</h2>
            <ol className="m-0 flex list-none flex-col gap-1 p-0">
              {p.top.map((t) => (
                <li key={t.name} className="flex justify-between gap-3 text-[15px]">
                  <span className="truncate">{t.name}</span>
                  <span className="text-muted">{t.plays}</span>
                </li>
              ))}
            </ol>
          </Card>
          {p.streams.length > 0 && (
            <Card className="flex flex-col gap-1">
              <h2 className="m-0 mb-2 text-lg font-semibold">Recent streams</h2>
              {p.streams.map((s) => (
                <div key={s.id} className="flex flex-wrap items-baseline justify-between gap-2 border-t border-line py-2.5 text-[15px]">
                  <span>
                    {s.title}
                    {s.subtitle && <span className="text-soft"> · {s.subtitle}</span>}
                  </span>
                  <span className="text-sm text-muted">
                    {s.going ? 'Watching now' : `${Math.max(1, Math.round(s.watchedMs / 60_000))} min`} · {s.device}
                    {s.resolution && ` · ${RES[s.resolution] ?? s.resolution}`}
                    {s.converted && ' · converted'} · {when(s.startedAt)}
                  </span>
                </div>
              ))}
            </Card>
          )}
          <Card className="flex flex-col gap-1">
            <h2 className="m-0 mb-2 text-lg font-semibold">History</h2>
            {p.recent.map((r) => (
              <div key={r.id} className="flex flex-wrap items-baseline justify-between gap-2 border-t border-line py-2.5 text-[15px]">
                <span>
                  <Name href={r.href}>{r.title}</Name>
                  {r.subtitle && <span className="text-soft"> · {r.subtitle}</span>}
                </span>
                <span className="text-sm text-muted">
                  {SERVER[r.server]} · {when(r.at)}
                </span>
              </div>
            ))}
          </Card>
      {more}
    </>
  );
}

/** "My history": your own watching on Plex and Jellyfin. Everyone sees only their own. */
export function MyHistoryPage() {
  const [limit, setLimit] = useState(50);
  const q = useQuery({ queryKey: ['activity', 'mine', limit], queryFn: () => api<PersonView & { total: number }>(`/activity/mine?limit=${limit}`), placeholderData: (prev) => prev });
  const p = q.data;
  return (
    <div className="flex max-w-[1000px] flex-col gap-5">
      <div className="flex flex-col gap-2">
        <h1 className="m-0 font-display text-[56px] leading-none font-normal">My history</h1>
        <p className="m-0 text-[15px] text-muted">
          {p
            ? p.plays
              ? `${p.plays} watched${p.hours > 0 ? ` · ${p.hours} hours since Marquee started watching` : ''}${p.last ? ` · last ${when(p.last)}` : ''}`
              : 'What you watch on Plex and Jellyfin shows up here.'
            : 'Loading…'}
        </p>
      </div>
      {q.error && <Notice tone="error">{q.error instanceof ApiFailure ? q.error.message : 'Something went wrong.'}</Notice>}
      {p && p.plays === 0 && (
        <Notice>Nothing yet. Marquee copies what you’ve watched from Plex and Jellyfin every 15 minutes. If you watch there under a different name, ask an admin to link your account in Settings → Users.</Notice>
      )}
      {p && p.plays > 0 && (
        <PersonBody
          p={p}
          more={
            p.total > p.recent.length && (
              <Button type="button" variant="ghost" className="self-start" disabled={q.isFetching} onClick={() => setLimit(limit + 100)}>
                {q.isFetching ? 'Loading…' : `Show more (${p.total - p.recent.length} older)`}
              </Button>
            )
          }
        />
      )}
    </div>
  );
}
