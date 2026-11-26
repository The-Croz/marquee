import { format } from 'node:util';
import type { LogLevel, LogLine } from '@marquee/shared';
import type { Db } from '../db/index.js';
import { liveActivities, notificationChannels, settings, sources, users } from '../db/schema.js';

/**
 * The Logs page: the server's recent lines, kept in memory (the newest
 * 5,000), with secrets taken out before they're kept. Everything still goes
 * to the container's own log as before.
 */

export const KEEP_LINES = 5000;

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

// ---------------- Taking secrets out ----------------

/** Saved secrets to hide, by value. Filled from the database by `watchSecrets`. */
let known: string[] = [];
let readKnown: (() => string[]) | null = null;
let knownAt = 0;

/** Keeps the list of saved secrets (API keys, passwords, tokens) to hide, read again at most once a minute. */
export function watchSecrets(db: Db, now: () => number = Date.now): void {
  readKnown = () => secretsIn(db);
  knownAt = 0;
  clock = now;
}
let clock: () => number = Date.now;

const SECRET_NAME = /(pass(word)?|api_?key|apikey|token|secret|passkey|cookie|_key)$/i;

/** Every saved secret: settings with secret-sounding names, Source keys, site settings and notification channel secrets. */
export function secretsIn(db: Db): string[] {
  const out: string[] = [];
  for (const s of db.select().from(settings).all()) if (SECRET_NAME.test(s.key) && s.value) out.push(s.value);
  for (const s of db.select({ apiKey: sources.apiKey, site: sources.siteSettings }).from(sources).all()) {
    if (s.apiKey) out.push(s.apiKey);
    out.push(...secretValues(s.site));
  }
  for (const c of db.select({ config: notificationChannels.config }).from(notificationChannels).all()) out.push(...secretValues(c.config));
  for (const l of db.select({ token: liveActivities.token }).from(liveActivities).all()) out.push(l.token);
  for (const u of db.select({ token: users.plexToken }).from(users).all()) if (u.token) out.push(u.token);
  // Very short values would hide ordinary words; real keys and passwords are longer.
  return [...new Set(out.map((v) => v.trim()).filter((v) => v.length >= 6))].sort((a, b) => b.length - a.length);
}

function secretValues(json: string | null): string[] {
  try {
    const o = JSON.parse(json || '{}') as Record<string, unknown>;
    return Object.entries(o).flatMap(([k, v]) => (typeof v === 'string' && (SECRET_NAME.test(k) || /^(password|cookie|key|token)$/i.test(k)) ? [v] : []));
  } catch {
    return [];
  }
}

function currentSecrets(): string[] {
  if (readKnown && clock() - knownAt > 60_000) {
    try {
      known = readKnown();
    } catch {
      /* the database may be closing; keep the last list */
    }
    knownAt = clock();
  }
  return known;
}

/**
 * Hides secrets in text: keys and tokens in addresses (`?apikey=…`, `X-Plex-Token=…`),
 * passwords in addresses (`http://user:pass@host`), `Authorization`/`Bearer`/`X-Api-Key`
 * values, cookies, and any saved secret wherever it appears.
 */
export function scrub(text: string, secrets: string[] = currentSecrets()): string {
  let out = text
    .replace(/([?&;](?:apikey|api_key|passkey|key|token|x-plex-token|password|pass|auth|sid|uid|session)=)[^&#\s"']*/gi, '$1…')
    .replace(/(\/\/[^/\s:@]+:)[^@/\s]+@/g, '$1…@')
    .replace(/((?:x-api-key|x-plex-token|authorization|cookie|set-cookie)["']?\s*[:=]\s*["']?)(?:(?:bearer|basic)\s+)?[^\s"',;}]+/gi, '$1…')
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 …');
  for (const s of secrets) if (out.includes(s)) out = out.split(s).join('…');
  return out;
}

// ---------------- Keeping lines ----------------

export class LogBook {
  private lines: LogLine[] = [];
  private nextId = 1;

  constructor(
    private keep = KEEP_LINES,
    private now: () => number = Date.now,
  ) {}

  add(level: LogLevel, message: string): LogLine {
    const clean = scrub(message);
    const area = /^\[([^\]]{1,40})\]\s*/.exec(clean);
    const line: LogLine = { id: this.nextId++, at: this.now(), level, area: area ? area[1]! : null, message: area ? clean.slice(area[0].length) : clean };
    this.lines.push(line);
    if (this.lines.length > this.keep) this.lines.splice(0, this.lines.length - this.keep);
    return line;
  }

  /** Newest last. `level` keeps that level and worse; `search` matches words in the line. */
  read(opts: { level?: LogLevel; search?: string; limit?: number } = {}): LogLine[] {
    const min = LEVEL_ORDER[opts.level ?? 'debug'];
    const q = opts.search?.trim().toLowerCase();
    const found = this.lines.filter((l) => LEVEL_ORDER[l.level] >= min && (!q || `${l.area ?? ''} ${l.message}`.toLowerCase().includes(q)));
    return opts.limit ? found.slice(-opts.limit) : found;
  }

  get size(): number {
    return this.lines.length;
  }

  /** Plain text, one line each, for a bug report. */
  text(opts: { level?: LogLevel; search?: string } = {}): string {
    return this.read(opts)
      .map((l) => `${new Date(l.at).toISOString()} ${l.level.toUpperCase().padEnd(5)} ${l.area ? `[${l.area}] ` : ''}${l.message}`)
      .join('\n');
  }
}

/** The log book the running server writes to. */
export const serverLog = new LogBook();

/**
 * Copies everything written with console.log/info/warn/error/debug into a log
 * book (secrets taken out), and still prints it as before.
 */
export function captureConsole(book: LogBook = serverLog): () => void {
  const original = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  const wrap =
    (level: LogLevel, print: (...a: unknown[]) => void) =>
    (...args: unknown[]) => {
      const text = format(...args.map((a) => (a instanceof Error ? (a.stack ?? a.message) : a)));
      book.add(level, text);
      print(scrub(text));
    };
  console.log = wrap('info', original.log);
  console.info = wrap('info', original.info);
  console.warn = wrap('warn', original.warn);
  console.error = wrap('error', original.error);
  console.debug = wrap('debug', original.debug);
  return () => Object.assign(console, original);
}
