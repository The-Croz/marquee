/**
 * Reads a release name ("Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX")
 * into what it says about the copy: title, year, episodes, quality, HDR, audio,
 * edition, group and so on. Pure: no disk or network, so it's easy to test.
 *
 * Works on scene names (dots), "spaced" names some sites send ("DDP5 1 H 264"),
 * YTS names ("(2024) [1080p] [WEBRip]") and the bracket-heavy styles of other groups.
 */

export type Resolution = 2160 | 1440 | 1080 | 720 | 576 | 480;

/** Where the copy came from, best first. Matches the sources Radarr and TRaSH use. */
export type Source = 'remux' | 'bluray' | 'webdl' | 'webrip' | 'hdtv' | 'dvd' | 'dvdr' | 'brdisk' | 'rawhd' | 'telecine' | 'telesync' | 'cam' | 'workprint' | 'screener' | 'regional';

export type Codec = 'h265' | 'h264' | 'av1' | 'vp9' | 'vc1' | 'mpeg2' | 'xvid';
export type HdrFlag = 'DV' | 'HDR10+' | 'HDR10' | 'HDR' | 'HLG' | 'SDR';
export type AudioCodec = 'TrueHD' | 'DTS-X' | 'DTS-HD MA' | 'DTS-HD HRA' | 'DTS-ES' | 'DTS' | 'DD+' | 'DD' | 'AAC' | 'FLAC' | 'PCM' | 'Opus' | 'MP3';

export interface ParsedRelease {
  /** The name as given. */
  raw: string;
  /** The title, cleaned: "Dune Part Two". */
  title: string;
  year: number | null;

  /** TV: the season this covers, or null for a movie. */
  season: number | null;
  /** TV: every season covered, for packs like "S01-S03". */
  seasons: number[];
  /** TV: episode numbers; empty for a full-season pack. */
  episodes: number[];
  /** TV: a whole season (or more) in one copy. */
  fullSeason: boolean;

  resolution: Resolution | null;
  source: Source | null;
  /** Radarr's quality name, e.g. "Bluray-2160p", "WEBDL-1080p", "Remux-2160p", "Unknown". TRaSH profiles are written in these. */
  quality: string;
  codec: Codec | null;
  tenBit: boolean;
  hdr: HdrFlag[];
  audio: AudioCodec | null;
  atmos: boolean;
  /** "7.1", "5.1", "2.0"… */
  channels: string | null;

  /** "Director's Cut", "Extended", "IMAX"… */
  editions: string[];
  /** Streaming service tag: AMZN, NF, ATVP, DSNP, HMAX, MAX, HULU, PCOK, PMTP… */
  service: string | null;
  group: string | null;

  repack: number;
  proper: boolean;
  /** "v2" style revisions. */
  version: number;
  is3d: boolean;
  upscaled: boolean;
  hybrid: boolean;
  internal: boolean;
  /** Language tags found in the name, e.g. ["Italian", "English"]; ["Multi"] for MULTi/DUAL. Empty usually means English. */
  languages: string[];
  /** Hardcoded or burned-in subtitles. */
  hardsubs: boolean;
  /** A collection or box set rather than one title. */
  collection: boolean;
  sample: boolean;
}

// ---------------------------------------------------------------- helpers

/**
 * Turns separators into single spaces so "H.264", "H 264" and "H_264" all read
 * the same. Keeps "-" (groups, WEB-DL) and "+" (DD+, HDR10+).
 */
function spaced(name: string): string {
  return ` ${name
    .replace(/\.(mkv|mp4|avi|m4v|ts|wmv|iso)$/i, '')
    .replace(/[._[\](){}|,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()} `;
}

/** Word-ish boundary that treats - . _ space brackets as separators. */
const B = '(?<=^|[\\s\\-_.\\[\\](){}+/])';
const E = '(?=$|[\\s\\-_.\\[\\](){}+/,])';
const word = (body: string, flags = 'i') => new RegExp(`${B}(?:${body})${E}`, flags);

const YEAR = '(?:19[2-9]\\d|20[0-4]\\d)';

const has = (s: string, re: RegExp) => re.test(s);

// ---------------------------------------------------------------- quality

