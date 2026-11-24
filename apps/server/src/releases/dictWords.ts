import type { Explanation } from './explanations.js';

/**
 * Dictionarry's rules in plain English. Most of its ~260 rules follow a few
 * naming patterns (tiers of trusted groups, streaming services, sound
 * formats), so these are built from the name; the rest are written out.
 * test/dictionarry.test.ts fails if a rule in the pinned copy has no words.
 * Say what the rule means and why, not its points: the profile shows those.
 */

const SERVICES: Record<string, string> = {
  AMZN: 'Amazon Prime Video',
  ATV: 'Apple TV',
  ATVP: 'Apple TV+',
  BCORE: 'Sony Bravia Core',
  CR: 'Crunchyroll',
  CRAV: 'Crave',
  CRIT: 'the Criterion Channel',
  DRPO: 'Dropout',
  DSCP: 'Discovery+',
  DSNP: 'Disney+',
  HBO: 'HBO',
  HMAX: 'HBO Max',
  HTSR: 'Hotstar',
  HULU: 'Hulu',
  IQIYI: 'iQIYI',
  KCW: 'Kocowa',
  MA: 'Movies Anywhere',
  MAX: 'Max',
  MUBI: 'MUBI',
  NF: 'Netflix',
  NOW: 'NOW',
  PCOK: 'Peacock',
  PLAY: 'Google TV',
  PMTP: 'Paramount+',
  ROKU: 'Roku',
  SHO: 'Showtime',
  SKST: 'SkyShowtime',
  STAN: 'Stan',
  TVING: 'TVING',
  VIKI: 'Viki',
  VIU: 'Viu',
  WAVVE: 'Wavve',
  WeTV: 'WeTV',
  YK: 'Youku',
  iP: 'BBC iPlayer',
  iT: 'iTunes',
};

const ENHANCED: Record<string, string> = {
  Amazon: 'Amazon Prime Video',
  'Amazon Channel': 'Amazon Channels',
  'Disney+': 'Disney+',
  'HBO Max': 'HBO Max',
  'Movies Anywhere': 'Movies Anywhere',
  Netflix: 'Netflix',
  iTunes: 'iTunes',
  '2160p iTunes': 'iTunes',
};

const STYLE: Record<string, string> = {
  Balanced: 'reliable streaming downloads with good sound',
  Compact: 'small x265 encodes',
  Efficient: 'space-saving x265 encodes that keep the picture',
  Quality: 'see-no-difference encodes (Dictionarry ranks them by how close they look to the disc)',
  'ProRes Quality': 'encodes made from studio masters',
  HDTV: 'TV recordings',
  'WEB-DL': 'streaming downloads',
  Remux: 'untouched Blu-ray copies',
  'DVD Quality': 'DVD encodes',
  SDTV: 'standard-definition TV recordings',
};

/** The short word for each kind of tier, for labels. */
const NOUN: Record<string, string> = {
  Balanced: 'streaming',
  Compact: 'compact',
  Efficient: 'efficient',
  Quality: 'high-quality',
  'ProRes Quality': 'studio-master',
  HDTV: 'TV recording',
  'WEB-DL': 'streaming download',
  Remux: 'untouched copy',
  'DVD Quality': 'DVD',
  SDTV: 'SD TV',
};

const SOURCE_WORD: Record<string, string> = { Bluray: 'Blu-ray', WEB: 'web', Trash: 'whole-season' };
const rank = (n: number) => (n === 1 ? 'the very best' : n === 2 ? 'very good' : n <= 4 ? 'good' : 'acceptable');
const res = (r: string) => (r === '2160p' ? '4K' : r);

