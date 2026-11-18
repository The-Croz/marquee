import { and, eq, gte, isNotNull, lt, sql } from 'drizzle-orm';
import type { BringOverResult, ProwlarrSyncResult, SiteSettingsView, SourceCheckResult, SourceState, SourceView, SourcesView } from '@marquee/shared';
import { getSetting, schema, setSetting, type Db } from '../db/index.js';
import type { Source } from '../db/schema.js';
import { MOVIE_CATEGORY, TV_CATEGORY, TorznabError, redactUrl, rightKind, type Release, type SearchQuery, type TorznabApi, type TorznabCaps } from './torznab.js';
import { prowlarrFeedUrl, type ProwlarrApi } from './prowlarr.js';
import { CardigannSite, type SiteSettingsValues } from './sites/cardigann.js';
import { BUILTIN, definitionFor, siteForm } from './sites/catalogue.js';
import { unsupportedReason } from './sites/definition.js';
import { SiteHttp, type SiteFetch, type SiteSession, type SolverApi } from './sites/http.js';
import { solverFor, type BundledSolver } from './sites/solver.js';

/**
 * Sources are the places Marquee searches for copies. This module keeps their
 * health, spaces out and limits calls so sites aren't hammered, and searches
 * all of them at once so one slow or broken site never holds up the rest.
 */

export interface SourceClients {
  torznab(url: string, apiKey: string, timeoutMs: number): TorznabApi;
  prowlarr(url: string, apiKey: string): ProwlarrApi;
  /** One request to a site Marquee searches itself. */
  siteFetch: SiteFetch;
  /** A FlareSolverr-compatible bot-check solver at this address. */
  solver(url: string): SolverApi;
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
  sign_in_failed: { label: 'Sign-in turned down', fix: 'Check the site’s settings: username and password, or a fresh cookie (and user agent) from your browser. Then press Try now.' },
  not_supported: { label: 'Not supported yet', fix: 'Marquee can’t run this site yet. Search it through Prowlarr for now, or put a fixed file for it in the sites folder.' },
  slowed_down: {
    label: 'Asked us to slow down',
    fix: 'Marquee waits and tries again by itself. If it keeps happening, lower the daily limit or raise the gap between searches.',
  },
  set_aside: {
    label: 'Set aside by Prowlarr',
    fix: 'Open this site in Prowlarr and press Test to see why it fails there. Sites behind Cloudflare usually need FlareSolverr.',
  },
  blocked: { label: 'Blocked by a bot check', fix: 'Turn on bot-check solving in Settings → Sources, then press Try now. (For a site searched through Prowlarr, set up FlareSolverr there instead.)' },
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

  /** The bot-check solver to use right now, or null when that's off. */
  readonly solver: () => Promise<SolverApi | null>;

