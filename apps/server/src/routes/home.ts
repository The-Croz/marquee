import fs from 'node:fs/promises';
import { Hono } from 'hono';
import { count, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { HomeAttention, HomeData, HomeHero, HomeTitle, NowPlayingView } from '@marquee/shared';
import type { Db } from '../db/index.js';
import { mediaFiles, movies, scanItems, series, type User } from '../db/schema.js';
import { comingUp } from '../library/airing.js';
import { readServices } from '../library/services.js';
import { sharedMonitor } from '../downloads/monitor.js';
import { lastWantedRuns, lookingForWanted } from '../downloads/wanted.js';
import { lastWantedTvRuns } from '../downloads/wantedTv.js';
import { listRequests } from '../requests/service.js';
import { KID_MOVIE_RATINGS, KID_TV_RATINGS, qualityLabel } from './library.js';
import { requireUser, type Ctx, type Env } from '../http.js';

/**
 * Home: what's happening, what needs you, what's new and what's next.
 * Admins get the household's view (Needs you, Watching now, On its way);
 * members and kids get their own requests. Everything here is real data.
 */
export const homeRoutes = new Hono<Env>();

const DAY = 24 * 60 * 60 * 1000;
/** Sources in these states are fine, or turned off on purpose. */
const SOURCE_OK = new Set(['working', 'paused', 'unchecked']);

homeRoutes.get('/', async (c) => {
  const user = requireUser(c);
  const { db, now } = c.get('deps');
  const isAdmin = user.role === 'admin';
  const isKid = user.role === 'kid';

  const data: HomeData = {
    needsYou: [],
    watching: [],
    onItsWay: [],
    myRequests: [],
    recent: recentTitles(db, isKid),
    upcoming: db.select({ id: series.id }).from(series).limit(1).get() ? comingUp(db, now(), isKid ? KID_TV_RATINGS : undefined) : [],
    stats: libraryStats(db, isKid),
    hero: null,
  };

  if (isAdmin) {
    await household(c, user, data);
  } else {
    data.myRequests = listRequests(db, user, 'mine', now())
      .filter((r) => r.state !== 'ready' || now() - (r.decidedAt ?? r.createdAt) < 3 * DAY)
      .slice(0, 6);
  }
  data.hero = pickHero(db, data, now());
  return c.json(data);
});

const RES: Record<string, string> = { '4k': '4K', '1080': '1080p', '720': '720p', '480': 'SD', sd: 'SD' };

/** Something playing beats something ready for you, which beats something new in the last three days. */
function pickHero(db: Db, data: HomeData, now: number): HomeHero | null {
  const playing = data.watching.find((w) => w.state === 'playing') ?? data.watching[0];
  if (playing) return watchingHero(db, playing, data.watching.length);
  const ready = data.myRequests.find((r) => r.state === 'ready' && r.href);
  if (ready) {
    const art = artFor(db, ready.href);
    return { kind: 'ready', eyebrow: 'Ready to watch · you asked for it', title: ready.title, chips: ready.year ? [String(ready.year)] : [], href: ready.href, backdropPath: art.backdrop, posterPath: art.poster ?? ready.posterPath, progress: null, note: null };
  }
  const fresh = data.recent[0];
  if (fresh && now - fresh.addedAt < 3 * DAY) {
    const art = artFor(db, fresh.href);
    return { kind: 'arrived', eyebrow: `Just arrived · ${ago(now - fresh.addedAt)}`, title: fresh.title, chips: [fresh.sub], href: fresh.href, backdropPath: art.backdrop, posterPath: art.poster ?? fresh.posterPath, progress: null, note: null };
  }
  return null;
}

function watchingHero(db: Db, w: NowPlayingView, total: number): HomeHero {
  const art = artFor(db, w.href);
  const chips = [w.resolution ? RES[w.resolution] ?? w.resolution : null, w.transcoding ? 'Converting' : 'Direct play', `${w.user} · ${w.server === 'plex' ? 'Plex' : 'Jellyfin'}`].filter((x): x is string => !!x);
  return {
    kind: 'watching',
    eyebrow: `${w.state === 'paused' ? 'Paused' : 'Now showing'} · ${w.device}${total > 1 ? ` · 1 of ${total} playing` : ''}`,
    title: w.title,
    chips,
    href: w.href,
    backdropPath: art.backdrop,
    posterPath: art.poster,
    progress: Math.round(w.progress * 100),
    note: w.subtitle,
  };
}

/** Poster and backdrop for a /movies/:id or /shows/:id page. */
function artFor(db: Db, href: string | null): { poster: string | null; backdrop: string | null } {
  const m = href?.match(/^\/(movies|shows)\/(\d+)$/);
  if (!m) return { poster: null, backdrop: null };
  const table = m[1] === 'movies' ? movies : series;
  const row = db.select({ poster: table.posterPath, backdrop: table.backdropPath }).from(table).where(eq(table.id, Number(m[2]))).get();
  return row ?? { poster: null, backdrop: null };
}

/** The admin's part: Needs you, Watching now, On its way, and the footer numbers only they see. */
async function household(c: Ctx, user: User, data: HomeData): Promise<void> {
  const { db, config, clients, sources, activity, now } = c.get('deps');
  const needs: HomeAttention[] = [];

  // Requests waiting for an OK.
  for (const r of listRequests(db, user, 'all', now()).filter((r) => r.state === 'pending')) {
    const plan = r.seasons ? (r.seasons.length === 1 ? `Season ${r.seasons[0]}` : `Seasons ${r.seasons.join(', ')}`) : r.kind === 'movie' ? 'Movie' : 'Whole show';
    needs.push({
      key: `request-${r.id}`,
      tone: 'attention',
      title: `${r.requestedBy?.name ?? 'Someone'} asked for ${r.title}`,
      detail: `${plan} · ${ago(now() - r.createdAt)}`,
      posterPath: r.posterPath,
      to: '/requests',
      action: 'Look closer',
      approveId: r.id,
    });
  }

  // Downloads: what's on its way, and what's stuck or failed.
  const downloads = await sharedMonitor({ db, clients, sources, now }).view(60_000);
  if (downloads.problem) {
    needs.push({ key: 'downloader', tone: 'problem', title: `qBittorrent: ${downloads.problem.label}`, detail: downloads.problem.fix, to: '/settings/downloader', action: 'Fix' });
  }
  const posters = posterLookup(db, downloads.items);
  for (const d of downloads.items) {
    if (d.state === 'removed') continue;
    const poster = posters(d);
    const broken = d.status.tone === 'bad' || (d.status.tone === 'warn' && (d.state === 'sent' || d.state === 'downloading'));
    if (broken) {
      needs.push({
        key: `download-${d.id}`,
        tone: 'problem',
        title: `${d.titleName} · ${d.status.label}`,
        detail: d.status.nextTryAt ? `Tries another copy by itself at ${clock(d.status.nextTryAt)}` : d.status.detail,
        posterPath: poster,
        to: '/downloads',
        action: 'Open',
      });
    } else if (d.state === 'sent' || d.state === 'downloading') {
      data.onItsWay.push({ id: d.id, title: d.titleName, href: d.titleLink, posterPath: poster, percent: Math.round(d.progress * 100), label: d.status.label });
    }
  }
  data.onItsWay.sort((a, b) => b.percent - a.percent);

  // Sources that aren't working.
  const failing = sources.view().sources.filter((s) => s.enabled && !SOURCE_OK.has(s.state));
  if (failing.length === 1) {
    const s = failing[0]!;
    needs.push({ key: `source-${s.id}`, tone: 'problem', title: `${s.name}: ${s.stateLabel}`, detail: s.retryAt ? `Tries again by itself at ${clock(s.retryAt)}` : s.fix, to: '/settings/sources', action: 'Fix' });
  } else if (failing.length > 1) {
    needs.push({ key: 'sources', tone: 'problem', title: `${failing.length} Sources aren’t working`, detail: failing.map((s) => `${s.name}: ${s.stateLabel}`).join(' · '), to: '/settings/sources', action: 'Fix' });
  }

  // Plex and Jellyfin, from the live line.
  const live = activity.view();
  for (const [i, p] of live.problems.entries()) needs.push({ key: `media-${i}`, tone: 'problem', title: p, detail: null, to: '/settings/services', action: 'Fix' });
  data.watching = live.sessions;

  // Folders the scanner couldn't match.
  const unmatched = db.select({ n: count() }).from(scanItems).where(eq(scanItems.status, 'unmatched')).get()?.n ?? 0;
  if (unmatched) {
    needs.push({ key: 'unmatched', tone: 'attention', title: `${unmatched} ${unmatched === 1 ? 'folder needs' : 'folders need'} a match`, detail: null, to: '/library/unmatched', action: 'Match' });
  }

  // Problems first, then people waiting.
  data.needsYou = [...needs.filter((n) => n.tone === 'problem'), ...needs.filter((n) => n.tone === 'attention')];

  // Footer: free space and when Marquee last looked by itself.
  try {
    const st = await fs.statfs(readServices(db, config).moviesRoot);
    data.stats.push({ label: 'free', value: bytes(st.bavail * st.bsize), to: '/settings/services' });
  } catch {
    /* folder not mounted: leave it out */
  }
  const lastRun = Math.max(0, ...lastWantedRuns(db).map((r) => r.at), ...lastWantedTvRuns(db).map((r) => r.at));
  if (lastRun) data.stats.push({ label: 'last automatic search', value: ago(now() - lastRun), to: '/settings/automation' });
  else if (!lookingForWanted(db)) data.stats.push({ label: 'Automatic searching', value: 'off', to: '/settings/automation' });
}

/** The newest titles in the library, one card per title. */
function recentTitles(db: Db, kid: boolean): HomeTitle[] {
  const latest = db
    .select({ movieId: mediaFiles.movieId, seriesId: mediaFiles.seriesId, addedAt: sql<number>`max(${mediaFiles.addedAt})`, resolution: mediaFiles.resolution, hdr: mediaFiles.hdr, season: mediaFiles.season, episodes: mediaFiles.episodes })
    .from(mediaFiles)
    .groupBy(sql`coalesce(${mediaFiles.movieId}, -${mediaFiles.seriesId})`)
    .orderBy(desc(sql`max(${mediaFiles.addedAt})`))
    .limit(40)
    .all();
  if (!latest.length) return [];
  const movieRows = new Map(db.select().from(movies).where(inArray(movies.id, latest.filter((l) => l.movieId).map((l) => l.movieId!))).all().map((m) => [m.id, m]));
  const showRows = new Map(db.select().from(series).where(inArray(series.id, latest.filter((l) => l.seriesId).map((l) => l.seriesId!))).all().map((s) => [s.id, s]));

  const out: HomeTitle[] = [];
  for (const l of latest) {
    if (out.length >= 12) break;
    if (l.movieId) {
      const m = movieRows.get(l.movieId);
      if (!m || (kid && !KID_MOVIE_RATINGS.includes(m.certification ?? ''))) continue;
      out.push({ title: m.title, sub: `Movie · ${qualityLabel(l)}`, posterPath: m.posterPath, href: `/movies/${m.id}`, addedAt: l.addedAt });
    } else if (l.seriesId) {
      const s = showRows.get(l.seriesId);
      if (!s || (kid && !KID_TV_RATINGS.includes(s.certification ?? ''))) continue;
      const ep = (JSON.parse(l.episodes ?? '[]') as number[])[0];
      out.push({ title: s.title, sub: `S${l.season} E${ep ?? '?'} · ${qualityLabel(l)}`, posterPath: s.posterPath, href: `/shows/${s.id}`, addedAt: l.addedAt });
    }
  }
  return out;
}

function libraryStats(db: Db, kid: boolean): HomeData['stats'] {
  if (kid) return [];
  const movieCount = db.select({ n: sql<number>`count(distinct ${mediaFiles.movieId})` }).from(mediaFiles).where(isNotNull(mediaFiles.movieId)).get()?.n ?? 0;
  const showCount = db.select({ n: sql<number>`count(distinct ${mediaFiles.seriesId})` }).from(mediaFiles).where(isNotNull(mediaFiles.seriesId)).get()?.n ?? 0;
  return [
    { label: movieCount === 1 ? 'movie' : 'movies', value: String(movieCount), to: '/movies' },
    { label: showCount === 1 ? 'show' : 'shows', value: String(showCount), to: '/shows' },
  ];
}

/** Poster for a download's movie or show. */
function posterLookup(db: Db, items: { movieId: number | null; seriesId: number | null }[]) {
  const movieIds = [...new Set(items.map((d) => d.movieId).filter((x): x is number => x !== null))];
  const showIds = [...new Set(items.map((d) => d.seriesId).filter((x): x is number => x !== null))];
  const m = new Map(movieIds.length ? db.select({ id: movies.id, p: movies.posterPath }).from(movies).where(inArray(movies.id, movieIds)).all().map((r) => [r.id, r.p]) : []);
  const s = new Map(showIds.length ? db.select({ id: series.id, p: series.posterPath }).from(series).where(inArray(series.id, showIds)).all().map((r) => [r.id, r.p]) : []);
  return (d: { movieId: number | null; seriesId: number | null }) => (d.movieId ? (m.get(d.movieId) ?? null) : d.seriesId ? (s.get(d.seriesId) ?? null) : null);
}

function bytes(n: number): string {
  const tb = n / 1e12;
  return tb >= 1 ? `${tb.toFixed(1)} TB` : `${Math.round(n / 1e9)} GB`;
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** "2 hours ago", "yesterday". */
function ago(ms: number): string {
  const m = Math.round(ms / 60000);
  if (m < 2) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} ${h === 1 ? 'hour' : 'hours'} ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}
