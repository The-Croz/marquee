import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Subtitle files that belong with a video ("extras" that come along with it):
 * `.srt`, `.ass`, `.ssa`, `.vtt`, `.sup`, and `.sub` + `.idx` pairs.
 *
 * A subtitle belongs to a video when it sits next to it with the video's
 * name in front ("Movie.2024.en.forced.srt"), or in a Subs folder beside it.
 * When there's only one video, any subtitle in its folder or Subs folder is
 * its own. The tags after the name (language, "forced", "sdh") are kept, so
 * Plex and Jellyfin still know what each one is once it's renamed to match.
 */

export const SUBTITLE = /\.(srt|ass|ssa|vtt|sup|sub|idx)$/i;
const SUBS_FOLDER = /^(subs?|subtitles?)$/i;

/** Language names and codes Plex and Jellyfin both read, mapped to the short code. */
const LANGUAGES: Record<string, string> = {
  english: 'en', eng: 'en', en: 'en', spanish: 'es', spa: 'es', es: 'es', espanol: 'es', french: 'fr', fre: 'fr', fra: 'fr', fr: 'fr',
  german: 'de', ger: 'de', deu: 'de', de: 'de', italian: 'it', ita: 'it', it: 'it', portuguese: 'pt', por: 'pt', pt: 'pt', dutch: 'nl', dut: 'nl', nld: 'nl', nl: 'nl',
  swedish: 'sv', swe: 'sv', sv: 'sv', norwegian: 'no', nor: 'no', no: 'no', danish: 'da', dan: 'da', da: 'da', finnish: 'fi', fin: 'fi', fi: 'fi',
  polish: 'pl', pol: 'pl', pl: 'pl', russian: 'ru', rus: 'ru', ru: 'ru', japanese: 'ja', jpn: 'ja', ja: 'ja', korean: 'ko', kor: 'ko', ko: 'ko',
  chinese: 'zh', chi: 'zh', zho: 'zh', zh: 'zh', arabic: 'ar', ara: 'ar', ar: 'ar', hebrew: 'he', heb: 'he', he: 'he', greek: 'el', gre: 'el', ell: 'el', el: 'el',
  turkish: 'tr', tur: 'tr', tr: 'tr', czech: 'cs', cze: 'cs', ces: 'cs', cs: 'cs', hungarian: 'hu', hun: 'hu', hu: 'hu', romanian: 'ro', rum: 'ro', ron: 'ro', ro: 'ro',
};
const FLAGS: Record<string, string> = { forced: 'forced', sdh: 'sdh', hi: 'sdh', cc: 'cc', default: 'default' };

/** The bits after a video's name worth keeping: "en.forced" from "Movie.2024.English.Forced.srt" or "2_English.srt". */
export function subtitleTags(fileName: string, videoStem: string | null): string[] {
  const noExt = fileName.replace(SUBTITLE, '');
  const rest = videoStem && noExt.toLowerCase().startsWith(videoStem.toLowerCase()) ? noExt.slice(videoStem.length) : noExt;
  const words = rest.toLowerCase().split(/[\s._()[\]-]+/).filter(Boolean);
  const lang = words.map((w) => LANGUAGES[w]).find(Boolean);
  const flags = [...new Set(words.map((w) => FLAGS[w]).filter((f): f is string => !!f))];
  return [...(lang ? [lang] : []), ...flags];
}

export interface Extra {
  /** Full path of the subtitle file now. */
  from: string;
  /** Its new name, next to the video's new name. */
  name: string;
}

/**
 * New names for subtitles, given the video's new name without its extension
 * ("Dune - Part Two (2024) [WEBDL-2160p]"). Two of the same kind get ".2", ".3".
 */
export function extrasNames(subtitles: string[], oldStem: string | null, newStem: string): Extra[] {
  const used = new Set<string>();
  // .sub and .idx with the same name travel as a pair and share a name.
  const pairName = new Map<string, string>();
  return subtitles.map((from) => {
    const file = path.basename(from);
    const ext = path.extname(file).toLowerCase();
    const base = file.slice(0, -ext.length);
    const pairKey = /\.(sub|idx)$/i.test(file) ? path.join(path.dirname(from), base) : null;
    const tags = subtitleTags(file, oldStem);
    let stem = [newStem, ...tags].join('.');
    if (pairKey && pairName.has(pairKey)) stem = pairName.get(pairKey)!;
    else {
      for (let n = 2; used.has(`${stem}${ext}`) || (pairKey && (used.has(`${stem}.sub`) || used.has(`${stem}.idx`))); n++) stem = [newStem, ...tags, String(n)].join('.');
      if (pairKey) pairName.set(pairKey, stem);
    }
    used.add(`${stem}${ext}`);
    return { from, name: `${stem}${ext}` };
  });
}

/**
 * The subtitles beside a video on disk. `onlyVideo` says it's the only video
 * in its folder, so subtitles without its name in front count too.
 */
export async function subtitlesBeside(video: string, onlyVideo: boolean): Promise<string[]> {
  const dir = path.dirname(video);
  const stem = path.basename(video, path.extname(video)).toLowerCase();
  const out: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (e.isFile() && SUBTITLE.test(e.name) && (onlyVideo || e.name.toLowerCase().startsWith(`${stem}.`))) out.push(path.join(dir, e.name));
    if (e.isDirectory() && SUBS_FOLDER.test(e.name)) {
      for (const s of await fs.readdir(path.join(dir, e.name), { withFileTypes: true }).catch(() => [])) {
        if (s.isFile() && SUBTITLE.test(s.name) && (onlyVideo || s.name.toLowerCase().startsWith(`${stem}.`))) out.push(path.join(dir, e.name, s.name));
        // Subs/<video name>/2_English.srt
        if (s.isDirectory() && s.name.toLowerCase() === stem) {
          for (const x of await fs.readdir(path.join(dir, e.name, s.name), { withFileTypes: true }).catch(() => [])) {
            if (x.isFile() && SUBTITLE.test(x.name)) out.push(path.join(dir, e.name, s.name, x.name));
          }
        }
      }
    }
  }
  return out.sort();
}

/**
 * The subtitles in a download's file list (names relative to the download)
 * that belong to one of its videos. Same rules as on disk.
 */
export function subtitlesInList(video: string, all: { name: string }[], videoCount: number): string[] {
  const dir = path.posix.dirname(video);
  const stem = path.posix.basename(video, path.posix.extname(video)).toLowerCase();
  return all
    .map((f) => f.name)
    .filter((n) => SUBTITLE.test(n))
    .filter((n) => {
      const d = path.posix.dirname(n);
      // A season's Subs folder often has one folder per episode: Subs/Show.S01E01/2_English.srt.
      if (path.posix.basename(d).toLowerCase() === stem && SUBS_FOLDER.test(path.posix.basename(path.posix.dirname(d))) && path.posix.dirname(path.posix.dirname(d)) === dir) return true;
      const inPlace = d === dir || (path.posix.dirname(d) === dir && SUBS_FOLDER.test(path.posix.basename(d)));
      if (!inPlace) return false;
      return videoCount === 1 || path.posix.basename(n).toLowerCase().startsWith(`${stem}.`);
    })
    .sort();
}
