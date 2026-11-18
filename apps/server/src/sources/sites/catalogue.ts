import fs from 'node:fs';
import path from 'node:path';
import { asc, eq, inArray, isNotNull } from 'drizzle-orm';
import { unzipSync } from 'fflate';
import type { SiteForm, SiteSummary, SitesView } from '@marquee/shared';
import { getSetting, setSetting, type Db } from '../../db/index.js';
import { siteDefinitions, sources } from '../../db/schema.js';
import { iptorrents } from './builtin/iptorrents.js';
import { knaben } from './builtin/knaben.js';
import type { BuiltinSite } from './builtin/types.js';
import { categoryMap, readDefinition, siteCategories, siteFields, unsupportedReason, type Definition } from './definition.js';

/**
 * The list of sites Marquee can run: Prowlarr's catalogue (downloaded on your
 * server once a day, never shipped with Marquee), your own files in the
 * sites folder (they win over the catalogue's file with the same id), and the
 * few sites written into Marquee itself.
 */

export const CATALOGUE_URL = 'https://indexers.prowlarr.com/master/12/package.zip';
export const REFRESH_EVERY = 24 * 3_600_000;
const REFRESHED_AT = 'catalogue.refreshed_at';
const MESSAGE = 'catalogue.message';

export const BUILTIN: Record<string, BuiltinSite> = { iptorrents, knaben };

export const customFolder = (dataDir: string) => path.join(dataDir, 'sites');

function summary(d: Definition, origin: 'catalogue' | 'custom'): SiteSummary {
  const cats = categoryMap(d);
  const type = d.type === 'private' || d.type === 'semi-private' || d.type === 'semiPrivate' ? (d.type === 'private' ? 'private' : 'semiPrivate') : 'public';
  return {
    id: d.id,
    name: d.name,
    description: (d.description ?? '').trim(),
    type,
    language: d.language ?? null,
    origin,
    movies: siteCategories(cats, 'movie').length > 0,
    tv: siteCategories(cats, 'tv').length > 0,
    unsupported: unsupportedReason(d),
  };
}

/** Saves a set of site files; ids made by hand in the sites folder aren't touched by the catalogue. */
function store(db: Db, files: { id: string; yaml: string }[], origin: 'catalogue' | 'custom', now: number): void {
  const custom = new Set(db.select({ id: siteDefinitions.id }).from(siteDefinitions).where(eq(siteDefinitions.origin, 'custom')).all().map((r) => r.id));
  db.transaction((tx) => {
    for (const f of files) {
      if (origin === 'catalogue' && custom.has(f.id)) continue;
      tx.insert(siteDefinitions)
        .values({ id: f.id, origin, yaml: f.yaml, updatedAt: now })
        .onConflictDoUpdate({ target: siteDefinitions.id, set: { origin, yaml: f.yaml, updatedAt: now } })
        .run();
    }
  });
}

export interface RefreshResult {
  ok: boolean;
  count: number;
  custom: number;
  message: string;
}

/** Downloads the catalogue and reads the sites folder. Problems are reported, never thrown. */
export async function refreshCatalogue(deps: { db: Db; dataDir: string; fetchCatalogue: () => Promise<Uint8Array>; now: () => number }): Promise<RefreshResult> {
  const { db, now } = deps;
  let count = 0;
  let message: string;
  let ok = true;
  try {
    const zip = unzipSync(await deps.fetchCatalogue());
    const files: { id: string; yaml: string }[] = [];
    for (const [name, data] of Object.entries(zip)) {
      if (!name.endsWith('.yml')) continue;
      const yaml = new TextDecoder().decode(data);
      try {
        files.push({ id: readDefinition(yaml).id, yaml });
      } catch {
        /* a broken file in the catalogue: skip it */
      }
    }
    if (!files.length) throw new Error('The download had no site files in it.');
    // Sites dropped from the catalogue go, unless a Source still uses them.
    const used = new Set(db.select({ id: sources.siteId }).from(sources).where(isNotNull(sources.siteId)).all().map((r) => r.id!));
    const keep = new Set(files.map((f) => f.id));
    const gone = db.select({ id: siteDefinitions.id }).from(siteDefinitions).where(eq(siteDefinitions.origin, 'catalogue')).all().map((r) => r.id).filter((id) => !keep.has(id) && !used.has(id));
    if (gone.length) db.delete(siteDefinitions).where(inArray(siteDefinitions.id, gone)).run();
    store(db, files, 'catalogue', now());
    count = files.length;
    message = `Catalogue up to date: ${count} sites.`;
  } catch (err) {
    ok = false;
    message = `Couldn’t download the site catalogue (${(err as Error).message}). Marquee keeps the copy it has and tries again tomorrow.`;
  }
  const custom = readCustomFolder(db, deps.dataDir, now());
  if (custom.problems.length) message += ` ${custom.problems.join(' ')}`;
  setSetting(db, REFRESHED_AT, String(now()));
  setSetting(db, MESSAGE, message);
  return { ok, count, custom: custom.count, message };
}

