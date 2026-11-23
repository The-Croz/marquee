import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { episodes, series } from '../db/schema.js';
import { HttpError } from '../http.js';

/**
 * Which episodes of a show Marquee wants, in one choice (Sonarr's "monitor"
 * presets): everything, only episodes still to come, the latest season, the
 * first season, or nothing. Also says whether seasons that appear later are
 * wanted too. Specials (season 0) are never wanted by a preset; tick them by hand.
 */

export type ShowPreset = 'all' | 'future' | 'latest' | 'first' | 'none';
export const SHOW_PRESETS: ShowPreset[] = ['all', 'future', 'latest', 'first', 'none'];

export const SHOW_PRESET_TEXT: Record<ShowPreset, { label: string; explain: string }> = {
  all: { label: 'Every episode', explain: 'Every season, and new ones as they come.' },
  future: { label: 'Only new episodes', explain: 'Nothing that’s already aired; every episode from now on.' },
  latest: { label: 'The latest season', explain: 'The newest season, and new ones as they come.' },
  first: { label: 'The first season', explain: 'Season 1 only, to try it out. Later seasons aren’t wanted.' },
  none: { label: 'Nothing for now', explain: 'Added, but not looked for. Tick seasons by hand later.' },
};

export function applyShowPreset(db: Db, seriesId: number, preset: ShowPreset, today: string): { wanted: number } {
  const show = db.select().from(series).where(eq(series.id, seriesId)).get();
  if (!show) throw new HttpError(404, 'not_found', 'No such show.');
  const regular = db.select().from(episodes).where(eq(episodes.seriesId, seriesId)).all().filter((e) => e.season > 0);
  const latest = regular.reduce((m, e) => Math.max(m, e.season), 0);
  const want = (e: (typeof regular)[number]): boolean => {
    switch (preset) {
      case 'all':
        return true;
      case 'future':
        return !e.airDate || e.airDate > today;
      case 'latest':
        return e.season === latest;
      case 'first':
        return e.season === 1;
      case 'none':
        return false;
    }
  };
  let wanted = 0;
  db.transaction(() => {
    db.update(series).set({ monitored: preset !== 'none', wantNew: preset === 'all' || preset === 'future' || preset === 'latest' }).where(eq(series.id, seriesId)).run();
    db.update(episodes).set({ monitored: false }).where(and(eq(episodes.seriesId, seriesId), eq(episodes.season, 0))).run();
    for (const e of regular) {
      const on = want(e);
      if (on) wanted++;
      if (on !== e.monitored) db.update(episodes).set({ monitored: on }).where(eq(episodes.id, e.id)).run();
    }
  });
  return { wanted };
}