function resolution(s: string): Resolution | null {
  // A number in the name wins over "4K"/"UHD": "1080p UHD BluRay" is a 1080p copy of the 4K disc.
  if (has(s, word('2160[pi]?|3840x2160'))) return 2160;
  if (has(s, word('1440p'))) return 1440;
  if (has(s, word('1080[pi]?|1920x1080'))) return 1080;
  if (has(s, word('720[pi]?|1280x720'))) return 720;
  if (has(s, word('576[pi]?'))) return 576;
  if (has(s, word('480[pi]?|640x480|848x480'))) return 480;
  if (has(s, word('4k|uhd'))) return 2160;
  if (has(s, word('fhd'))) return 1080;
  return null;
}

function source(s: string): Source | null {
  // Not the movie itself, or not the final copy: these win over anything else in the name.
  if (has(s, word('workprint'))) return 'workprint';
  if (has(s, word('(?:hd|hq)?-?cam(?:rip|scr)?|new[ -]?cam'))) return 'cam';
  if (has(s, word('telesync|(?:hd)?-?ts(?:rip)?|pdvd|hd ts|ts-?scr'))) return 'telesync';
  if (has(s, word('telecine|(?:hd)?-?tc'))) return 'telecine';
  if (has(s, word('(?:dvd|bd|web)?[ -]?scr(?:eener)?|screener'))) return 'screener';
  if (has(s, word('r5|r6'))) return 'regional';

  const bluray = has(s, word('blu-?ray|blu ray|bluray|bd(?:rip)?|br-?rip|bdrip|bluray-?rip|uhd ?bd|bdmv|hd-?dvd(?:rip)?|uhd-?blu-?ray'));
  const remux = has(s, word('(?:bd|uhd)?-?remux|bdremux|uhdremux'));

  if (remux) return 'remux';
  if (isDisc(s, bluray)) return 'brdisk';
  if (has(s, word('raw-?hd'))) return 'rawhd';

  // WEB before Blu-ray: "WEB-DL ... BluRay" names don't exist, but "BRRip" from WEB sources do not either.
  if (has(s, word('web-?rip|web rip|webrip|web-?cap'))) return 'webrip';
  if (has(s, word('web-?dl|web dl|webdl|web-?hd|web'))) return 'webdl';
  if (bluray) return 'bluray';
  if (has(s, word('hdtv|pdtv|dsr(?:ip)?|tvrip|sdtv|hdtvrip|dvb(?:rip)?|satrip'))) return 'hdtv';
  // A whole DVD (DVD-R, DVD5, DVD9): Radarr's "DVD-R" quality.
  if (has(s, word('dvd-?r|dvd ?[59]|full[ -]?dvd'))) return 'dvdr';
  if (has(s, word('dvd(?:rip)?|ntsc|pal|vhsrip|dvd ?rip'))) return 'dvd';
  // Streaming service tags with no source almost always mean WEB-DL.
  if (service(s)) return 'webdl';
  return null;
}

/** A full Blu-ray disc image: needs a player or ripping, never what you want in a library. */
function isDisc(s: string, bluray: boolean): boolean {
  if (has(s, word('complete[ -]?(?:uhd[ -]?)?blu-?ray|full[ -]?blu-?ray|br-?disk|bd(?:25|50|66|100)|uhd(?:25|50|66|100)|bdmv|iso'))) return true;
  // "BluRay AVC" / "BluRay HEVC" with no encoder and not a rip means the untouched disc.
  if (!bluray) return false;
  const discVideo = has(s, word('avc|hevc|vc-?1|mpeg-?2|mvc'));
  // Like TRaSH's BR-DISK rule: HDR or Dolby Vision in the name doesn't make it an encode, an encoder does.
  const encoded = has(s, word('[xh]-? ?26[45]|re-?encoded?|bdrip|br-?rip|bluray-?rip|mkv|xvid|web(?:-?dl|rip)?|av1'));
  // TRaSH's exceptions: no disc is 1080p HEVC, and d3g only makes encodes.
  const tellTale = (has(s, word('1080p')) && has(s, word('hevc'))) || has(s, word('d3g'));
  return discVideo && !encoded && !tellTale && !has(s, word('720p|576p|480p'));
}