/** Your own site files: `<data>/sites/*.yml`. A file removed from the folder stops being custom on the next refresh. */
export function readCustomFolder(db: Db, dataDir: string, now: number): { count: number; problems: string[] } {
  const dir = customFolder(dataDir);
  const problems: string[] = [];
  const files: { id: string; yaml: string }[] = [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((n) => /\.ya?ml$/i.test(n));
  } catch {
    /* no folder yet */
  }
  for (const n of names) {
    const yaml = fs.readFileSync(path.join(dir, n), 'utf8');
    try {
      files.push({ id: readDefinition(yaml).id, yaml });
    } catch (err) {
      problems.push(`${n} in the sites folder couldn’t be read: ${(err as Error).message}`);
    }
  }
  const ids = new Set(files.map((f) => f.id));
  const stale = db.select({ id: siteDefinitions.id }).from(siteDefinitions).where(eq(siteDefinitions.origin, 'custom')).all().filter((r) => !ids.has(r.id));
  // A custom file that's gone falls back to the catalogue's copy at the next download.
  if (stale.length) db.update(siteDefinitions).set({ origin: 'catalogue', updatedAt: 0 }).where(inArray(siteDefinitions.id, stale.map((r) => r.id))).run();
  store(db, files, 'custom', now);
  return { count: files.length, problems };
}

export function catalogueDue(db: Db, now: number): boolean {
  return now - (Number(getSetting(db, REFRESHED_AT)) || 0) >= REFRESH_EVERY;
}

export function definitionFor(db: Db, id: string): Definition | null {
  const row = db.select().from(siteDefinitions).where(eq(siteDefinitions.id, id)).get();
  return row ? readDefinition(row.yaml) : null;
}

/** Sites with movies or TV, built-in ones first, then by name. */
export function listSites(db: Db, dataDir: string, q?: string): SitesView {
  const rows = db.select().from(siteDefinitions).orderBy(asc(siteDefinitions.id)).all();
  const sites: SiteSummary[] = Object.values(BUILTIN).map((b) => b.summary);
  for (const r of rows) {
    try {
      const s = summary(readDefinition(r.yaml), r.origin as 'catalogue' | 'custom');
      if ((s.movies || s.tv) && !BUILTIN[s.id]) sites.push(s);
    } catch {
      /* unreadable file: left out */
    }
  }
  const needle = q?.trim().toLowerCase();
  const filtered = needle ? sites.filter((s) => s.name.toLowerCase().includes(needle) || s.id.includes(needle)) : sites;
  filtered.sort((a, b) => Number(b.origin === 'builtin') - Number(a.origin === 'builtin') || a.name.localeCompare(b.name));
  return {
    sites: filtered,
    catalogue: { refreshedAt: Number(getSetting(db, REFRESHED_AT)) || null, message: getSetting(db, MESSAGE) || null, count: sites.length, customFolder: customFolder(dataDir) },
  };
}

export function siteForm(db: Db, id: string): SiteForm | null {
  const b = BUILTIN[id];
  if (b) return { ...b.summary, links: b.links, fields: b.fields };
  const row = db.select().from(siteDefinitions).where(eq(siteDefinitions.id, id)).get();
  if (!row) return null;
  const d = readDefinition(row.yaml);
  return { ...summary(d, row.origin as 'catalogue' | 'custom'), links: d.links, fields: siteFields(d) };
}
