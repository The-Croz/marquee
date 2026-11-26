import { and, eq, gte, isNotNull } from 'drizzle-orm';
import type { NowPlayingView } from '@marquee/shared';
import type { Db } from '../db/index.js';
import { devices, downloads, liveActivities, liveStarts, liveStartTokens, liveStreams, users } from '../db/schema.js';
import type { ApnsClient } from '../notify/apns.js';
import { isGone } from '../notify/apns.js';
import { describeDownload } from './view.js';

/**
 * Lock Screen cards (Live Activities). A card is started on a phone two ways:
 * the person presses Follow in the app, or Marquee starts it by itself (a
 * download beginning, someone starting to watch) on phones that switched that
 * on. Either way the phone then gives Marquee the card's own push address,
 * which keeps it up to date until it ends.
 */

/** A Live Activity ends after this long, whatever happens. */
export const LIVE_ACTIVITY_MAX = 8 * 60 * 60 * 1000;
/** It is updated when the percent moves by this much, or the state changes. */
export const LIVE_STEP = 5;
/** The most cards of one kind Marquee starts on a phone: iPhones only show a few. */
export const MOST_CARDS = 3;
/** A download older than this doesn't start a card any more: it's old news. */
const NEWS = 24 * 60 * 60 * 1000;

interface Deps {
  db: Db;
  apns: ApnsClient | null;
  now: () => number;
}

type Kind = 'download' | 'watching';

/** What a download's card shows. Plain words, from the same place the Downloads page gets them. */
function contentState(db: Db, row: typeof downloads.$inferSelect, now: number) {
  const d = describeDownload(db, row, now);
  return { progress: Math.max(0, Math.min(1, row.progress)), status: d.status.label, eta: row.eta ?? null, done: Boolean(row.importedAt) };
}

interface Push {
  token: string;
  environment: 'production' | 'sandbox';
}

/** Sends one Live Activity push. `gone` means Apple says that address no longer exists. */
async function push({ apns, now }: Deps, to: Push, aps: Record<string, unknown>, urgent: boolean): Promise<'sent' | 'gone' | 'failed'> {
  try {
    const answer = await apns!.send({
      token: to.token,
      environment: to.environment,
      pushType: 'liveactivity',
      topicSuffix: '.push-type.liveactivity',
      priority: urgent ? 10 : 5,
      payload: { aps: { timestamp: Math.floor(now() / 1000), ...aps } },
    });
    return isGone(answer) ? 'gone' : answer.status === 200 ? 'sent' : 'failed';
  } catch (err) {
    console.warn(`[live activity] couldn't send: ${(err as Error).message}`);
    return 'failed';
  }
}

/** Admins' phones that switched this kind on and told Marquee where to start cards. */
function startable(db: Db, kind: Kind) {
  return db
    .select({ deviceId: devices.id, token: liveStartTokens.token, environment: liveStartTokens.environment })
    .from(liveStartTokens)
    .innerJoin(devices, eq(devices.id, liveStartTokens.deviceId))
    .innerJoin(users, eq(users.id, devices.userId))
    .where(and(eq(liveStartTokens.kind, kind), eq(users.role, 'admin'), isNotNull(devices.sessionId), eq(kind === 'download' ? devices.liveDownloads : devices.liveWatching, true)))
    .all();
}

/**
 * Starts a card on each of these phones for each thing it hasn't had one for,
 * up to MOST_CARDS at a time. It's written down before sending, so two looks at
 * once never start two, and a card swiped away stays away.
 */
async function startCards(deps: Deps, kind: Kind, wanted: { ref: string; aps: () => Record<string, unknown> }[], live: Set<string>, taken: Set<string> = new Set()): Promise<void> {
  const { db, now } = deps;
  for (const phone of startable(db, kind)) {
    const had = new Set(db.select({ ref: liveStarts.ref }).from(liveStarts).where(and(eq(liveStarts.deviceId, phone.deviceId), eq(liveStarts.kind, kind), gte(liveStarts.at, now() - NEWS))).all().map((r) => r.ref));
    let showing = [...had].filter((ref) => live.has(ref)).length;
    for (const item of wanted) {
      if (showing >= MOST_CARDS) break;
      if (had.has(item.ref) || taken.has(`${phone.deviceId}:${item.ref}`)) continue;
      const claimed = db.insert(liveStarts).values({ deviceId: phone.deviceId, kind, ref: item.ref, at: now() }).onConflictDoUpdate({ target: [liveStarts.deviceId, liveStarts.kind, liveStarts.ref], set: { at: now() } }).run();
      if (!claimed.changes) continue;
      const answer = await push(deps, phone, { event: 'start', ...item.aps() }, true);
      if (answer === 'sent') showing++;
      else db.delete(liveStarts).where(and(eq(liveStarts.deviceId, phone.deviceId), eq(liveStarts.kind, kind), eq(liveStarts.ref, item.ref))).run();
      if (answer === 'gone') {
        db.delete(liveStartTokens).where(and(eq(liveStartTokens.deviceId, phone.deviceId), eq(liveStartTokens.kind, kind))).run();
        break;
      }
    }
  }
}

