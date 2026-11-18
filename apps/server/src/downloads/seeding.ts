import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { sources, type Download } from '../db/schema.js';
import { readDownloader } from './service.js';

/**
 * Seeding rules: how long a download keeps sharing. A Source can have its
 * own rule; otherwise private sites keep sharing (their own minimums vary
 * and missing them can get you banned) and everything else uses the
 * defaults: ratio 2.0 or 14 days, whichever comes first. 0 means "no limit"
 * for that part; no limit on either means "keep sharing".
 */

export interface SeedRule {
  /** 0 = no ratio limit. */
  ratio: number;
  /** 0 = no time limit. */
  days: number;
  /** Where the rule comes from, in plain words. */
  from: string;
}

export function seedRule(db: Db, d: Pick<Download, 'sourceId'>): SeedRule {
  const settings = readDownloader(db);
  const s = d.sourceId ? db.select().from(sources).where(eq(sources.id, d.sourceId)).get() : undefined;
  if (s && (s.seedRatio !== null || s.seedDays !== null)) {
    return { ratio: s.seedRatio ?? 0, days: s.seedDays ?? 0, from: `${s.name}’s own rule` };
  }
  if (s?.private && settings.privateKeepSharing) return { ratio: 0, days: 0, from: `${s.name} is a private site` };
  return { ratio: settings.seedRatio, days: settings.seedDays, from: 'the default rule' };
}

/** Has it shared enough? Never, when the rule has no limits. */
export function sharedEnough(rule: SeedRule, ratio: number, seedingSeconds: number): boolean {
  return (rule.ratio > 0 && ratio >= rule.ratio) || (rule.days > 0 && seedingSeconds >= rule.days * 86_400);
}

/** "ratio 0.8 of 2.0 · 3 of 14 days" */
export function sharingProgress(rule: SeedRule, ratio: number, seedingSeconds: number): string {
  const parts: string[] = [];
  if (rule.ratio > 0) parts.push(`ratio ${ratio.toFixed(1)} of ${rule.ratio.toFixed(1)}`);
  if (rule.days > 0) parts.push(`${Math.floor(seedingSeconds / 86_400)} of ${rule.days} days`);
  return parts.join(' · ');
}
