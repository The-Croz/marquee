import { and, eq, isNotNull, ne, sql } from 'drizzle-orm';
import type { RetireView, RetireStep } from '@marquee/shared';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { notificationChannels, requests, users } from '../db/schema.js';
import { readServices } from '../library/services.js';

/**
 * The "retire Seerr" checklist. Marquee checks what it can see for itself
 * (Discover works, the family has accounts and has signed in, a push channel
 * works, a request made it into the library). The last two steps are things
 * only you can do, so they say "can't check". There is no import from Seerr:
 * anything still waiting there is asked for again in Marquee.
 */
export function retireSeerrChecklist({ db, config }: { db: Db; config: Config }): RetireView {
  const steps: RetireStep[] = [];

  const tmdb = Boolean(readServices(db, config).tmdbApiKey);
  steps.push({
    key: 'discover',
    title: 'Discover works',
    state: tmdb ? 'done' : 'todo',
    detail: tmdb ? 'Marquee can look up movies and shows, so people can browse and ask for things.' : 'Add your TMDB key so Discover has something to show.',
    action: tmdb ? null : { label: 'Settings → Services', to: '/settings/services' },
  });

  const others = db.select({ n: sql<number>`count(*)` }).from(users).where(ne(users.role, 'admin')).get()?.n ?? 0;
  steps.push({
    key: 'people',
    title: 'Your family has accounts',
    state: others > 0 ? 'done' : 'todo',
    detail:
      others > 0
        ? `${others} ${others === 1 ? 'person besides the admins has' : 'people besides the admins have'} an account.`
        : 'Add people from Plex or Jellyfin (or by hand). Give kids the Kid role so they only see kids’ titles and an admin approves what they ask for.',
    action: { label: 'Settings → Users', to: '/settings/users' },
  });

  const signedIn = db.select({ n: sql<number>`count(*)` }).from(users).where(and(ne(users.role, 'admin'), isNotNull(users.lastLoginAt))).get()?.n ?? 0;
  steps.push({
    key: 'signed_in',
    title: 'Someone besides you has signed in',
    state: signedIn > 0 ? 'done' : 'todo',
    detail: signedIn > 0 ? `${signedIn} ${signedIn === 1 ? 'person has' : 'people have'} signed in, so the address and sign-in work for them.` : 'Ask one person to open Marquee and sign in, from their phone if that is how they will use it. This proves the address works outside your own computer.',
    action: null,
  });

  const channels = db.select().from(notificationChannels).where(eq(notificationChannels.enabled, true)).all();
  const worked = channels.some((c) => c.lastOkAt !== null);
  steps.push({
    key: 'notify',
    title: 'Marquee can reach your phone',
    state: worked ? 'done' : channels.length ? 'warn' : 'todo',
    detail: worked
      ? 'A Pushover or ntfy channel has delivered a message. You will hear about new requests there.'
      : channels.length
        ? 'A channel is set up but nothing has gone through yet. Press Send a test on it.'
        : 'Set up Pushover or ntfy so you hear about new requests. People always get the bell inside Marquee.',
    action: { label: 'Settings → Notifications', to: '/settings/notifications' },
  });

  const asked = db.select({ n: sql<number>`count(*)` }).from(requests).get()?.n ?? 0;
  const ready = db.select({ n: sql<number>`count(*)` }).from(requests).where(isNotNull(requests.readyAt)).get()?.n ?? 0;
  steps.push({
    key: 'request',
    title: 'A request went all the way through',
    state: ready > 0 ? 'done' : asked > 0 ? 'warn' : 'todo',
    detail:
      ready > 0
        ? `${ready} ${ready === 1 ? 'request has' : 'requests have'} been asked for, approved, downloaded and put in your library.`
        : asked > 0
          ? 'A request has been made, but none has reached your library yet. Check the Requests and Downloads pages to see where it stopped.'
          : 'Ask for something on Discover as a member, approve it as an admin, and wait for it to say “In your library”.',
    action: { label: 'Open Requests', to: '/requests' },
  });

  steps.push({
    key: 'family',
    title: 'Tell the family where to ask now',
    state: 'unknown',
    detail: 'Send everyone Marquee’s address. Anything still waiting in Seerr is not copied over: ask for it again in Marquee, or approve it in Seerr one last time and let it finish.',
    action: null,
  });
  steps.push({
    key: 'turn_off',
    title: 'Turn Seerr off',
    state: 'unknown',
    detail: 'When nobody is using it, stop the Seerr container. Keep its data folder for a few weeks in case you want to look something up, then remove it. Marquee only reads from Seerr, so nothing here changes it.',
    action: null,
  });

  return { steps, ready: steps.filter((s) => s.state !== 'unknown').every((s) => s.state === 'done') };
}
