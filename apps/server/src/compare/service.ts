import { desc, eq, inArray } from 'drizzle-orm';
import type { CompareVerdict, CompareView, ComparisonView, CopyView } from '@marquee/shared';
import type { Config } from '../config.js';
import { getSetting, schema, setSetting, type Db } from '../db/index.js';
import { HttpError, type Clients } from '../http.js';
import { ArrError, type RadarrGrab, type RadarrHistoryApi, type RadarrRelease } from '../library/arr.js';
import { readServices } from '../library/services.js';
import { decide, type Decision, type Wanted } from '../releases/decide.js';
import type { ParsedRelease } from '../releases/parse.js';
import { ProfileService } from '../releases/profiles.js';
import { copyView } from '../releases/view.js';
import type { FoundRelease, SourceService } from '../sources/service.js';

/**
 * Comparison mode: for each copy Radarr downloaded, Marquee works out what it
 * would have picked, so you can see how often they agree before letting
 * Marquee take over movies. Only reads from Radarr; never changes it.
 */

const ENABLED = 'compare.enabled';
const LAST_RUN = 'compare.last_run';
/** How far back the first run looks. */
const LOOKBACK = 30 * 24 * 60 * 60 * 1000;
/** Each comparison searches every Source, so only a few per run, to stay polite. */
export const PER_RUN = 5;

type Row = typeof schema.comparisons.$inferSelect;
interface Judgement {
  radarrCopy: CopyView;
  pick: CopyView | null;
  /** Kept for the verdict text. */
  radarrRejected: string | null;
}

const SOURCE_RANK: Partial<Record<NonNullable<ParsedRelease['source']>, number>> = { remux: 6, bluray: 5, webdl: 4, webrip: 3, hdtv: 2, dvd: 1 };
/** A rough, app-neutral quality ladder: resolution first, then where it came from. */
const qualityRank = (p: ParsedRelease) => (p.resolution ?? 0) * 10 + (p.source ? (SOURCE_RANK[p.source] ?? 0) : 0);
const sameCopy = (a: string, b: string) => a.toLowerCase().replace(/[^a-z0-9]/g, '') === b.toLowerCase().replace(/[^a-z0-9]/g, '');

export function verdictFor(pick: Decision | null, radarr: Decision): CompareVerdict {
  if (!pick) return 'nothing';
  if (sameCopy(pick.copy.title, radarr.copy.title)) return 'same';
  const a = qualityRank(pick.parsed);
  const b = qualityRank(radarr.parsed);
  return a === b ? 'same_quality' : a > b ? 'higher' : 'lower';
}

const VERDICT_LABEL: Record<CompareVerdict, string> = {
  same: 'Same copy',
  same_quality: 'Same quality, different copy',
  higher: 'Marquee picks higher quality',
  lower: 'Marquee picks lower quality',
  nothing: 'Marquee found nothing',
};
export const verdictLabel = (v: CompareVerdict) => VERDICT_LABEL[v];

export class ComparisonService {
  constructor(
    private db: Db,
    private config: Config,
    private clients: Clients,
    private sources: SourceService,
    private now: () => number,
  ) {}

  enabled(): boolean {
    return getSetting(this.db, ENABLED) === '1';
  }

  setEnabled(on: boolean): void {
    setSetting(this.db, ENABLED, on ? '1' : '0');
  }

  private radarr(): RadarrHistoryApi | null {
    const s = readServices(this.db, this.config);
    return s.radarrUrl && s.radarrApiKey ? this.clients.radarrHistory(s.radarrUrl, s.radarrApiKey) : null;
  }

  private needRadarr(): RadarrHistoryApi {
    const r = this.radarr();
    if (!r) throw new HttpError(409, 'no_radarr', 'Connect Radarr in Settings → Services first. Marquee only reads from it.');
    return r;
  }