async function startDownloads(deps: Deps): Promise<void> {
  const { db, now } = deps;
  const active = db.select().from(downloads).where(eq(downloads.state, 'downloading')).all().filter((d) => !d.importedAt && d.progress < 1);
  const followed = new Set(db.select().from(liveActivities).all().map((a) => `${a.deviceId}:${a.downloadId}`));
  const wanted = active
    .filter((d) => now() - d.addedAt < NEWS)
    .sort((a, b) => b.addedAt - a.addedAt)
    .map((d) => ({
      ref: String(d.id),
      aps: () => {
        const name = describeDownload(db, d, now()).titleName;
        return { 'attributes-type': 'DownloadActivityAttributes', attributes: { title: name, downloadId: d.id }, 'content-state': contentState(db, d, now()), alert: { title: 'Downloading', body: name } };
      },
    }));
  // A download a phone is already following doesn't get a second card there.
  await startCards(deps, 'download', wanted, new Set(active.map((d) => String(d.id))), followed);
}

/**
 * Keeps download cards up to date, and starts new ones. Called after each look
 * at qBittorrent: pushes an update when the percent moved by 5 (or the state
 * changed) and ends the card when the download is in the library, failed,
 * removed, or 8 hours old. Phones Apple says are gone are forgotten.
 */
export async function updateLiveActivities(deps: Deps): Promise<void> {
  const { db, apns, now } = deps;
  if (!apns?.ready) return;
  for (const live of db.select().from(liveActivities).all()) {
    const row = db.select().from(downloads).where(eq(downloads.id, live.downloadId)).get();
    const t = now();
    const finished = !row || row.state === 'removed' || row.state === 'failed' || Boolean(row.importedAt);
    const old = t - live.startedAt > LIVE_ACTIVITY_MAX;
    const percent = row ? Math.floor(row.progress * 100) : live.lastPercent;
    const state = row ? `${row.state}|${row.importedAt ? 'in' : ''}` : 'gone';
    if (!finished && !old && Math.abs(percent - live.lastPercent) < LIVE_STEP && state === live.lastState) continue;
    const end = finished || old;
    const answer = await push(
      deps,
      live,
      {
        event: end ? 'end' : 'update',
        'content-state': row ? contentState(db, row, t) : { progress: live.lastPercent / 100, status: 'Removed', eta: null, done: false },
        ...(end ? { 'dismissal-date': Math.floor(t / 1000) + 5 * 60 } : {}),
      },
      end,
    );
    if (answer === 'gone' || (end && answer !== 'failed')) db.delete(liveActivities).where(eq(liveActivities.id, live.id)).run();
    else if (answer === 'sent') db.update(liveActivities).set({ lastPercent: percent, lastState: state }).where(eq(liveActivities.id, live.id)).run();
  }
  await startDownloads(deps);
}

/** One stream's name for its card. The start time keeps the next episode (same session) separate. */
export const streamRef = (s: Pick<NowPlayingView, 'server' | 'sessionId' | 'startedAt'>) => `${s.server}:${s.sessionId}:${s.startedAt}`;

const watchState = (s: NowPlayingView) => ({
  progress: Math.max(0, Math.min(1, s.progress)),
  status: [s.state === 'paused' ? 'Paused' : s.state === 'buffering' ? 'Buffering' : 'Playing', s.transcoding ? 'converting' : null].filter(Boolean).join(' · '),
  done: false,
});

/** Keeps "who's watching" cards in step with what's playing, and starts new ones. Called after each look at Plex and Jellyfin. */
export async function updateWatchingCards(deps: Deps, sessions: NowPlayingView[]): Promise<void> {
  const { db, apns, now } = deps;
  if (!apns?.ready) return;
  const playing = new Map(sessions.map((s) => [streamRef(s), s]));
  for (const live of db.select().from(liveStreams).all()) {
    const s = playing.get(live.streamRef);
    const t = now();
    const end = !s || t - live.startedAt > LIVE_ACTIVITY_MAX;
    const percent = s ? Math.floor(s.progress * 100) : live.lastPercent;
    const state = s ? watchState(s).status : 'Finished';
    if (!end && Math.abs(percent - live.lastPercent) < LIVE_STEP && state === live.lastState) continue;
    const answer = await push(
      deps,
      live,
      {
        event: end ? 'end' : 'update',
        'content-state': s && !end ? watchState(s) : { progress: percent / 100, status: 'Finished', done: true },
        ...(end ? { 'dismissal-date': Math.floor(t / 1000) + 60 } : {}),
      },
      end || state !== live.lastState,
    );
    if (answer === 'gone' || (end && answer !== 'failed')) db.delete(liveStreams).where(eq(liveStreams.id, live.id)).run();
    else if (answer === 'sent') db.update(liveStreams).set({ lastPercent: percent, lastState: state }).where(eq(liveStreams.id, live.id)).run();
  }
  await startCards(
    deps,
    'watching',
    sessions.map((s) => ({
      ref: streamRef(s),
      aps: () => {
        const detail = `${s.user} · ${s.device}`;
        return { 'attributes-type': 'WatchingActivityAttributes', attributes: { title: s.title, subtitle: s.subtitle, detail, ref: streamRef(s) }, 'content-state': watchState(s), alert: { title: `${s.user} is watching`, body: s.title } };
      },
    })),
    new Set(playing.keys()),
  );
}