const SERVICES: [string, RegExp][] = [
  // Case matters: "MAX", "PLAY", "iT" and "MA" are ordinary words in lower case.
  ['AMZN', word('AMZN|Amazon|AMAZON', '')],
  ['NF', word('NF|Netflix|NETFLIX', '')],
  ['ATVP', word('ATVP|ATV\\+?|AppleTV\\+?|Apple ?TV\\+?', '')],
  ['DSNP', word('DSNP|DSNY|Disney\\+?|DisneyPlus', '')],
  ['HMAX', word('HMAX', '')],
  ['MAX', word('MAX', '')],
  ['HULU', word('hulu', 'i')],
  ['PCOK', word('PCOK|Peacock', '')],
  ['PMTP', word('PMTP|Paramount\\+?', '')],
  ['SKST', word('skst', 'i')],
  ['STAN', word('STAN', '')],
  ['CRAV', word('CRAV', '')],
  ['iT', word('iT|iTunes|ITUNES', '')],
  ['PLAY', word('PLAY', '')],
  ['ROKU', word('ROKU', '')],
  ['MA', word('MA', '')], // Movies Anywhere; only counted when it isn't DTS-HD MA (see below)
];

function service(s: string): string | null {
  const noMa = s.replace(/dts[ -]?(?:hd)?[ -]?ma/gi, ' ');
  for (const [name, re] of SERVICES) {
    if (!re.test(noMa)) continue;
    // "MA" and "PLAY" only count next to a WEB source, they're common words otherwise.
    if ((name === 'MA' || name === 'PLAY') && !has(noMa, word('web(?:-?dl|rip)?|web dl'))) continue;
    return name;
  }
  return null;
}

/** Radarr's quality name for a source and resolution. */
export function qualityName(src: Source | null, res: Resolution | null): string {
  const r = res === 1440 ? 1080 : res; // Radarr has no 1440p
  switch (src) {
    case 'remux':
      return r === 2160 ? 'Remux-2160p' : 'Remux-1080p';
    case 'bluray':
      return `Bluray-${r ?? 480}p`; // no resolution stated: Radarr calls it a 480p encode
    case 'webdl':
      return `WEBDL-${r ?? 480}p`;
    case 'webrip':
      return `WEBRip-${r ?? 480}p`;
    case 'hdtv':
      return r && r >= 720 ? `HDTV-${r}p` : 'SDTV';
    case 'dvd':
      return 'DVD';
    case 'dvdr':
      return 'DVD-R';
    case 'brdisk':
      return 'BR-DISK';
    case 'rawhd':
      return 'Raw-HD';
    case 'cam':
      return 'CAM';
    case 'telesync':
      return 'TELESYNC';
    case 'telecine':
      return 'TELECINE';
    case 'workprint':
      return 'WORKPRINT';
    case 'screener':
      return 'DVDSCR';
    case 'regional':
      return 'REGIONAL';
    default:
      // Resolution but no source: Radarr and Sonarr call it HDTV, so we do too (comparison mode depends on it).
      if (r === 2160 || r === 1080 || r === 720) return `HDTV-${r}p`;
      if (r === 576 || r === 480) return 'SDTV';
      return 'Unknown';
  }
}

function codec(s: string): Codec | null {
  if (has(s, word('[xh]-? ?265|hevc|h265'))) return 'h265';
  if (has(s, word('av1'))) return 'av1';
  if (has(s, word('[xh]-? ?264|avc|h264'))) return 'h264';
  if (has(s, word('vp9'))) return 'vp9';
  if (has(s, word('vc-?1'))) return 'vc1';
  if (has(s, word('mpeg-?2'))) return 'mpeg2';
  if (has(s, word('xvid|divx'))) return 'xvid';
  return null;
}

