/**
 * Every TRaSH rule Marquee uses, in plain English. Keyed by TRaSH's rule name
 * (the same for movies and TV). `label` is what screens show; the TRaSH name is
 * shown beside it in small type so people can look it up in the guides.
 *
 * Say what the rule means and why it matters, not whether it's on or how many
 * points it has: that depends on the profile and screens add it.
 *
 * test/formats.test.ts fails if a vendored rule has no entry here, so a TRaSH
 * update that adds a rule also needs a sentence.
 */

export interface Explanation {
  /** Short name for screens. */
  label: string;
  /** One or two plain sentences: what it means and why it gets the points it does. */
  explain: string;
}

const streaming = (service: string): Explanation => ({
  label: `From ${service}`,
  explain: `Downloaded straight from ${service}. Untouched streaming copies are clean and reliable, and some services have better picture than others.`,
});

const tier = (kind: string, n: 1 | 2 | 3): Explanation => ({
  label: `${kind} group, tier ${n}`,
  explain: `Made by a group TRaSH ranks ${n === 1 ? 'among the very best' : n === 2 ? 'very good' : 'good'} for ${kind} copies, based on their track record for picture and sound.`,
});

export const EXPLANATIONS: Record<string, Explanation> = {
  // ---- never pick
  'BR-DISK': { label: 'Full Blu-ray disc', explain: 'A copy of the whole disc, menus and all. Needs a disc player or ripping before Plex and Jellyfin can play it.' },
  'BR-DISK (BTN)': { label: 'Full Blu-ray disc', explain: 'A copy of the whole disc, menus and all, as one site labels it. Plex and Jellyfin can’t play it directly.' },
  LQ: { label: 'Low-quality group', explain: 'From a group known for poor copies: over-compressed, wrong colors or mislabeled.' },
  'LQ (Release Title)': { label: 'Low-quality copy', explain: 'The name gives it away as a poor copy (a known low-quality uploader or method).' },
  Upscaled: { label: 'Fake 4K (upscaled)', explain: 'A lower resolution copy stretched up to look like 4K. Bigger files, no better picture.' },
  '3D': { label: '3D', explain: 'Made for 3D TVs and glasses. Looks wrong on a normal screen.' },
  Extras: { label: 'Bonus material only', explain: 'Extras, featurettes or trailers rather than the movie itself.' },
  'Bad Dual Groups': { label: 'Badly made dual-language copy', explain: 'From groups whose dual-language copies often put the wrong language first or drop the original audio.' },
  'Black and White Editions': { label: 'Black-and-white edition', explain: 'A special black-and-white version (like "Logan Noir"), not the normal color film.' },
  'Generated Dynamic HDR': { label: 'Made-up HDR', explain: 'HDR added by software after the fact, not from the studio. Often looks worse than the original.' },
  'Line/Mic Dubbed': { label: 'Cinema-recorded sound', explain: 'Sound recorded with a microphone in a cinema or from a line feed. Poor audio.' },
  'Sing-Along Versions': { label: 'Sing-along version', explain: 'Has on-screen lyrics burned in. Not the normal film.' },
  'No-RlsGroup': { label: 'No group named', explain: 'Nobody signed this copy, so there’s no track record to trust. TRaSH suggests it only if bad copies keep slipping through.' },
  Obfuscated: { label: 'Scrambled name', explain: 'The name has been scrambled or hidden, which makes the copy hard to check.' },
  Retags: { label: 'Renamed copy', explain: 'Someone else’s copy renamed and re-shared, often with changes.' },
  Scene: { label: 'Scene copy', explain: 'From the "scene", groups that race to be first. Usually fine but often not the best encode.' },
  'x265 (HD)': {
    label: 'HEVC at 1080p or lower',
    explain: 'An x265/HEVC copy below 4K. These are usually re-encodes squeezed small, losing detail. TRaSH’s "golden rule": avoid HEVC below 4K.',
  },
  'x265 (no HDR/DV)': {
    label: 'HEVC without HDR',
    explain: 'An x265/HEVC copy with no HDR or Dolby Vision. At 4K the point of HEVC is HDR; without it this is usually a re-encode. TRaSH’s "golden rule".',
  },
  'DV (w/o HDR fallback)': {
    label: 'Dolby Vision only (no HDR10)',
    explain: 'Dolby Vision with no plain HDR10 underneath. On TVs or players without Dolby Vision it shows purple and green colors. Avoid unless every screen you use has Dolby Vision.',
  },
  'SDR (no WEBDL)': { label: 'No HDR at 4K', explain: 'A 4K copy without HDR (unless it’s a streaming download). Usually a poor 4K.' },
  SDR: { label: 'No HDR at 4K', explain: 'A 4K copy without HDR. Most of 4K’s benefit is HDR, so this is usually not worth the size.' },
  AV1: { label: 'AV1 video', explain: 'A newer video format many TVs and streaming boxes can’t play yet, so Plex would have to convert it.' },

  // ---- preferred groups
  'UHD Bluray Tier 01': tier('4K Blu-ray', 1),
  'UHD Bluray Tier 02': tier('4K Blu-ray', 2),
  'UHD Bluray Tier 03': tier('4K Blu-ray', 3),
  'HD Bluray Tier 01': tier('1080p Blu-ray', 1),
  'HD Bluray Tier 02': tier('1080p Blu-ray', 2),
  'HD Bluray Tier 03': tier('1080p Blu-ray', 3),
  'Remux Tier 01': tier('remux', 1),
  'Remux Tier 02': tier('remux', 2),
  'Remux Tier 03': tier('remux', 3),
  'WEB Tier 01': tier('streaming', 1),
  'WEB Tier 02': tier('streaming', 2),
  'WEB Tier 03': tier('streaming', 3),
  'WEB Scene': { label: 'Trusted scene streaming copy', explain: 'A streaming download from a scene group TRaSH trusts for TV.' },

  // ---- fixes
  'Repack/Proper': { label: 'Fixed copy', explain: 'A corrected copy from the same group, replacing one that had a problem. Small bonus so the fix wins.' },
  Repack2: { label: 'Fixed copy (2nd fix)', explain: 'The second correction of a copy. Wins over the first fix.' },
  Repack3: { label: 'Fixed copy (3rd fix)', explain: 'The third correction of a copy. Wins over earlier fixes.' },

  // ---- HDR
  HDR: { label: 'HDR', explain: 'High dynamic range: brighter highlights and richer color on an HDR TV. Covers HDR10, HDR10+ and Dolby Vision with an HDR layer.' },
  'DV Boost': { label: 'Dolby Vision bonus', explain: 'Extra points for Dolby Vision, for when your TVs support it.' },
  'HDR10+ Boost': { label: 'HDR10+ bonus', explain: 'Extra points for HDR10+, for Samsung TVs and others that support it.' },
  'DV (Disk)': { label: 'Dolby Vision from a disc', explain: 'Dolby Vision kept from a Blu-ray in a way many players can’t read.' },

  // ---- audio
  'TrueHD ATMOS': { label: 'Dolby TrueHD with Atmos', explain: 'The best surround sound: lossless, with height channels for Atmos speakers or soundbars.' },
  'DTS X': { label: 'DTS:X', explain: 'Lossless DTS with height channels, the DTS answer to Atmos.' },
  'ATMOS (undefined)': { label: 'Atmos (format not stated)', explain: 'The name says Atmos but not which kind. Likely good surround sound.' },
  'DD+ ATMOS': { label: 'Dolby Digital Plus with Atmos', explain: 'Streaming-style Atmos: compressed but with height channels. What most streaming services send.' },
  TrueHD: { label: 'Dolby TrueHD', explain: 'Lossless Dolby surround sound, as on the Blu-ray.' },
  'DTS-HD MA': { label: 'DTS-HD Master Audio', explain: 'Lossless DTS surround sound, as on the Blu-ray.' },
  FLAC: { label: 'FLAC', explain: 'Lossless sound, often used for older films’ original mono or stereo.' },
  PCM: { label: 'PCM', explain: 'Uncompressed sound. Lossless but large.' },
  'DTS-HD HRA': { label: 'DTS-HD High Resolution', explain: 'High-quality but not lossless DTS sound.' },
  'DD+': { label: 'Dolby Digital Plus', explain: 'Good compressed surround sound, what streaming services usually send.' },
  'DTS-ES': { label: 'DTS-ES', explain: 'An older DTS surround format with an extra rear channel.' },
  DTS: { label: 'DTS', explain: 'Standard compressed DTS surround sound.' },
  AAC: { label: 'AAC', explain: 'Compressed sound, usually stereo. Fine for TV speakers.' },
  DD: { label: 'Dolby Digital', explain: 'Standard compressed Dolby surround sound, as on DVDs.' },
  MP3: { label: 'MP3 audio', explain: 'Old compressed sound. Works, but usually means an older, lower-quality copy.' },
  Opus: { label: 'Opus audio', explain: 'Efficient modern sound format. Some players need Plex to convert it.' },

  // ---- editions and versions
  '4K Remaster': { label: '4K remaster', explain: 'Rescanned from the film in 4K. Usually the best-looking version.' },
  'Criterion Collection': { label: 'Criterion', explain: 'Criterion Collection release, known for careful restorations.' },
  'Masters of Cinema': { label: 'Masters of Cinema', explain: 'A carefully restored release from the Masters of Cinema label.' },
  'Vinegar Syndrome': { label: 'Vinegar Syndrome', explain: 'A carefully restored release from the Vinegar Syndrome label.' },
  Hybrid: { label: 'Hybrid', explain: 'Combines the best parts of several sources (for example a disc’s picture with a stream’s HDR). Usually better than either.' },
  IMAX: { label: 'IMAX', explain: 'The IMAX version: taller picture in some scenes.' },
  'IMAX Enhanced': { label: 'IMAX Enhanced', explain: 'The IMAX Enhanced version from streaming: expanded picture in some scenes.' },
  'Open Matte': { label: 'Open matte', explain: 'Shows more of the picture at the top and bottom than the cinema version.' },
  Remaster: { label: 'Remastered', explain: 'A newer, cleaned-up version of the film.' },
  'Special Edition': { label: 'Special edition', explain: 'A special, extended or director’s version of the film.' },
  'Theatrical Cut': { label: 'Theatrical cut', explain: 'The version shown in cinemas, not an extended cut.' },

  // ---- streaming services
  AMZN: streaming('Amazon Prime Video'),
  ATV: streaming('Apple TV'),
  ATVP: streaming('Apple TV+'),
  AUBC: streaming('ABC Australia'),
  BCORE: streaming('Bravia Core'),
  CBC: streaming('CBC Gem'),
  CNLP: streaming('Canal+'),
  CRAV: streaming('Crave'),
  CRiT: streaming('Criterion Channel'),
  DSNP: streaming('Disney+'),
  FAH: streaming('Fandango at Home'),
  HBO: streaming('HBO'),
  HMAX: streaming('HBO Max'),
  Hulu: streaming('Hulu'),
  HULU: streaming('Hulu'),
  IMF: { label: 'Studio master (IMF)', explain: 'Made from the studio’s own master files rather than a stream or disc. Excellent picture.' },
  IP: streaming('BBC iPlayer'),
  iT: streaming('iTunes'),
  ITVX: streaming('ITVX'),
  MA: streaming('Movies Anywhere'),
  MAX: streaming('Max'),
  MY5: streaming('My5'),
  NF: streaming('Netflix'),
  NOW: streaming('NOW'),
  OViD: streaming('OVID'),
  PCOK: streaming('Peacock'),
  PLAY: streaming('Google Play'),
  PMTP: streaming('Paramount+'),
  ROKU: streaming('Roku'),
  STAN: streaming('Stan'),
  STRP: streaming('Star+'),
  '4OD': streaming('Channel 4'),
  ALL4: streaming('Channel 4'),
  BW: { label: 'Black-and-white version', explain: 'Some shows come in a black-and-white version as well as color. Usually refused, so you get color.' },
  CC: streaming('Comedy Central'),
  DCU: streaming('DC Universe'),
  DSCP: streaming('Discovery+'),
  QIBI: streaming('Quibi'),
  RED: streaming('YouTube Red'),
  SHO: streaming('Showtime'),
  SYFY: streaming('SYFY'),
  'HD Streaming Boost': { label: 'Best streaming services in HD', explain: 'Extra points for services with the best 1080p picture, so they win ties.' },
  'UHD Streaming Boost': { label: 'Best streaming services in 4K', explain: 'Extra points for services with the best 4K picture, so they win ties.' },

  // ---- video formats
  x264: { label: 'x264 / AVC video', explain: 'The most widely playable video format.' },
  x265: { label: 'x265 / HEVC video', explain: 'Smaller files for the same picture; the usual format for 4K HDR.' },
  x266: { label: 'x266 / VVC video', explain: 'A very new video format almost nothing plays yet.' },
  'VC-1': { label: 'VC-1 video', explain: 'An older video format from early Blu-rays.' },
  MPEG2: { label: 'MPEG-2 video', explain: 'An old video format from DVDs and early Blu-rays. Large files.' },
  VP9: { label: 'VP9 video', explain: 'A web video format. Some TVs need Plex to convert it.' },
  HFR: { label: 'High frame rate', explain: '48 or 60 frames a second instead of 24. Looks smoother; some people dislike it for films.' },

  // ---- other
  FreeLeech: { label: 'Free to download', explain: 'The site doesn’t count this download against your ratio. Small bonus on private sites.' },
  INTERNAL: { label: 'Internal copy', explain: 'Made by a group for its own site. Often good, but sometimes a test or niche version.' },
  'P2P Internal': { label: 'Internal copy (P2P)', explain: 'A group’s own-site copy, from peer-to-peer groups.' },
  MULTi: { label: 'Several languages', explain: 'Has more than one audio language. Can be useful, but sometimes the wrong one plays first.' },
  'WiTH AD': { label: 'With audio description', explain: 'Includes a narrated track describing what’s on screen, for blind and partially sighted viewers.' },
  'WiTH ASL': { label: 'With sign language (ASL)', explain: 'Includes American Sign Language on screen.' },
  'WiTH BASL': { label: 'With sign language (BASL)', explain: 'Includes Black American Sign Language on screen.' },
  'WiTH BSL': { label: 'With sign language (BSL)', explain: 'Includes British Sign Language on screen.' },
  'Season Pack': { label: 'Whole season', explain: 'A full season in one download.' },
  'Single Episode': { label: 'Single episode', explain: 'One episode on its own.' },
  'Multi-Episode': { label: 'Several episodes', explain: 'A few episodes in one download.' },

  // ---- language
  'Language: Not English': { label: 'Not in English', explain: 'Has no English audio.' },
  'Language: Not Original': { label: 'Not in its original language', explain: 'Doesn’t have the language the title was made in (dubbed only).' },
  'Language: Not French': { label: 'Not in French', explain: 'For French-language libraries.' },
  'Language: Original + French': { label: 'Original and French', explain: 'For French-language libraries.' },
  'Wrong Language': { label: 'Wrong language', explain: 'In a language you didn’t ask for.' },
  German: { label: 'German audio', explain: 'For German-language libraries.' },
  'German DL': { label: 'German and original audio', explain: 'For German-language libraries.' },
  'German DL (undefined)': { label: 'German and original audio', explain: 'For German-language libraries.' },
  'Not German or English': { label: 'Not German or English', explain: 'For German-language libraries.' },
  'Not German, Japanese or English': { label: 'Not German, Japanese or English', explain: 'For German-language libraries.' },
  'Not German, Japanese, Korean, Chinese or English': { label: 'Not German, Japanese, Korean, Chinese or English', explain: 'For German-language libraries.' },
};

export function explain(ruleName: string): Explanation | null {
  return EXPLANATIONS[ruleName] ?? null;
}