  /** Brings in Radarr's new downloads, then compares up to PER_RUN of the ones waiting. */
  async run(): Promise<{ added: number; compared: number; waiting: number }> {
    const radarr = this.needRadarr();
    const since = Number(getSetting(this.db, LAST_RUN)) || this.now() - LOOKBACK;
    let grabs: RadarrGrab[];
    try {
      grabs = await radarr.grabs(since);
    } catch (err) {
      throw new HttpError(502, 'radarr_failed', err instanceof ArrError ? err.message : 'Radarr didn’t answer.');
    }
    let added = 0;
    for (const g of grabs) {
      const movie = g.tmdbId ? this.db.select({ id: schema.movies.id }).from(schema.movies).where(eq(schema.movies.tmdbId, g.tmdbId)).get() : undefined;
      const res = this.db
        .insert(schema.comparisons)
        .values({ radarrHistoryId: g.id, radarrMovieId: g.radarrMovieId, movieId: movie?.id ?? null, tmdbId: g.tmdbId, title: g.movieTitle, grabbedAt: g.date, radarr: JSON.stringify(g) })
        .onConflictDoNothing()
        .run();
      added += res.changes;
    }
    setSetting(this.db, LAST_RUN, String(this.now()));
    const waiting = this.db.select().from(schema.comparisons).where(eq(schema.comparisons.status, 'waiting')).orderBy(desc(schema.comparisons.grabbedAt)).limit(PER_RUN).all();
    for (const row of waiting) await this.compare(row.id, 'own_search');
    return { added, compared: waiting.length, waiting: this.waitingCount() };
  }

  private waitingCount(): number {
    return this.db.select({ id: schema.comparisons.id }).from(schema.comparisons).where(eq(schema.comparisons.status, 'waiting')).all().length;
  }

  /**
   * Compares one download. `own_search` searches Marquee's Sources;
   * `same_list` asks Radarr for the copies it saw, so both judge the same list.
   */
  async compare(id: number, mode: 'own_search' | 'same_list'): Promise<ComparisonView> {
    const row = this.db.select().from(schema.comparisons).where(eq(schema.comparisons.id, id)).get();
    if (!row) throw new HttpError(404, 'not_found', 'No such comparison.');
    const grab = JSON.parse(row.radarr) as RadarrGrab;
    const fail = (message: string) => {
      this.db.update(schema.comparisons).set({ status: 'failed', mode, message, checkedAt: this.now() }).where(eq(schema.comparisons.id, id)).run();
      return this.view(id);
    };

    const movie = grab.tmdbId ? this.db.select().from(schema.movies).where(eq(schema.movies.tmdbId, grab.tmdbId)).get() : undefined;
    if (!movie) return fail('This movie isn’t in Marquee’s library yet. Scan your library, then compare again.');
    const profile = new ProfileService(this.db, this.now).forTitle('movie', movie.profile);
    const wanted: Wanted = { kind: 'movie', title: movie.title, year: movie.year, tmdbId: movie.tmdbId, imdbId: movie.imdbId, runtime: movie.runtime };

    let found: FoundRelease[];
    if (mode === 'own_search') {
      const outcome = await this.sources.search({ kind: 'movie', title: movie.title, year: movie.year, tmdbId: movie.tmdbId, imdbId: movie.imdbId });
      if (!outcome.sources.some((s) => s.status === 'searched')) return fail('No Source could be searched just now. They’re tried again on the next run.');
      found = outcome.releases;
    } else {
      let releases: RadarrRelease[];
      try {
        releases = await this.needRadarr().releases(grab.radarrMovieId);
      } catch (err) {
        return fail(err instanceof ArrError ? err.message : 'Radarr didn’t answer.');
      }
      found = releases.filter((r) => r.mappedMovieId === null || r.mappedMovieId === grab.radarrMovieId).map(fromRadarr);
    }

    const decisions = decide(wanted, found, profile);
    const pick = decisions[0]?.accepted ? decisions[0] : null;
    // Radarr's download as Marquee judges it: from the same list if it's there, else on its own.
    const radarr = decisions.find((d) => sameCopy(d.copy.title, grab.title)) ?? decide(wanted, [fromGrab(grab)], profile)[0]!;
    const verdict = verdictFor(pick, radarr);
    const judgement: Judgement = {
      radarrCopy: copyView(radarr),
      pick: pick ? copyView(pick) : null,
      radarrRejected: radarr.rejections[0]?.message ?? null,
    };
    this.db
      .update(schema.comparisons)
      .set({ status: 'done', mode, profile: profile.name, verdict, marquee: JSON.stringify(judgement), message: null, checkedAt: this.now(), movieId: movie.id })
      .where(eq(schema.comparisons.id, id))
      .run();
    return this.view(id);
  }

  /** Forgets a failed result so the next run tries it again. */
  retry(id: number): ComparisonView {
    this.db.update(schema.comparisons).set({ status: 'waiting', message: null }).where(eq(schema.comparisons.id, id)).run();
    return this.view(id);
  }