function hdr(s: string): HdrFlag[] {
  const out: HdrFlag[] = [];
  if (has(s, word('dv|dovi|dolby[ -]?vision|dv[ -]?hdr(?:10)?(?:\\+|plus)?|dv p[578]'))) out.push('DV');
  // "HDR10DDP" and "HDR10x265" happen in spaced names: accept HDR10 glued to the next tag.
  if (/(?:^|[\s\-_.[(])hdr10(?:\+|plus|p)(?=$|[\s\-_.\])]|[a-z])/i.test(s)) out.push('HDR10+');
  else if (/(?:^|[\s\-_.[(])(?:dv[ -]?)?hdr10(?![+\d])/i.test(s)) out.push('HDR10');
  else if (has(s, word('hdr|uhd hdr|dv[ -]?hdr'))) out.push('HDR');
  if (has(s, word('hlg'))) out.push('HLG');
  if (has(s, word('sdr'))) out.push('SDR');
  return out;
}

function audio(s: string, raw: string): { audio: AudioCodec | null; atmos: boolean; channels: string | null } {
  const atmos = has(s, word('atmos|ddpa\\d?|ddp ?a|eac3 ?atmos'));
  let a: AudioCodec | null = null;
  if (has(s, word('true-? ?hd'))) a = 'TrueHD';
  else if (has(s, word('dts[ -]?x|dts:x'))) a = 'DTS-X';
  else if (/(?:^|[\s\-_.[(])dts[ -]?(?:hd[ -]?ma|ma|hdma|hd(?![ -]?hra))(?:\d|[\s\-_.\])]|$)/i.test(s)) a = 'DTS-HD MA';
  else if (has(s, word('dts[ -]?hd[ -]?hra|dts[ -]?hra'))) a = 'DTS-HD HRA';
  else if (has(s, word('dts[ -]?es'))) a = 'DTS-ES';
  else if (has(s, word('dts'))) a = 'DTS';
  else if (/(?:^|[\s\-_.[(])(?:dd\+|ddp|e-?ac-?3|ddpa)\d?/i.test(s)) a = 'DD+';
  else if (/(?:^|[\s\-_.[(])(?:dd|ac-?3|dolby[ -]?digital)(?:\d|[\s\-_.\])]|$)/i.test(s)) a = 'DD';
  else if (/(?:^|[\s\-_.[(])aac(?:\d|[\s\-_.\])]|$)/i.test(s)) a = 'AAC';
  else if (has(s, word('flac'))) a = 'FLAC';
  else if (has(s, word('l?pcm'))) a = 'PCM';
  else if (has(s, word('opus'))) a = 'Opus';
  else if (has(s, word('mp3'))) a = 'MP3';

  // "5.1" or, in spaced names, "5 1" right after an audio tag ("DDP5 1", "TrueHD Atmos 7 1").
  let channels: string | null = null;
  const dotted = raw.match(/(?:^|[^\d.v])([1-7])\.([0-2])(?![\d.])/i);
  const spacedCh = s.match(/(?:dd\+?|ddp|ddpa|eac3|ac3|aac|dts(?:[ -]?hd)?(?:[ -]?ma|ma)?|dts-?es|dts-?hra|truehd|atmos|flac|opus|dts-x|pcm|mp3)\s?([1-7])\s([0-2])(?=\s|$|-)/i);
  const sixCh = has(s, word('6ch')) ? ['', '5', '1'] : has(s, word('8ch')) ? ['', '7', '1'] : has(s, word('2ch|stereo')) ? ['', '2', '0'] : null;
  const m = spacedCh ?? dotted ?? sixCh;
  if (m?.[1] && m[2]) channels = `${m[1]}.${m[2]}`;
  return { audio: a, atmos, channels };
}

const EDITIONS: [string, RegExp][] = [
  ["Director's Cut", word("director'?s?[ -]?cut|dc")],
  ['Extended', word('extended(?:[ -](?:cut|edition|version))?')],
  ['Uncut', word('uncut')],
  ['Unrated', word('unrated')],
  ['Theatrical', word('theatrical(?:[ -](?:cut|version))?')],
  ['IMAX', word('imax(?:[ -]enhanced)?')],
  ['Remastered', word('remaster(?:ed)?|4k[ -]remaster')],
  ['Criterion', word('criterion|cc')],
  ['Special Edition', word('special[ -]edition|se')],
  ['Open Matte', word('open[ -]?matte')],
  ['Ultimate', word('ultimate(?:[ -](?:cut|edition))?')],
  ['Final Cut', word('final[ -]cut')],
  ['Anniversary', word('\\d+(?:th)?[ -]anniversary(?:[ -]edition)?|anniversary[ -]edition')],
];

const LANGUAGES: [string, RegExp][] = [
  ['Multi', word('multi\\d*|dual(?:[ -]audio)?|multi[ -]?audio|\\d+xmultiaudio')],
  ['English', word('eng(?:lish)?')],
  ['Italian', word('ita(?:lian)?|italiano')],
  ['French', word('fre(?:nch)?|fra|truefrench|vff|vfq|vf2|vfi|vostfr')],
  ['German', word('ger(?:man)?|deu(?:tsch)?')],
  ['Spanish', word('spa(?:nish)?|esp(?:anol)?|castellano|latino|lat')],
  ['Portuguese', word('por(?:tuguese)?|pt-?br|dublado')],
  ['Russian', word('rus(?:sian)?|rodubbed')],
  ['Hindi', word('hin(?:di)?')],
  ['Tamil', word('tam(?:il)?')],
  ['Telugu', word('tel(?:ugu)?')],
  ['Japanese', word('jpn|jap(?:anese)?')],
  ['Korean', word('kor(?:ean)?')],
  ['Chinese', word('chi(?:nese)?|chs|cht|mandarin|cantonese')],
  ['Turkish', word('tur(?:kish)?')],
  ['Nordic', word('nordic|swedish|swe|danish|dan|norwegian|nor|finnish|fin')],
  ['Polish', word('pol(?:ish)?|pl')],
  ['Czech', word('cze(?:ch)?|cz')],
  ['Dutch', word('dutch|nl')],
];

// ---------------------------------------------------------------- episodes

interface Episodes {
  season: number | null;
  seasons: number[];
  episodes: number[];
  fullSeason: boolean;
  /** Where the episode tag starts in the spaced name, to cut the title there. */
  at: number;
}

function range(a: number, b: number): number[] {
  if (b < a || b - a > 200) return [a];
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}

function episodes(s: string): Episodes | null {
  // S01E02, S01E01-E03, S01E01E02, S01E01-03, s01e01-10
  let m = s.match(/(?<=\s|-)s(\d{1,2})\s?e(\d{1,3})((?:\s?-?\s?e?\d{1,3}(?=\s|$|-|e))*)/i);
  if (m?.[1] && m[2] && m.index !== undefined) {
    const first = Number(m[2]);
    const rest = m[3] ?? '';
    const more = [...rest.matchAll(/e?(\d{1,3})/gi)].map((x) => Number(x[1]));
    let eps = [first, ...more];
    if (more.length === 1 && /-/.test(rest) && more[0]! > first) eps = range(first, more[0]!);
    return { season: Number(m[1]), seasons: [Number(m[1])], episodes: [...new Set(eps)], fullSeason: false, at: m.index };
  }
  // 1x02
  m = s.match(/(?<=\s)(\d{1,2})x(\d{2,3})(?=\s|$|-)/i);
  if (m?.[1] && m[2] && m.index !== undefined) return { season: Number(m[1]), seasons: [Number(m[1])], episodes: [Number(m[2])], fullSeason: false, at: m.index };
  // S01-S03, S01-03, Season 1-3, Seasons 1 to 3
  m = s.match(/(?<=\s)(?:s(\d{1,2})\s?-\s?s?(\d{1,2})|seasons?\s?(\d{1,2})\s?(?:-|to)\s?(\d{1,2}))(?=\s|$)/i);
  if (m && m.index !== undefined) {
    const a = Number(m[1] ?? m[3]);
    const b = Number(m[2] ?? m[4]);
    return { season: a, seasons: range(a, b), episodes: [], fullSeason: true, at: m.index };
  }
  // S01, Season 1, Season 01 Complete
  m = s.match(/(?<=\s)(?:s(\d{1,2})|season\s?(\d{1,2}))(?=\s|$|-)/i);
  if (m && m.index !== undefined) {
    const n = Number(m[1] ?? m[2]);
    return { season: n, seasons: [n], episodes: [], fullSeason: true, at: m.index };
  }
  // "Complete Series"
  m = s.match(/(?<=\s)complete\s(?:series|collection)(?=\s|$)/i);
  if (m && m.index !== undefined && /\bseries\b/i.test(m[0])) return { season: null, seasons: [], episodes: [], fullSeason: true, at: m.index };
  return null;
}

// ---------------------------------------------------------------- title and year

/** The first tag that clearly isn't part of the title. */
const TITLE_END = new RegExp(
  `${B}(?:2160p|1440p|1080[pi]|720p|576p|480p|4k|uhd|web-?dl|web-?rip|web dl|web|webrip|blu-?ray|bluray|bdrip|brrip|bd|remux|hdtv|dvd(?:rip|r)?|hdrip|hdcam|cam(?:rip)?|hd-?ts|telesync|hd-?tc|telecine|x26[45]|h ?26[45]|hevc|xvid|imax|proper|repack|rerip|internal|multi|dual|complete|extended|unrated|remastered|director'?s|theatrical|uncut|criterion|3d|hsbs|sbs|amzn|nf|dsnp|atvp|hmax|hulu|pcok|pmtp|10bits?|hdr|dv|dovi|sdr|ita|eng|french|truefrench|german|hindi|nordic|limited|readnfo|dubbed|subbed|1080|720)${E}`,
  'i',
);

function cleanTitle(raw: string): string {
  return raw
    .replace(/\s+-\s*$/, '')
    .replace(/^\s*-\s+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\s-]+$/, '');
}

function titleAndYear(s: string, ep: Episodes | null): { title: string; year: number | null } {
  // Some sites prefix a translated title: "Дюна Часть вторая / Dune Part Two". Prefer the Latin part.
  let name = s;
  const slash = name.split(/\s\/\s/);
  if (slash.length > 1) name = ` ${slash.find((p) => /[a-z]/i.test(p) && !/[Ѐ-ӿ]/.test(p)) ?? slash.at(-1)} `;

  let head = ep ? name.slice(0, ep.at) : name;
  const end = head.search(TITLE_END);
  if (end > 0) head = head.slice(0, end);

  // The year is the last plausible year in what's left; "Blade Runner 2049 2017" → 2017, "1917 2019" → 2019.
  const years = [...head.matchAll(new RegExp(`(?<=\\s|-)(${YEAR})(?:\\s?-\\s?${YEAR})?(?=\\s|-|$)`, 'g'))];
  // A year straight after the episode tag ("Shogun S01E01 2024") belongs to the show.
  const after = ep ? name.slice(ep.at).match(new RegExp(`^\\S+\\s(${YEAR})(?=\\s)`)) : null;
  const last = years.at(-1);
  if (last?.index !== undefined && last.index > 1) {
    return { title: cleanTitle(head.slice(0, last.index)), year: Number(last[1]) };
  }
  // The year can sit after a tag that ended the title: "The Matrix 3D 1999 Half-SBS", "Up 3D (2009)".
  const rest = (ep ? name.slice(0, ep.at) : name).slice(head.length);
  const late = rest.match(new RegExp(`^\\S*(?:\\s\\S+){0,2}?\\s(${YEAR})(?=\\s|$)`));
  return { title: cleanTitle(head), year: late?.[1] ? Number(late[1]) : after?.[1] ? Number(after[1]) : null };
}

// ---------------------------------------------------------------- group

/** Tags sites add to the end that aren't the group: "[TGx]", "[eztv]", "-YTS"? (YTS *is* a group). */
// Bracketed site tags, or a bare one after a space. "-RARBG" is a group, "[rarbg]" a site tag.
const SITE_TAGS = /(?:\s*\[(?:tgx|eztvx?(?:\s?to)?|rartv|rarbg|ettv|eztv\.re|1337x|ion10|mircrew|prof|xxx)\]|\s+(?:tgx|eztvx?|ettv))+\s*$/i;

function group(name: string): string | null {
  let n = name
    .replace(/\.(mkv|mp4|avi|m4v)$/i, '')
    .replace(/\s*\.{3}$/, '') // truncated names end in "..."
    .replace(/\[[^\]]{0,6}$/, '') // a site tag cut off by the site: "-FLUX[T"
    .replace(/\s*\[[^\]]*\]\s*$/, (m) => (/-/.test(m) ? m : '')) // trailing [site] tag
    .replace(SITE_TAGS, '')
    .trim();
  n = n.replace(/\s+(mkv|mp4)$/i, '');
  // "...x264-GROUP", "...H 264-NTb", "...x264 -YTS", "... - ShortRips"
  const m = n.match(/(?:-\s?|\s-\s)([A-Za-z0-9][A-Za-z0-9@&_]*(?:\s?[A-Za-z0-9@&_]+)?)$/);
  if (!m?.[1]) {
    // Like Radarr: with no "-GROUP", a last "[word]" is taken as the group ("… [1080p] [BluRay]" → BluRay).
    const bracket = name.trim().match(/[\s._-]\[([A-Za-z0-9]+)\]$/);
    return bracket?.[1] ?? null;
  }
  const g = m[1].trim();
  // Things after a dash that aren't groups.
  if (/^(dl|rip|hd|ray|x26[45]|h ?26[45]|hevc|avc|ma|dts|ddp?\d?|aac\d?|\d+|[1-7] [0-2]|sbs|ou|tc|ts|cam|web|bluray|remux|ac3|eac3|2160p|1080p|720p|480p|hdr|dv|sdr|internal|proper|repack)$/i.test(g)) return null;
  return g.split(/\s/)[0]!;
}

// ---------------------------------------------------------------- main

export function parseRelease(name: string): ParsedRelease {
  const s = spaced(name);
  const ep = episodes(s);
  let { title, year } = titleAndYear(s, ep);
  // "[Hindi English] Oppenheimer [2023] …": a leading tag hid the title; read it again without the tag.
  if (!title && /^\s*\[[^\]]*\]\s*\S/.test(name)) {
    const rest = spaced(name.replace(/^\s*\[[^\]]*\]\s*/, ''));
    ({ title, year } = titleAndYear(rest, episodes(rest)));
  }
  const res = resolution(s);
  const src = source(s);
  const aud = audio(s, name);
  const repackM = s.match(word('re-?pack(\\d)?|rerip(\\d)?'));
  const versionM = s.match(/(?<=\s)v([2-5])(?=\s|$)/i);

  return {
    raw: name,
    title,
    year,
    season: ep?.season ?? null,
    seasons: ep?.seasons ?? [],
    episodes: ep?.episodes ?? [],
    fullSeason: ep?.fullSeason ?? false,
    resolution: res,
    source: src,
    // XviD/DivX with nothing else said is an old SD TV rip.
    quality: !src && !res && /(?<=\s)(?:xvid|divx)(?=\s|-|$)/i.test(s) ? 'SDTV' : qualityName(src, res),
    codec: codec(s),
    tenBit: has(s, word('10-?bits?|10 bit|hi10p?|10b')),
    hdr: hdr(s),
    ...aud,
    editions: EDITIONS.filter(([, re]) => re.test(s)).map(([n]) => n),
    service: service(s),
    group: group(name),
    repack: repackM ? Number(repackM[1] ?? repackM[2] ?? 1) : 0,
    proper: has(s, word('proper')),
    version: versionM ? Number(versionM[1]) : 1,
    is3d: has(s, word('3d|bd3d|h-?sbs|half[ -]sbs|full[ -]?sbs|sbs|h-?ou|half[ -]ou|mvc')),
    upscaled: has(s, word('upscaled?|ai[ -]upscaled?|ai[ -]enhanced|regrade|regraded')),
    hybrid: has(s, word('hybrid')),
    internal: has(s, word('internal')),
    languages: [...new Set(LANGUAGES.filter(([, re]) => re.test(s)).map(([n]) => n))],
    hardsubs: has(s, word('hc|hardcoded|korsub|hard[ -]?subs?')),
    collection: has(s, word('collection|trilogy|quadrilogy|duology|saga|box[ -]?set|complete[ -]\\d+[ -]movie')) || /\b(19|20)\d{2}\s?-\s?(19|20)\d{2}\b/.test(s),
    sample: has(s, word('sample')),
  };
}