  constructor(
    private readonly db: Db,
    private readonly clients: SourceClients,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    readonly bundledSolver: BundledSolver | null = null,
  ) {
    this.solver = solverFor(db, bundledSolver, (url) => clients.solver(url));
  }

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
      sources: rows.map((s) => toView(s, now, stats.get(s.id), s.kind === 'site' ? this.siteInfo(s) : null)),
      prowlarr: {
        url,
        linked: !!(url && getSetting(this.db, PROWLARR_KEY)),
        syncedAt: Number(getSetting(this.db, PROWLARR_SYNCED_AT)) || null,
        syncMessage: getSetting(this.db, PROWLARR_MESSAGE) || null,
      },
    };
  }

  private siteInfo(s: Source): { name: string | null; settings: SiteSettingsView } {
    const form = s.siteId ? siteForm(this.db, s.siteId) : null;
    const values = JSON.parse(s.siteSettings) as SiteSettingsValues;
    const settings: SiteSettingsView = {};
    for (const f of form?.fields ?? []) {
      if (f.type === 'info') continue;
      const v = values[f.name];
      settings[f.name] = f.secret ? { saved: v !== undefined && v !== null && v !== '' } : (v ?? f.default ?? null);
    }
    return { name: form?.name ?? null, settings };
  }

  // ---------------- managing ----------------

  add(input: { name: string; url: string; apiKey: string }): Source {
    return this.db
      .insert(schema.sources)
      .values({ name: input.name, url: input.url, apiKey: input.apiKey, createdAt: this.now() })
      .returning()
      .get();
  }

  update(id: number, patch: Partial<Pick<Source, 'name' | 'url' | 'apiKey' | 'enabled' | 'priority' | 'forMovies' | 'forTv' | 'minSeeders' | 'dailyLimit' | 'minGapMs' | 'timeoutSeconds' | 'seedRatio' | 'seedDays'>>): void {
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
    if (s.kind === 'site') return this.siteClient(s);
    return this.clients.torznab(s.url, s.apiKey, s.timeoutSeconds * 1000);
  }

  /** A site Marquee searches itself: built in, or run from its definition file. */
  private siteClient(s: Source): TorznabApi {
    const session: SiteSession = (s.siteSession ? JSON.parse(s.siteSession) : null) ?? { cookies: {}, userAgent: null };
    const http = new SiteHttp({
      fetch: this.clients.siteFetch,
      session,
      saveSession: (ss) => this.db.update(schema.sources).set({ siteSession: JSON.stringify(ss) }).where(eq(schema.sources.id, s.id)).run(),
      solver: this.solver,
      timeoutMs: s.timeoutSeconds * 1000,
    });
    const settings = JSON.parse(s.siteSettings) as SiteSettingsValues;
    const builtin = BUILTIN[s.siteId ?? ''];
    if (builtin) return builtin.create({ settings, baseUrl: s.url, http, now: this.now });
    const def = s.siteId ? definitionFor(this.db, s.siteId) : null;
    if (!def) throw new TorznabError('not_supported', 'Marquee doesn’t have this site’s file. Press “Update the list of sites” on Settings → Sources.');
    const why = unsupportedReason(def);
    if (why) throw new TorznabError('not_supported', why);
    return new CardigannSite({ def, settings, baseUrl: s.url, http, now: this.now, sleep: this.sleep });
  }

  // ---------------- sites ----------------

  /** Adds a site from the catalogue with its settings. Checked by the caller. */
  addSite(input: { siteId: string; name?: string; url?: string; settings: SiteSettingsValues }): Source {
    const form = siteForm(this.db, input.siteId);
    if (!form) throw new TorznabError('not_supported', 'Marquee doesn’t know that site. Update the list of sites and try again.');
    const url = input.url && form.links.includes(input.url) ? input.url : form.links[0]!;
    const priv = form.type !== 'public';
    return this.db
      .insert(schema.sources)
      .values({
        name: input.name?.trim() || form.name,
        url,
        kind: 'site',
        siteId: form.id,
        siteSettings: JSON.stringify(cleanSettings(form.fields, input.settings, {})),
        private: priv,
        forMovies: form.movies,
        forTv: form.tv,
        ...(priv ? PRIVATE_DEFAULTS : PUBLIC_DEFAULTS),
        createdAt: this.now(),
      })
      .returning()
      .get();
  }

  /** Changes a site's address or settings. Secrets left blank keep what was saved. Signs in afresh. */
  updateSite(id: number, input: { url?: string; settings?: SiteSettingsValues }): void {
    const s = this.get(id);
    if (!s || s.kind !== 'site') return;
    const form = siteForm(this.db, s.siteId!);
    const changes: Partial<Source> = { siteSession: null, failures: 0, retryAt: null };
    if (input.url && form?.links.includes(input.url)) changes.url = input.url;
    if (input.settings && form) changes.siteSettings = JSON.stringify(cleanSettings(form.fields, input.settings, JSON.parse(s.siteSettings) as SiteSettingsValues));
    this.db.update(schema.sources).set(changes).where(eq(schema.sources.id, id)).run();
  }

  /**
   * "Bring over from Prowlarr": every Prowlarr site that's in Marquee's
   * catalogue becomes a site Marquee searches itself, keeping its name,
   * priority, limits and use choices. Prowlarr doesn't share passwords or
   * cookies, so sites that need them say so.
   */
  async bringOver(): Promise<BringOverResult> {
    const { url, apiKey } = this.prowlarrSettings();
    const result: BringOverResult = { moved: [], needSignIn: [], notInCatalogue: [], message: '' };
    if (!url || !apiKey) return { ...result, message: 'Link Prowlarr first.' };
    const sites = new Map((await this.clients.prowlarr(url, apiKey).sites()).map((p) => [p.id, p]));
    const rows = this.db.select().from(schema.sources).where(and(isNotNull(schema.sources.prowlarrId), eq(schema.sources.kind, 'feed'))).all();
    for (const row of rows) {
      const site = sites.get(row.prowlarrId!);
      const id = site?.definitionName?.toLowerCase() ?? '';
      const form = id ? siteForm(this.db, id) : null;
      if (!site || !form || form.unsupported) {
        result.notInCatalogue.push(row.name);
        continue;
      }
      const given: SiteSettingsValues = {};
      for (const [k, v] of Object.entries(site.settings)) {
        if (typeof v === 'string' && /^\*+$/.test(v)) continue; // Prowlarr hides secrets
        const name = k === 'freeLeechOnly' ? 'freeleech' : k;
        const field = form.fields.find((f) => f.name === name);
        if (!field) continue;
        // Prowlarr keeps a dropdown choice as its place in the options sorted by value.
        if (field.type === 'select' && typeof v === 'number') given[name] = field.options?.map((o) => o.value).sort()[v] ?? null;
        else given[name] = v as SiteSettingsValues[string];
      }
      const settings = cleanSettings(form.fields, given, {});
      const missing = form.fields.some((f) => f.secret && !settings[f.name]);
      const baseUrl = typeof site.settings.baseUrl === 'string' && form.links.includes(site.settings.baseUrl) ? site.settings.baseUrl : form.links[0]!;
      this.db
        .update(schema.sources)
        .set({ kind: 'site', siteId: form.id, url: baseUrl, apiKey: '', siteSettings: JSON.stringify(settings), siteSession: null, wasFeed: JSON.stringify({ url: row.url, apiKey: row.apiKey }), state: 'unchecked', stateMessage: null, failures: 0, retryAt: null, caps: null })
        .where(eq(schema.sources.id, row.id))
        .run();
      result.moved.push(row.name);
      if (missing) result.needSignIn.push(row.name);
    }
    const parts = [
      result.moved.length ? `${result.moved.length} ${result.moved.length === 1 ? 'site' : 'sites'} now searched by Marquee itself` : 'Nothing to bring over',
      result.needSignIn.length ? `${result.needSignIn.join(', ')} ${result.needSignIn.length === 1 ? 'needs' : 'need'} a password or cookie typed once (Prowlarr doesn’t share them)` : '',
      result.notInCatalogue.length ? `${result.notInCatalogue.length} still through Prowlarr (not in Marquee’s list yet)` : '',
    ].filter(Boolean);
    result.message = `${parts.join('. ')}.`;
    return result;
  }

  /** Undoes "Bring over": searches the site through Prowlarr again. */
  putBack(id: number): boolean {
    const s = this.get(id);
    if (!s?.wasFeed) return false;
    const was = JSON.parse(s.wasFeed) as { url: string; apiKey: string };
    this.db
      .update(schema.sources)
      .set({ kind: 'feed', siteId: null, siteSettings: '{}', siteSession: null, wasFeed: null, url: was.url, apiKey: was.apiKey, state: 'unchecked', stateMessage: null, failures: 0, retryAt: null, caps: null })
      .where(eq(schema.sources.id, id))
      .run();
    return true;
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
  private skipReason(s: Source, kind: 'movie' | 'tv', share = 1): string | null {
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
      if (used >= Math.floor(s.dailyLimit * share)) return `Used ${used} of its ${s.dailyLimit} searches today; the rest are kept for searching titles.`;
    }
    return null;
  }

  /** Searches every usable source at once. Failures are recorded, never thrown. */
  search(query: Exclude<SearchQuery, { kind: 'recent' }>): Promise<SearchOutcome> {
    return this.askAll(query.kind, 1, query);
  }

  /**
   * Asks every usable Source for its newest copies of this kind, to catch new
   * episodes as they come out (older apps call this RSS). Each call counts
   * toward a Source's daily limit, so a Source with a limit is only asked
   * while it has used under half of it: searching for titles keeps the rest.
   */
  recent(kind: 'movie' | 'tv'): Promise<SearchOutcome> {
    return this.askAll(kind, 0.5, { kind: 'recent', for: kind });
  }

  /** `share`: the part of a Source's daily limit this kind of call may use. */
  private async askAll(kind: 'movie' | 'tv', share: number, query: SearchQuery): Promise<SearchOutcome> {
    const all = this.db.select().from(schema.sources).orderBy(schema.sources.priority, schema.sources.name).all();
    const outcomes = await Promise.all(
      all.map(async (s): Promise<{ outcome: SourceOutcome; releases: FoundRelease[] }> => {
        const skip = this.skipReason(s, kind, share);
        if (skip) return { outcome: { sourceId: s.id, name: s.name, status: 'skipped', results: 0, ms: 0, message: skip }, releases: [] };
        const started = this.now();
        try {
          await this.waitForGap(s);
          const caps = s.caps ? (JSON.parse(s.caps) as TorznabCaps) : null;
          // Sites Marquee runs itself return every category; keep the kind asked for, as feeds do.
          const found = (await this.client(s).search(query, caps)).filter((r) => s.kind === 'feed' || rightKind(r, query));
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
      const message = (err as Error).message;
      // Logged so a failed link shows up in the container log. Messages never contain the key.
      console.warn(`[sources] Couldn't use Prowlarr at ${url}: ${message}`);
      return { ok: false, message };
    }
  }

  link(url: string, apiKey: string): void {
    setSetting(this.db, PROWLARR_URL, url);
    setSetting(this.db, PROWLARR_KEY, apiKey);
  }

  /** Stops syncing. Its Sources are removed, or kept as ordinary Sources you manage. */
  unlink(removeSources: boolean): void {
    // Sites brought over are Marquee's own now: they stay either way, without a way back to Prowlarr.
    if (removeSources) this.db.delete(schema.sources).where(and(isNotNull(schema.sources.prowlarrId), eq(schema.sources.kind, 'feed'))).run();
    this.db.update(schema.sources).set({ prowlarrId: null, wasFeed: null }).where(isNotNull(schema.sources.prowlarrId)).run();
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
        // Brought over: Marquee runs it now, so Prowlarr's address and key don't apply.
        if (old?.kind === 'site') continue;
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
        if (keep.has(prowlarrId) || s.kind === 'site') continue;
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

/** Keeps only the site's own settings, with blank secrets keeping what was saved. */
function cleanSettings(fields: { name: string; type: string; secret?: boolean }[], given: SiteSettingsValues, saved: SiteSettingsValues): SiteSettingsValues {
  const out: SiteSettingsValues = {};
  for (const f of fields) {
    if (f.type === 'info') continue;
    const v = given[f.name];
    if (f.secret && (v === undefined || v === null || v === '')) {
      if (saved[f.name]) out[f.name] = saved[f.name];
      continue;
    }
    if (v === undefined) {
      if (saved[f.name] !== undefined) out[f.name] = saved[f.name];
      continue;
    }
    out[f.name] = f.type === 'checkbox' ? v === true || v === 'true' || v === 'True' : typeof v === 'string' ? v.trim() : v;
  }
  return out;
}

function toView(s: Source, now: number, st?: { calls: number; failures: number; avgMs: number | null; today: number }, site?: { name: string | null; settings: SiteSettingsView } | null): SourceView {
  const state: SourceState = s.enabled ? s.state : 'paused';
  const caps = s.caps ? (JSON.parse(s.caps) as TorznabCaps) : null;
  return {
    id: s.id,
    name: s.name,
    kind: s.kind,
    siteId: s.siteId,
    siteName: site?.name ?? null,
    siteSettings: site?.settings ?? null,
    canPutBack: !!s.wasFeed,
    url: s.url,
    hasKey: !!s.apiKey,
    enabled: s.enabled,
    priority: s.priority,
    private: s.private,
    forMovies: s.forMovies,
    forTv: s.forTv,
    minSeeders: s.minSeeders,
    dailyLimit: s.dailyLimit,
    seedRatio: s.seedRatio,
    seedDays: s.seedDays,
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