const FIXED: Record<string, Explanation> = {
  // ---- never pick
  '3D': { label: '3D', explain: 'Made for 3D TVs and glasses. Looks wrong on a normal screen.' },
  AV1: { label: 'AV1 video', explain: 'A new video format many TVs and Plex apps can’t play without converting.' },
  'Audio Description': { label: 'With audio description', explain: 'The main sound track narrates what’s on screen, for blind and partially sighted viewers.' },
  'B&W': { label: 'Black-and-white edition', explain: 'A special black-and-white (or recoloured) version, not the normal film.' },
  'Banned Dual Audio Groups': { label: 'Badly made dual-language copy', explain: 'From groups whose two-language copies often play the wrong language first.' },
  'Banned Groups': { label: 'Group Dictionarry bans', explain: 'From a group known for poor copies: over-compressed, wrong colours or mislabeled.' },
  'Banned Groups (Efficient)': { label: 'Group banned for small encodes', explain: 'From a group whose small encodes Dictionarry has found poor.' },
  'Banned Groups (Compact)': { label: 'Group banned for compact encodes', explain: 'From a group whose very small encodes Dictionarry has found poor.' },
  'Banned Groups (Regular)': { label: 'Group banned for full-size copies', explain: 'From a group Dictionarry doesn’t trust for full-size copies.' },
  'Banned Groups (Release Title)': { label: 'Banned group in the name', explain: 'The name shows a group Dictionarry bans, even where the group isn’t in the usual place.' },
  'Banned Language Groups': { label: 'Dubbed by default', explain: 'From groups whose copies play a dubbed language first instead of the original.' },
  'Banned Remux': { label: 'Poor untouched copy', explain: 'From remux groups known for bloated sound tracks or fake HDR.' },
  'Banned UHD Bluray': { label: 'Untrusted 4K Blu-ray encode', explain: 'A 4K Blu-ray encode from a group not in any of Dictionarry’s trusted tiers.' },
  'Banned WEBRip': { label: 'Untrusted web capture', explain: 'A screen-captured web copy from a group not in Dictionarry’s trusted tiers.' },
  'Banned WEBRip (Efficient)': { label: 'Untrusted web capture', explain: 'A screen-captured web copy from a group not in Dictionarry’s trusted tiers for small encodes.' },
  CAM: { label: 'Filmed in a cinema', explain: 'Recorded in a cinema with a camera. Poor picture and sound.' },
  'Dolby Vision (Without Fallback)': { label: 'Dolby Vision only (no HDR10)', explain: 'Dolby Vision with no plain HDR underneath. On screens without Dolby Vision the colours come out purple and green.' },
  Extras: { label: 'Bonus material only', explain: 'Extras, featurettes or trailers rather than the title itself.' },
  'Full Disc': { label: 'Full Blu-ray disc', explain: 'A copy of the whole disc, menus and all. Plex and Jellyfin can’t play it directly.' },
  'Full Disc (Quality Match)': { label: 'Full Blu-ray disc', explain: 'A copy of the whole disc, menus and all, recognised from its quality. Plex and Jellyfin can’t play it directly.' },
  'German DL': { label: 'German and original audio', explain: 'Made for German-language libraries; German usually plays first.' },
  HEVC: { label: 'HEVC below 4K (not Blu-ray)', explain: 'An x265/HEVC web copy below 4K, usually re-squeezed from a bigger copy and losing detail.' },
  'Lossless Audio': { label: 'Lossless sound below 4K', explain: 'Studio-grade sound (TrueHD, DTS-HD MA) on a smaller copy. Adds gigabytes most speakers can’t tell apart.' },
  Remux: { label: 'Untouched Blu-ray copy (remux)', explain: 'The whole Blu-ray’s picture and sound, untouched. Best quality, but very large files.' },
  SDR: { label: 'No HDR at 4K', explain: 'A 4K streaming copy without HDR or Dolby Vision. Usually not worth the space over 1080p.' },
  'Sing Along': { label: 'Sing-along version', explain: 'Has on-screen lyrics. Not the normal film.' },
  Upscale: { label: 'Fake 4K (upscaled)', explain: 'A lower resolution copy stretched up to look like 4K. Bigger files, no better picture.' },
  VP9: { label: 'VP9 video', explain: 'A web video format some TVs need Plex to convert.' },
  VVC: { label: 'VVC / x266 video', explain: 'A very new video format almost nothing plays yet.' },
  Xvid: { label: 'Xvid video', explain: 'An old, low-quality video format from the early 2000s.' },
  'x264 (2160p)': { label: '4K in x264', explain: 'A 4K copy in the older x264 format. Usually a sign of a poor re-encode.' },
  'x265 (Efficient)': { label: 'HEVC below 1080p', explain: 'An x265/HEVC copy below 1080p. Dictionarry finds these squeezed too far.' },
  'Not Original or English': { label: 'Neither original nor English', explain: 'Has neither the language the title was made in nor English.' },
  'Not Original': { label: 'Not in its original language', explain: 'Doesn’t have the language the title was made in (dubbed only).' },
  'Not Only Original': { label: 'Other languages added', explain: 'Has languages besides the original one, or doesn’t have the original.' },
  DUBBED: { label: 'Dubbed', explain: 'Marked as dubbed into another language.' },
  'Dual Audio': { label: 'Two languages', explain: 'Has two audio languages.' },
  Nordic: { label: 'Nordic languages', explain: 'Made for Nordic libraries, with Nordic audio or subtitles.' },
  'Release Group (Missing)': { label: 'No group named', explain: 'Nobody signed this copy, so there’s no track record to trust.' },

  // ---- kind of copy
  '1080p Bluray': { label: '1080p Blu-ray encode', explain: 'A 1080p encode from a Blu-ray (not an untouched copy).' },
  '1080p Bluray (Efficient)': { label: '1080p Blu-ray in x264', explain: 'A 1080p Blu-ray encode in the older x264 format: a fallback when no space-saving x265 encode is around.' },
  '1080p HDTV': { label: '1080p TV recording', explain: 'Recorded from a 1080p TV broadcast, often with logos or ads.' },
  '1080p Remux': { label: '1080p untouched Blu-ray', explain: 'The 1080p Blu-ray’s picture and sound, untouched. Very large.' },
  '1080p WEB-DL': { label: '1080p streaming download', explain: 'Downloaded at 1080p straight from a streaming service.' },
  '1080p WEB-DL (Efficient)': { label: '1080p streaming download (x264)', explain: 'A 1080p download from a streaming service in x264: a fallback when no space-saving encode is around.' },
  '1080p WEB-DL HEVC (HDR)': { label: '1080p HDR streaming download in x265', explain: 'A 1080p HDR download from a streaming service, already small and efficient.' },
  '1080p WEB-DL HEVC (SDR)': { label: '1080p streaming download in x265', explain: 'A 1080p download from a streaming service that streams in x265, already small and efficient.' },
  '1080p WEBRip': { label: '1080p web capture', explain: 'Captured from a 1080p stream rather than downloaded. A little worse than a download.' },
  '2160p Remux': { label: '4K untouched Blu-ray', explain: 'The 4K Blu-ray’s picture and sound, untouched. Huge files.' },
  '2160p WEB-DL': { label: '4K streaming download', explain: 'Downloaded in 4K straight from a streaming service.' },
  '2160p WEB-DL (Efficient)': { label: '4K streaming download', explain: 'Downloaded in 4K straight from a streaming service: clean, reliable and a sensible size.' },
  '480p Bluray': { label: '480p Blu-ray encode', explain: 'A standard-definition encode from a Blu-ray.' },
  '480p WEB-DL': { label: '480p streaming download', explain: 'Standard definition, straight from a streaming service.' },
  '576p Bluray': { label: '576p Blu-ray encode', explain: 'A PAL standard-definition encode from a Blu-ray.' },
  '576p WEB-DL': { label: '576p streaming download', explain: 'PAL standard definition, straight from a streaming service.' },
  '720p Bluray': { label: '720p Blu-ray encode', explain: 'A 720p encode from a Blu-ray.' },
  '720p HDTV': { label: '720p TV recording', explain: 'Recorded from a 720p TV broadcast.' },
  '720p WEB-DL': { label: '720p streaming download', explain: 'Downloaded at 720p straight from a streaming service.' },
  '720p WEBRip': { label: '720p web capture', explain: 'Captured from a 720p stream rather than downloaded.' },
  DVD: { label: 'DVD encode', explain: 'An encode from a DVD.' },
  'DVD Remux': { label: 'Untouched DVD', explain: 'The DVD’s picture and sound, untouched.' },
  SDTV: { label: 'Standard-definition TV recording', explain: 'Recorded from a standard-definition broadcast.' },
  'UHD Bluray': { label: '4K Blu-ray encode', explain: 'A 4K encode from an Ultra HD Blu-ray.' },
  'UHD Bluray (Efficient)': { label: '4K Blu-ray encode', explain: 'A 4K encode from an Ultra HD Blu-ray, for profiles that prefer small files.' },
  IMF: { label: 'From a studio master', explain: 'Encoded from the studio’s own master files (ProRes/IMF), better than a Blu-ray.' },
  'Season Pack': { label: 'Whole season', explain: 'A full season in one download.' },

  // ---- trusted groups by name
  'HONE Bluray': { label: 'HONE 1080p Blu-ray encode', explain: 'A 1080p x265 Blu-ray encode re-shared by HONE, a group Dictionarry trusts for small, faithful copies.' },
  'HONE Blurays': { label: 'HONE 4K Blu-ray encode', explain: 'A 4K x265 Blu-ray encode re-shared by HONE, a group Dictionarry trusts for small, faithful copies.' },
  'HONE WEB': { label: 'HONE 1080p web encode', explain: 'A 1080p x265 web encode from HONE, a group Dictionarry trusts.' },
  'QxR Bluray': { label: 'QxR 1080p Blu-ray encode', explain: 'A 1080p x265 Blu-ray encode from the QxR family of encoders, known for small copies that keep the picture.' },
  'QxR Blurays': { label: 'QxR 4K Blu-ray encode', explain: 'A 4K x265 Blu-ray encode from the QxR family of encoders, known for small copies that keep the picture.' },
  'QxR WEB': { label: 'QxR web encode', explain: 'A web encode from the QxR family of encoders.' },
  'TAoE Bluray': { label: 'TAoE 1080p Blu-ray encode', explain: 'A 1080p x265 Blu-ray encode from the TAoE family, known for efficient copies with good sound.' },
  'TAoE Blurays': { label: 'TAoE 4K Blu-ray encode', explain: 'A 4K x265 Blu-ray encode from the TAoE family, known for efficient copies with good sound.' },
  'TAoE WEB': { label: 'TAoE web encode', explain: 'A web encode from the TAoE family.' },
  'Vialle Bluray': { label: 'Vialle 1080p Blu-ray encode', explain: 'A 1080p x265 Blu-ray encode from Vialle, a trusted encoder of small copies.' },
  'Vialle WEB': { label: 'Vialle web encode', explain: 'A web encode from Vialle, a trusted encoder of small copies.' },
  'Weasley WEB': { label: 'Weasley web encode', explain: 'A 1080p web encode from Weasley (with HONE), a trusted encoder of small copies.' },
  '1080p Bluray HEVC Tier 1': { label: '1080p x265 Blu-ray, top group', explain: 'A 1080p x265 Blu-ray encode from a group Dictionarry ranks the very best for small, faithful copies.' },

  // ---- picture
  'Dolby Vision': { label: 'Dolby Vision', explain: 'The most advanced HDR. Looks best on TVs that support it, with HDR10 for those that don’t.' },
  HDR: { label: 'HDR', explain: 'Brighter highlights and richer colour on HDR TVs.' },
  'HDR (Missing)': { label: 'HDR (not in the name)', explain: 'An x265 1080p encode from a group that leaves HDR out of the name.' },
  'HDR10 (Missing)': { label: 'HDR10 (not in the name)', explain: 'From a group that leaves HDR10 out of the name.' },
  'HDR10+': { label: 'HDR10+', explain: 'HDR that adjusts scene by scene, on TVs that support it.' },
  IMAX: { label: 'IMAX version', explain: 'The IMAX cut, with more picture at the top and bottom in some scenes.' },
  'IMAX Enhanced': { label: 'IMAX Enhanced', explain: 'The higher-quality IMAX version from a streaming service.' },
  x265: { label: 'x265 below 4K', explain: 'An x265/HEVC copy below 4K.' },
  'x265 (Bluray)': { label: 'x265 Blu-ray below 4K', explain: 'An x265/HEVC Blu-ray encode below 4K.' },
  'x265 (Missing)': { label: 'x265 (not in the name)', explain: 'A 4K encode that’s almost certainly x265 but doesn’t say so.' },
  'x265 (Remux)': { label: 'x265 untouched copy', explain: 'An untouched copy re-made in x265 below 4K, which isn’t really untouched.' },

  // ---- sound
  AAC: { label: 'AAC sound', explain: 'Compact sound, fine for most speakers.' },
  Atmos: { label: 'Dolby Atmos', explain: 'Sound with height for Atmos speakers and soundbars.' },
  'Dolby Atmos': { label: 'Dolby Atmos', explain: 'Sound with height for Atmos speakers and soundbars.' },
  'Atmos (Missing)': { label: 'Dolby Atmos (not in the name)', explain: 'TrueHD 7.1 from groups that leave Atmos out of the name.' },
  DTS: { label: 'DTS sound', explain: 'Cinema surround sound, older and larger than Dolby Digital Plus.' },
  'DTS-ES': { label: 'DTS-ES sound', explain: 'An older 6.1 surround format.' },
  'DTS-HD HRA': { label: 'DTS-HD High Resolution', explain: 'High-quality, nearly lossless surround sound.' },
  'DTS-HD MA': { label: 'DTS-HD Master Audio', explain: 'Studio-grade lossless surround sound. Large.' },
  'DTS-X': { label: 'DTS:X', explain: 'Lossless surround with height, DTS’s answer to Atmos.' },
  'Dolby Digital': { label: 'Dolby Digital sound', explain: 'Standard 5.1 surround sound.' },
  'Dolby Digital +': { label: 'Dolby Digital Plus sound', explain: 'The surround sound streaming services use. Good and compact.' },
  FLAC: { label: 'FLAC sound', explain: 'Lossless sound in a compact format.' },
  Opus: { label: 'Opus sound', explain: 'Very efficient modern sound, used by small encodes.' },
  PCM: { label: 'Uncompressed sound (PCM)', explain: 'Raw, uncompressed sound. Very large.' },
  TrueHD: { label: 'Dolby TrueHD', explain: 'Studio-grade lossless surround sound. Large.' },
  'TrueHD (Missing)': { label: 'Dolby TrueHD (not in the name)', explain: 'From groups that leave TrueHD out of the name.' },

  // ---- editions and fixes
  'Extended Edition': { label: 'Extended edition', explain: 'A longer cut with scenes added back.' },
  'Special Edition': { label: 'Special edition', explain: 'A re-released cut, such as a director’s cut or remaster.' },
  Theatrical: { label: 'Cinema version', explain: 'The version that was shown in cinemas.' },
  Repack1: { label: 'Fixed copy', explain: 'The group re-released it to fix a problem.' },
  Repack2: { label: 'Fixed copy (second fix)', explain: 'The group fixed it a second time.' },
  Repack3: { label: 'Fixed copy (third fix)', explain: 'The group fixed it a third time.' },

  // ---- site flags
  'Freeleech 100%': { label: 'Free to download', explain: 'The site doesn’t count this download against your ratio.' },
  'Freeleech 75%': { label: '75% off on the site', explain: 'The site counts only a quarter of this download against your ratio. Marquee can’t see this flag, so it never matches.' },
  'Freeleech 50%': { label: 'Half off on the site', explain: 'The site counts half of this download against your ratio. Marquee can’t see this flag, so it never matches.' },
  'Freeleech 25%': { label: '25% off on the site', explain: 'The site counts three quarters of this download. Marquee can’t see this flag, so it never matches.' },
  'Golden Popcorn': { label: 'Golden Popcorn', explain: 'Marked best-in-class on PassThePopcorn. Marquee can’t see this flag, so it never matches.' },
};

