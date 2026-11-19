import { eq, isNotNull, sql } from 'drizzle-orm';
import type { RetireStep, RetireView } from '@marquee/shared';
import type { ActivityMonitor } from '../activity/live.js';
import type { Db } from '../db/index.js';
import { notificationChannels, plays, streams } from '../db/schema.js';
import { readMediaServer } from '../library/mediaServers.js';

/**
 * The "retire Tautulli" checklist. Marquee checks what it can see; the last
 * steps are yours. Tautulli's own history is not imported: Marquee copies what
 * Plex and Jellyfin remember, and records every stream from now on.
 */
export function retireTautulliChecklist({ db, activity }: { db: Db; activity: ActivityMonitor }): RetireView {
  const steps: RetireStep[] = [];
  const connected = (['plex', 'jellyfin'] as const).filter((k) => {
    const s = readMediaServer(db, k);
    return s.url && s.secret;
  });

  steps.push({
    key: 'servers',
    title: 'Plex (and Jellyfin) are connected',
    state: connected.length ? 'done' : 'todo',
    detail: connected.length ? `Connected: ${connected.map((k) => (k === 'plex' ? 'Plex' : 'Jellyfin')).join(' and ')}.` : 'Connect your media server so Marquee can see who is watching.',
    action: { label: 'Settings → Services', to: '/settings/services' },
  });

  const status = activity.status();
  const live = status.filter((s) => s.live).length;
  steps.push({
    key: 'live',
    title: 'Marquee hears about plays right away',
    state: !connected.length ? 'todo' : live === status.length ? 'done' : 'warn',
    detail: !connected.length
      ? 'Needs a connected server first.'
      : live === status.length
        ? 'The live line to each server is open, so a start, pause or stop shows up within a second.'
        : 'A server’s live line isn’t open, so Marquee looks every 5 seconds instead. That still works, just a little later. If it stays like this, check the server’s address under Settings → Services (a reverse proxy must allow websockets).',
    action: { label: 'Open Activity', to: '/activity' },
  });

  const copied = db.select({ n: sql<number>`count(*)` }).from(plays).get()?.n ?? 0;
  steps.push({
    key: 'history',
    title: 'Past watches are copied over',
    state: copied > 0 ? 'done' : 'todo',
    detail: copied > 0 ? `${copied} past watches copied from Plex and Jellyfin.` : 'Marquee copies each server’s own history every 15 minutes. Press Update now on the Activity page to do it at once.',
    action: { label: 'Open Activity', to: '/activity' },
  });

  const recorded = db.select({ n: sql<number>`count(*)` }).from(streams).where(isNotNull(streams.endedAt)).get()?.n ?? 0;
  steps.push({
    key: 'recorded',
    title: 'Marquee has watched a stream from start to finish',
    state: recorded > 0 ? 'done' : 'todo',
    detail: recorded > 0 ? `${recorded} streams recorded, with how long each was really watched.` : 'Play something on Plex or Jellyfin, then stop it. It should appear on the Activity page.',
    action: { label: 'Open Activity', to: '/activity' },
  });

  const channels = db.select().from(notificationChannels).where(eq(notificationChannels.enabled, true)).all();
  const wantsStreams = channels.some((c) => (JSON.parse(c.events) as string[]).some((e) => e.startsWith('stream_')));
  steps.push({
    key: 'notify',
    title: 'Playback messages go to your phone',
    state: wantsStreams ? 'done' : 'todo',
    detail: wantsStreams ? 'A channel is set to tell you when someone starts or stops watching.' : 'In Settings → Notifications, switch on “Someone started watching” (and the others you used in Tautulli) for a Pushover or ntfy channel. They start switched off.',
    action: { label: 'Settings → Notifications', to: '/settings/notifications' },
  });

  steps.push({
    key: 'old_data',
    title: 'You’re fine without Tautulli’s old numbers',
    state: 'unknown',
    detail: 'Tautulli’s own history isn’t copied: Marquee reads what Plex and Jellyfin remember (watch dates, not how long or on which device) and records everything fully from now on. Keep Tautulli’s data folder for a while if you want to look back.',
    action: null,
  });
  steps.push({
    key: 'watchstate',
    title: 'If you use WatchState, keep it for now',
    state: 'unknown',
    detail: 'Marquee shows watching but does not yet keep “watched” ticks in step between Plex and Jellyfin. If WatchState does that for you, leave it running.',
    action: null,
  });
  steps.push({
    key: 'turn_off',
    title: 'Turn Tautulli off',
    state: 'unknown',
    detail: 'When the steps above are done, stop the Tautulli container. Marquee only reads from Plex and Jellyfin, so nothing here changes them.',
    action: null,
  });

  return { steps, ready: steps.filter((s) => s.state !== 'unknown').every((s) => s.state === 'done') };
}
