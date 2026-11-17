import { and, eq, gte, isNotNull, lt, sql } from 'drizzle-orm';
import type { ProwlarrSyncResult, SourceCheckResult, SourceState, SourceView, SourcesView } from '@marquee/shared';
import { getSetting, schema, setSetting, type Db } from '../db/index.js';
import type { Source } from '../db/schema.js';
import { MOVIE_CATEGORY, TV_CATEGORY, TorznabError, redactUrl, type Release, type SearchQuery, type TorznabApi, type TorznabCaps } from './torznab.js';
import { prowlarrFeedUrl, type ProwlarrApi } from './prowlarr.js';

/**
 * Sources are the places Marquee searches for copies. This module keeps their
 * health, spaces out and limits calls so sites aren't hammered, and searches
 * all of them at once so one slow or broken site never holds up the rest.
 */

export interface SourceClients {
  torznab(url: string, apiKey: string, timeoutMs: number): TorznabApi;
  prowlarr(url: string, apiKey: string): ProwlarrApi;
}

/** A search result plus where it came from. */
export interface FoundRelease extends Release {
  sourceId: number;
  sourceName: string;
  sourcePriority: number;
}

export interface SourceOutcome {
  sourceId: number;
  name: string;
  /** "searched", or why it wasn't asked. */
  status: 'searched' | 'failed' | 'skipped';
  results: number;
  ms: number;
  message: string | null;
}

export interface SearchOutcome {
  releases: FoundRelease[];
  sources: SourceOutcome[];
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MAX_BACKOFF = 6 * HOUR;
const KEEP_CALLS = 90 * DAY;

type FailState = Exclude<SourceState, 'unchecked' | 'working' | 'paused'>;

/** Plain-English name for each state, and what to do about it. */
export const STATE_TEXT: Record<SourceState, { label: string; fix: string | null }> = {
  unchecked: { label: 'Not checked yet', fix: null },
  working: { label: 'Working', fix: null },
  paused: { label: 'Paused', fix: 'Press Resume to search it again.' },
  unreachable: { label: "Can't reach it", fix: 'Check that Prowlarr (or the site) is running and that the address and port are right.' },
  key_refused: { label: 'Key turned down', fix: 'Copy the API key again from Prowlarr → Settings → General and save it.' },
  slowed_down: {
    label: 'Asked us to slow down',
    fix: 'Marquee waits and tries again by itself. If it keeps happening, lower the daily limit or raise the gap between searches.',
  },
  blocked: { label: 'Blocked by a bot check', fix: 'Set up FlareSolverr for this site in Prowlarr, then press Try now.' },
  not_a_feed: { label: 'Not a Torznab feed', fix: 'That address isn’t a Torznab feed. Copy it again from Prowlarr or Jackett.' },
  error: { label: 'Something went wrong', fix: 'Press Try now. If it keeps failing, test the site in Prowlarr.' },
};

/** 1 minute after the first failure, doubling each time, at most 6 hours. */
export function backoff(failures: number): number {
  return Math.min(MINUTE * 2 ** Math.max(0, failures - 1), MAX_BACKOFF);
}

const PROWLARR_URL = 'prowlarr.url';
const PROWLARR_KEY = 'prowlarr.api_key';
const PROWLARR_SYNCED_AT = 'prowlarr.synced_at';
const PROWLARR_MESSAGE = 'prowlarr.sync_message';

/** Defaults for sites added from Prowlarr. Private sites often cap API calls, so they get a gentle limit. */
export const PRIVATE_DEFAULTS = { dailyLimit: 100, minGapMs: 5000 };
export const PUBLIC_DEFAULTS = { dailyLimit: 0, minGapMs: 2000 };

export class SourceService {
  /** When each source was last called, for spacing calls out. In memory: a restart just forgets the gap. */
  private readonly lastCall = new Map<number, number>();