export function dictExplain(name: string): Explanation | null {
  const fixed = FIXED[name];
  if (fixed) return fixed;
  const service = SERVICES[name];
  if (service) return { label: `From ${service}`, explain: `Downloaded straight from ${service}. Some services have better picture and sound than others.` };
  const enh = name.match(/^(.+) Enhancement$/);
  if (enh && ENHANCED[enh[1]!]) {
    const s = ENHANCED[enh[1]!]!;
    return { label: `${s} below 4K`, explain: `Adjusts the points for ${s} copies at 1080p and below, where Dictionarry finds its quality better or worse than the service’s 4K.` };
  }
  // "1080p Efficient Movie Bluray Tier 1", "720p Quality Tier 3", "WEB-DL Tier 2", "1080p Quality Tier 1 (Efficient)".
  const tier = name.match(/^(?:(\d{3,4}p) )?(Balanced|Compact|Efficient|ProRes Quality|Quality|HDTV|WEB-DL|Remux|DVD Quality|SDTV)(?: (Movie|TV))?(?: (Bluray|WEB|Trash))? Tier (\d)(?: \((Efficient)\))?$/);
  if (tier) {
    const [, r, style, what, src, n] = tier;
    const num = Number(n);
    const words = [r ? res(r) : null, NOUN[style!], src ? SOURCE_WORD[src] : null].filter(Boolean).join(' ');
    const kind = what === 'Movie' ? 'movies: ' : what === 'TV' ? 'TV: ' : '';
    return {
      label: `${words.charAt(0).toUpperCase()}${words.slice(1)} group, tier ${num}`,
      explain: `Made by a group Dictionarry ranks ${rank(num)} for ${kind}${r ? `${res(r)} ` : ''}${STYLE[style!] ?? 'copies'}${src === 'Trash' ? ' (whole seasons from less-trusted groups)' : ''}.`,
    };
  }
  return null;
}

/** Which heading a Dictionarry rule sits under on the Quality page, from Dictionarry's own tags. */
export function dictGroup(tags: string[]): string | null {
  const has = (...t: string[]) => t.some((x) => tags.includes(x));
  if (has('Banned')) return 'Never pick';
  if (has('Release Group Tier', 'Release Group')) return 'Trusted groups';
  if (has('Streaming Service', 'Enhancement')) return 'Streaming services';
  if (has('Audio', 'Lossless', 'Dolby')) return 'Sound';
  if (has('HDR', 'Colour Grade')) return 'HDR and colour';
  if (has('Codec', 'HEVC', 'x265', 'x264')) return 'Video formats';
  if (has('Edition')) return 'Editions';
  if (has('Repack')) return 'Fixed copies';
  if (has('Language', 'Dual Audio')) return 'Language';
  if (has('Freeleech', 'Flag', 'Indexer Flag')) return 'Site flags';
  if (has('Source', '1080p', '2160p', '720p', '576p', '480p', 'SD', 'DVD', 'WEB-DL', 'UHD Bluray', 'Remux')) return 'Kind of copy';
  return null;
}
