import type { StreamFact } from '@marquee/shared';

/**
 * What a stream is doing, in plain lines ("Video: 4K HEVC → 720p H264"), the
 * way Tautulli shows it. Plex and Jellyfin say it differently; each client
 * turns its own answer into this shape, and both screens just list the lines.
 */
export interface StreamShape {
  /** How the device gets it: the file as it is, repackaged, or re-encoded. */
  how: 'play' | 'stream' | 'convert';
  hardware?: boolean;
  /** What the device receives. */
  resolution?: string | null;
  kbps?: number | null;
  /** Each part: the file's own, and what it becomes when it changes. */
  video?: { source: string | null; output?: string | null };
  audio?: { source: string | null; output?: string | null };
  subtitle?: { name: string; burned?: boolean } | null;
  container?: { source: string | null; output?: string | null };
  bandwidthKbps?: number | null;
  home?: boolean | null;
  address?: string | null;
  app?: string | null;
}

export const mbps = (kbps: number | null | undefined) => (kbps && kbps > 0 ? `${(kbps / 1000).toFixed(1)} Mbps` : null);

export function resolutionName(r: string | null | undefined): string | null {
  if (!r) return null;
  return /^\d+$/.test(r) ? `${r}p` : r.toUpperCase();
}

const CHANNELS: Record<number, string> = { 1: 'mono', 2: 'stereo', 6: '5.1', 8: '7.1' };
export const channels = (n: number | null | undefined) => (n ? (CHANNELS[n] ?? `${n} channels`) : null);

/** "AAC stereo", "H264 1080p": the known parts, or null when there are none. */
export const words = (...parts: (string | null | undefined)[]) => parts.filter(Boolean).join(' ') || null;
export const upper = (s: string | null | undefined) => s?.toUpperCase() ?? null;

/** An address on the home network (or this machine). */
export function isHomeAddress(address: string): boolean {
  const a = address.replace(/^::ffff:/i, '');
  return /^(10\.|192\.168\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a) || a === '::1' || /^f[cd][0-9a-f]{2}:|^fe80:/i.test(a);
}

const HOW = { play: 'Direct play', stream: 'Direct stream (repackaged, picture and sound untouched)', convert: 'Converting' } as const;

export function streamFacts(s: StreamShape): StreamFact[] {
  const change = (p: { source: string | null; output?: string | null } | undefined) => {
    if (!p) return null;
    if (p.source && p.output && p.output.toLowerCase() !== p.source.toLowerCase()) return `${p.source} → ${p.output}`;
    return p.source ?? p.output ?? null;
  };
  const rows: [string, string | null][] = [
    ['Stream', s.how === 'convert' && s.hardware ? 'Converting (using the graphics chip)' : HOW[s.how]],
    ['Quality', [resolutionName(s.resolution), mbps(s.kbps)].filter(Boolean).join(' · ') || null],
    ['Video', change(s.video)],
    ['Audio', change(s.audio)],
    ['Subtitles', s.subtitle ? `${s.subtitle.name}${s.subtitle.burned ? ' · drawn onto the picture' : ''}` : null],
    ['Container', change(s.container)],
    ['Bandwidth', mbps(s.bandwidthKbps)],
    ['Connection', s.home === null || s.home === undefined ? null : `${s.home ? 'Home network' : 'Away from home'}${s.address ? ` · ${s.address}` : ''}`],
    ['App', s.app ?? null],
  ];
  return rows.filter((r): r is [string, string] => !!r[1]).map(([label, value]) => ({ label, value }));
}
