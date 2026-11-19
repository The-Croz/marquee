import { useQuery } from '@tanstack/react-query';
import type { WatchersView } from '@marquee/shared';
import { api } from '../api';
import { Card } from './ui';

const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

/** "Who's watched" on a title's page, from Plex and Jellyfin. Admins only. */
export function Watchers({ kind, id }: { kind: 'movie' | 'tv'; id: number }) {
  const q = useQuery({ queryKey: ['watchers', kind, id], queryFn: () => api<WatchersView>(`/activity/watchers?kind=${kind}&id=${id}`) });
  if (!q.data) return null;
  return (
    <Card className="flex flex-col gap-2">
      <h2 className="m-0 text-lg font-semibold">Who’s watched</h2>
      {q.data.watchers.length === 0 ? (
        <p className="m-0 text-sm text-muted">Nobody yet, as far as Plex and Jellyfin have told Marquee.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0">
          {q.data.watchers.map((w) => (
            <li key={w.user} className="flex flex-wrap items-baseline justify-between gap-2 border-t border-line py-2 text-[15px] first:border-t-0">
              <span className="font-medium">{w.user}</span>
              <span className="text-sm text-muted">
                {w.episodes !== null ? `${w.episodes} ${w.episodes === 1 ? 'episode' : 'episodes'} · ` : w.plays > 1 ? `${w.plays} times · ` : ''}last {day(w.last)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