  view(id: number): ComparisonView {
    const row = this.db.select().from(schema.comparisons).where(eq(schema.comparisons.id, id)).get();
    if (!row) throw new HttpError(404, 'not_found', 'No such comparison.');
    return toView(row);
  }

  overview(): CompareView {
    const rows = this.db.select().from(schema.comparisons).orderBy(desc(schema.comparisons.grabbedAt)).all();
    const counts: Record<CompareVerdict, number> = { same: 0, same_quality: 0, higher: 0, lower: 0, nothing: 0 };
    for (const r of rows) if (r.status === 'done' && r.verdict) counts[r.verdict]++;
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const last = Number(getSetting(this.db, LAST_RUN)) || null;
    return {
      enabled: this.enabled(),
      radarrConnected: this.radarr() !== null,
      lastRun: last,
      waiting: rows.filter((r) => r.status === 'waiting').length,
      total,
      counts,
      agreement: total ? Math.round(((counts.same + counts.same_quality) / total) * 100) : null,
      items: rows.slice(0, 200).map(toView),
    };
  }

  /** Removes everything compared so far (Radarr is untouched). */
  clear(ids?: number[]): void {
    if (ids) this.db.delete(schema.comparisons).where(inArray(schema.comparisons.id, ids)).run();
    else this.db.delete(schema.comparisons).run();
    if (!ids) setSetting(this.db, LAST_RUN, '');
  }
}

function toView(row: Row): ComparisonView {
  const grab = JSON.parse(row.radarr) as RadarrGrab;
  const j = row.marquee ? (JSON.parse(row.marquee) as Judgement) : null;
  return {
    id: row.id,
    movieId: row.movieId,
    title: row.title,
    grabbedAt: row.grabbedAt,
    status: row.status,
    mode: row.mode,
    profileName: row.profile,
    verdict: row.verdict,
    summary: summary(row, j),
    radarrTitle: grab.title,
    radarrQuality: grab.quality,
    radarrScore: grab.score,
    radarrCopy: j?.radarrCopy ?? null,
    marqueeCopy: j?.pick ?? null,
    message: row.message,
    checkedAt: row.checkedAt,
  };
}

function summary(row: Row, j: Judgement | null): string {
  if (row.status === 'waiting') return 'Waiting to be compared. A few are done each run, to keep searches polite.';
  if (row.status === 'failed' || !j || !row.verdict) return row.message ?? 'Couldn’t compare this one.';
  const turnedDown = j.radarrRejected ? ` ${row.profile} would turn Radarr’s down: ${lowerFirst(j.radarrRejected)}` : '';
  switch (row.verdict) {
    case 'same':
      return 'Both picked the same copy.';
    case 'same_quality':
      return `Same quality (${j.radarrCopy.qualityLabel}), but Marquee prefers another copy.${turnedDown}`;
    case 'higher':
    case 'lower':
      return `Marquee picks ${j.pick!.qualityLabel}; Radarr took ${j.radarrCopy.qualityLabel}.${turnedDown}`;
    case 'nothing':
      return `Marquee would take none of the copies it found.${turnedDown}`;
  }
}

/** "Low-quality group" → "low-quality group", but "HEVC…" stays as it is. */
const lowerFirst = (s: string) => (/^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);

/** A copy from Radarr's own list, in the shape Marquee's engine takes. No download link: nothing is grabbed. */
function fromRadarr(r: RadarrRelease): FoundRelease {
  return {
    title: r.title,
    size: r.size,
    seeders: r.seeders,
    leechers: r.leechers,
    grabs: null,
    publishedAt: r.publishedAt,
    downloadUrl: '',
    infoUrl: r.infoUrl,
    guid: `${r.indexer}:${r.title}`,
    infoHash: r.infoHash,
    categories: [],
    imdbId: null,
    tmdbId: null,
    tvdbId: null,
    freeleech: r.freeleech,
    sourceId: 0,
    sourceName: r.indexer ?? 'Radarr',
    sourcePriority: 25,
  };
}

function fromGrab(g: RadarrGrab): FoundRelease {
  return { ...fromRadarr({ title: g.title, size: g.size, seeders: null, leechers: null, indexer: g.indexer, infoHash: null, infoUrl: null, publishedAt: g.date, approved: true, rejections: [], score: g.score, quality: g.quality, freeleech: false, mappedMovieId: g.radarrMovieId }), tmdbId: g.tmdbId };
}