  constructor(
    private readonly db: Db,
    private readonly clients: SourceClients,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  // ---------------- reading ----------------

  get(id: number): Source | undefined {
    return this.db.select().from(schema.sources).where(eq(schema.sources.id, id)).get();
  }

  view(): SourcesView {
    const now = this.now();
    const weekAgo = now - 7 * DAY;
    const stats = new Map(
      this.db
        .select({
          sourceId: schema.sourceCalls.sourceId,
          calls: sql<number>`count(*)`,
          failures: sql<number>`sum(case when ${schema.sourceCalls.ok} then 0 else 1 end)`,
          avgMs: sql<number | null>`avg(case when ${schema.sourceCalls.ok} then ${schema.sourceCalls.ms} end)`,
          today: sql<number>`sum(case when ${schema.sourceCalls.kind} = 'search' and ${schema.sourceCalls.at} >= ${now - DAY} then 1 else 0 end)`,
        })
        .from(schema.sourceCalls)
        .where(gte(schema.sourceCalls.at, weekAgo))
        .groupBy(schema.sourceCalls.sourceId)
        .all()
        .map((r) => [r.sourceId, r]),
    );
    const rows = this.db.select().from(schema.sources).orderBy(schema.sources.priority, schema.sources.name).all();
    const url = getSetting(this.db, PROWLARR_URL) || null;
    return {
      sources: rows.map((s) => toView(s, now, stats.get(s.id))),
      prowlarr: {
        url,
        linked: !!(url && getSetting(this.db, PROWLARR_KEY)),
        syncedAt: Number(getSetting(this.db, PROWLARR_SYNCED_AT)) || null,
        syncMessage: getSetting(this.db, PROWLARR_MESSAGE) || null,
      },
    };
  }

  // ---------------- managing ----------------

  add(input: { name: string; url: string; apiKey: string }): Source {
    return this.db
      .insert(schema.sources)
      .values({ name: input.name, url: input.url, apiKey: input.apiKey, createdAt: this.now() })
      .returning()
      .get();
  }

  update(id: number, patch: Partial<Pick<Source, 'name' | 'url' | 'apiKey' | 'enabled' | 'priority' | 'forMovies' | 'forTv' | 'minSeeders' | 'dailyLimit' | 'minGapMs' | 'timeoutSeconds'>>): void {
    const changes: Partial<Source> = { ...patch };
    // A new address or key deserves a fresh start rather than waiting out an old failure.
    if (patch.url !== undefined || patch.apiKey !== undefined || patch.enabled === true) Object.assign(changes, { failures: 0, retryAt: null });
    this.db.update(schema.sources).set(changes).where(eq(schema.sources.id, id)).run();
  }

  remove(id: number): void {
    this.db.delete(schema.sources).where(eq(schema.sources.id, id)).run();
  }

  /** Forgets calls older than 90 days. */
  prune(): void {
    this.db.delete(schema.sourceCalls).where(lt(schema.sourceCalls.at, this.now() - KEEP_CALLS)).run();
  }

  // ---------------- calling ----------------

  private client(s: Source): TorznabApi {
    return this.clients.torznab(s.url, s.apiKey, s.timeoutSeconds * 1000);
  }

  private async waitForGap(s: Source): Promise<void> {
    const last = this.lastCall.get(s.id);
    const wait = last === undefined ? 0 : last + s.minGapMs - this.now();
    if (wait > 0) await this.sleep(wait);
    this.lastCall.set(s.id, this.now());
  }

  private record(s: Source, kind: 'test' | 'search', ok: boolean, ms: number, results: number, message: string | null): void {
    this.db.insert(schema.sourceCalls).values({ sourceId: s.id, at: this.now(), kind, ok, ms, results, message }).run();
  }

  private succeeded(s: Source, caps?: TorznabCaps): void {
    this.db
      .update(schema.sources)
      .set({ state: 'working', stateMessage: null, failures: 0, retryAt: null, checkedAt: this.now(), ...(caps ? { caps: JSON.stringify(caps) } : {}) })
      .where(eq(schema.sources.id, s.id))
      .run();
  }

  private failed(s: Source, err: unknown): { state: FailState; message: string } {
    const e = err instanceof TorznabError ? err : null;
    const state: FailState = e?.problem ?? 'error';
    // Never let a key slip into the database or a log through an error message.
    const message = redactUrl(e?.message ?? (err as Error).message ?? 'Unknown error');
    const failures = s.failures + 1;
    const wait = e?.retryAfter ? e.retryAfter * 1000 : backoff(failures);
    this.db
      .update(schema.sources)
      .set({ state, stateMessage: message, failures, retryAt: this.now() + wait, checkedAt: this.now() })
      .where(eq(schema.sources.id, s.id))
      .run();
    return { state, message };
  }

  /** Reads what the feed supports and asks for its newest copies. Also clears any wait ("Try now"). */
  async check(id: number): Promise<SourceCheckResult> {
    const s = this.get(id);
    if (!s) return { ok: false, state: 'error', message: 'That Source no longer exists.' };
    const started = this.now();
    try {
      await this.waitForGap(s);
      const api = this.client(s);
      const caps = await api.caps();
      const recent = await api.search({ kind: 'recent' }, caps);
      const ms = this.now() - started;
      this.record(s, 'test', true, ms, recent.length, null);
      this.succeeded(s, caps);
      return { ok: true, state: 'working', message: `Working. Answered in ${seconds(ms)} with ${recent.length} recent ${recent.length === 1 ? 'copy' : 'copies'}. ${idSearchSentence(caps)}` };
    } catch (err) {
      const { state, message } = this.failed(s, err);
      this.record(s, 'test', false, this.now() - started, 0, message);
      return { ok: false, state, message: `${STATE_TEXT[state].label}. ${message}` };
    }
  }

  /** Why a source won't be asked right now, or null if it can be. */
  private skipReason(s: Source, kind: 'movie' | 'tv'): string | null {
    if (!s.enabled) return 'Paused.';
    if (kind === 'movie' ? !s.forMovies : !s.forTv) return kind === 'movie' ? 'Not used for movies.' : 'Not used for TV.';
    if (s.retryAt && s.retryAt > this.now()) return `${STATE_TEXT[s.state].label}. Trying again ${relativeTime(s.retryAt - this.now())}.`;
    if (s.dailyLimit > 0) {
      const used =
        this.db
          .select({ n: sql<number>`count(*)` })
          .from(schema.sourceCalls)
          .where(and(eq(schema.sourceCalls.sourceId, s.id), eq(schema.sourceCalls.kind, 'search'), gte(schema.sourceCalls.at, this.now() - DAY)))
          .get()?.n ?? 0;
      if (used >= s.dailyLimit) return `Reached its limit of ${s.dailyLimit} searches a day.`;
    }
    return null;
  }

  /** Searches every usable source at once. Failures are recorded, never thrown. */
  async search(query: Exclude<SearchQuery, { kind: 'recent' }>): Promise<SearchOutcome> {
    const all = this.db.select().from(schema.sources).orderBy(schema.sources.priority, schema.sources.name).all();
    const outcomes = await Promise.all(
      all.map(async (s): Promise<{ outcome: SourceOutcome; releases: FoundRelease[] }> => {
        const skip = this.skipReason(s, query.kind);
        if (skip) return { outcome: { sourceId: s.id, name: s.name, status: 'skipped', results: 0, ms: 0, message: skip }, releases: [] };
        const started = this.now();
        try {
          await this.waitForGap(s);
          const caps = s.caps ? (JSON.parse(s.caps) as TorznabCaps) : null;
          const found = await this.client(s).search(query, caps);
          const ms = this.now() - started;
          // Sources can't see a torrent's health before we ask, so drop the ones too few people share.
          const releases = found.filter((r) => r.seeders === null || r.seeders >= s.minSeeders).map((r) => ({ ...r, sourceId: s.id, sourceName: s.name, sourcePriority: s.priority }));
          this.record(s, 'search', true, ms, found.length, null);
          this.succeeded(s);
          return { outcome: { sourceId: s.id, name: s.name, status: 'searched', results: releases.length, ms, message: null }, releases };
        } catch (err) {
          const ms = this.now() - started;
          const { state, message } = this.failed(s, err);
          this.record(s, 'search', false, ms, 0, message);
          return { outcome: { sourceId: s.id, name: s.name, status: 'failed', results: 0, ms, message: `${STATE_TEXT[state].label}. ${message}` }, releases: [] };
        }
      }),
    );
    return { releases: outcomes.flatMap((o) => o.releases), sources: outcomes.map((o) => o.outcome) };
  }

  // ---------------- Prowlarr ----------------

  prowlarrSettings(): { url: string | null; apiKey: string | null } {
    return { url: getSetting(this.db, PROWLARR_URL) || null, apiKey: getSetting(this.db, PROWLARR_KEY) || null };
  }

  async testProwlarr(url: string, apiKey: string): Promise<{ ok: boolean; message: string }> {
    try {
      const api = this.clients.prowlarr(url, apiKey);
      const { version } = await api.ping();
      const sites = await api.sites();
      const usable = sites.filter((s) => usableReason(s) === null).length;
      return { ok: true, message: `Connected to Prowlarr ${version}. ${sites.length} ${sites.length === 1 ? 'site' : 'sites'}, ${usable} with movies or TV.` };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  link(url: string, apiKey: string): void {
    setSetting(this.db, PROWLARR_URL, url);
    setSetting(this.db, PROWLARR_KEY, apiKey);
  }

  /** Stops syncing. Its Sources are removed, or kept as ordinary Sources you manage. */
  unlink(removeSources: boolean): void {
    if (removeSources) this.db.delete(schema.sources).where(isNotNull(schema.sources.prowlarrId)).run();
    else this.db.update(schema.sources).set({ prowlarrId: null }).where(isNotNull(schema.sources.prowlarrId)).run();
    for (const k of [PROWLARR_URL, PROWLARR_KEY, PROWLARR_SYNCED_AT, PROWLARR_MESSAGE]) setSetting(this.db, k, '');
  }

  /**
   * Brings Prowlarr's sites in as Sources. New sites are added, removed ones go,
   * and the address and key follow Prowlarr. Your name, priority, pause and
   * limits stay as you set them.
   */
  async syncProwlarr(): Promise<ProwlarrSyncResult> {
    const { url, apiKey } = this.prowlarrSettings();
    const empty = { added: [], updated: [], removed: [], skipped: [] };
    if (!url || !apiKey) return { ok: false, message: 'Link Prowlarr first.', ...empty };

    let sites;
    try {
      sites = await this.clients.prowlarr(url, apiKey).sites();
    } catch (err) {
      const message = (err as Error).message;
      setSetting(this.db, PROWLARR_MESSAGE, message);
      return { ok: false, message, ...empty };
    }

    const result: ProwlarrSyncResult = { ok: true, message: '', added: [], updated: [], removed: [], skipped: [] };
    const existing = new Map(
      this.db
        .select()
        .from(schema.sources)
        .where(isNotNull(schema.sources.prowlarrId))
        .all()
        .map((s) => [s.prowlarrId!, s]),
    );
    const keep = new Set<number>();

    this.db.transaction((tx) => {
      for (const site of sites) {
        const reason = usableReason(site);
        if (reason) {
          result.skipped.push({ name: site.name, reason });
          continue;
        }
        keep.add(site.id);
        const feed = {
          url: prowlarrFeedUrl(url, site.id),
          apiKey,
          private: site.privacy !== 'public',
          forMovies: site.categories.some((c) => isIn(c, MOVIE_CATEGORY)),
          forTv: site.categories.some((c) => isIn(c, TV_CATEGORY)),
        };
        const old = existing.get(site.id);
        if (old) {
          // Keep the user's own use choices; only switch a kind off if the site stopped carrying it.
          const changes = { url: feed.url, apiKey: feed.apiKey, private: feed.private, forMovies: old.forMovies && feed.forMovies, forTv: old.forTv && feed.forTv };
          tx.update(schema.sources).set(changes).where(eq(schema.sources.id, old.id)).run();
          result.updated.push(old.name);
        } else {
          const defaults = feed.private ? PRIVATE_DEFAULTS : PUBLIC_DEFAULTS;
          tx.insert(schema.sources)
            .values({ name: site.name, prowlarrId: site.id, priority: clampPriority(site.priority), ...feed, ...defaults, createdAt: this.now() })
            .run();
          result.added.push(site.name);
        }
      }
      for (const [prowlarrId, s] of existing) {
        if (keep.has(prowlarrId)) continue;
        tx.delete(schema.sources).where(eq(schema.sources.id, s.id)).run();
        result.removed.push(s.name);
      }
    });

    const parts = [
      result.added.length && `${result.added.length} added`,
      result.updated.length && `${result.updated.length} up to date`,
      result.removed.length && `${result.removed.length} removed`,
      result.skipped.length && `${result.skipped.length} left out`,
    ].filter(Boolean);
    result.message = parts.length ? `Synced with Prowlarr: ${parts.join(', ')}.` : 'Synced with Prowlarr. It has no sites yet.';
    setSetting(this.db, PROWLARR_SYNCED_AT, String(this.now()));
    setSetting(this.db, PROWLARR_MESSAGE, result.message);
    return result;
  }
}

const isIn = (category: number, base: number) => Math.floor(category / 1000) * 1000 === base;
const clampPriority = (p: number) => Math.min(50, Math.max(1, Math.round(p) || 25));

/** Why a Prowlarr site isn't brought in, or null if it is. */
function usableReason(site: { enabled: boolean; protocol: string; categories: number[] }): string | null {
  if (site.protocol !== 'torrent') return 'Usenet. Marquee only uses torrents.';
  if (!site.enabled) return 'Turned off in Prowlarr.';
  if (!site.categories.some((c) => isIn(c, MOVIE_CATEGORY) || isIn(c, TV_CATEGORY))) return 'Has no movies or TV.';
  return null;
}

function idSearchSentence(caps: TorznabCaps): string {
  const ids = [caps.movieSearch.available && caps.movieSearch.tmdbId && 'TMDB', (caps.movieSearch.imdbId || caps.tvSearch.imdbId) && 'IMDb', caps.tvSearch.tvdbId && 'TVDB'].filter(Boolean);
  const list = ids.length > 1 ? `${ids.slice(0, -1).join(', ')} and ${ids.at(-1)}` : ids[0];
  return ids.length ? `Searches by ${list} ID, so matches are exact.` : 'Searches by name only, so Marquee double-checks every match.';
}

function seconds(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function relativeTime(ms: number): string {
  const min = Math.ceil(ms / MINUTE);
  if (min < 60) return `in ${min} ${min === 1 ? 'minute' : 'minutes'}`;
  const h = Math.round(min / 60);
  return `in ${h} ${h === 1 ? 'hour' : 'hours'}`;
}

function toView(s: Source, now: number, st?: { calls: number; failures: number; avgMs: number | null; today: number }): SourceView {
  const state: SourceState = s.enabled ? s.state : 'paused';
  const caps = s.caps ? (JSON.parse(s.caps) as TorznabCaps) : null;
  return {
    id: s.id,
    name: s.name,
    url: s.url,
    hasKey: !!s.apiKey,
    enabled: s.enabled,
    priority: s.priority,
    private: s.private,
    forMovies: s.forMovies,
    forTv: s.forTv,
    minSeeders: s.minSeeders,
    dailyLimit: s.dailyLimit,
    minGapMs: s.minGapMs,
    timeoutSeconds: s.timeoutSeconds,
    fromProwlarr: s.prowlarrId !== null,
    state,
    stateLabel: STATE_TEXT[state].label,
    stateMessage: s.enabled ? s.stateMessage : null,
    fix: STATE_TEXT[state].fix,
    retryAt: s.enabled && s.retryAt && s.retryAt > now ? s.retryAt : null,
    checkedAt: s.checkedAt,
    searchesById: caps ? idSearchSentence(caps) : null,
    week: { calls: st?.calls ?? 0, failures: st?.failures ?? 0, avgMs: st?.avgMs == null ? null : Math.round(st.avgMs), searchesToday: st?.today ?? 0 },
  };
}
