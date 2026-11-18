import { createHash } from 'node:crypto';
import { redactUrl } from '../sources/torznab.js';
import type { TorrentPayload } from './qbittorrent.js';

/**
 * Fetches a copy's download link on the server (it carries the Source's key,
 * so it never goes to the browser or into qBittorrent's log) and works out
 * the info-hash, which is how Marquee recognises a torrent everywhere.
 */

export class TorrentFetchError extends Error {}

export interface FetchedTorrent {
  payload: TorrentPayload;
  /** Lowercase hex v1 info-hash. */
  infoHash: string;
}

const MAX_BYTES = 10 * 1024 * 1024;

export async function fetchTorrent(url: string, fetchImpl: typeof fetch = fetch, timeoutMs = 30_000, headers: Record<string, string> = {}): Promise<FetchedTorrent> {
  let current = url;
  const host = url.startsWith('magnet:') ? null : new URL(url).host;
  for (let hop = 0; hop < 5; hop++) {
    if (current.startsWith('magnet:')) return fromMagnet(current);
    let res: Response;
    try {
      // A site's cookies go to that site only, never to wherever it redirects.
      res = await fetchImpl(current, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers: new URL(current).host === host ? headers : {} });
    } catch (err) {
      const code = (err as { cause?: { code?: string } }).cause?.code;
      throw new TorrentFetchError(`Couldn't get the torrent from the Source${code ? ` (${code})` : ''}. Try again, or pick another copy.`);
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) break;
      current = loc.startsWith('magnet:') ? loc : new URL(loc, current).toString();
      continue;
    }
    if (res.status === 401 || res.status === 403) throw new TorrentFetchError('The Source turned down the download (its key or your account on the site).');
    if (res.status === 429) throw new TorrentFetchError('The Source asked Marquee to slow down. Try again in a few minutes.');
    if (!res.ok) throw new TorrentFetchError(`The Source answered ${res.status} for the download. Try again, or pick another copy.`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > MAX_BYTES) throw new TorrentFetchError('The Source sent a file far too big to be a torrent.');
    const text = new TextDecoder().decode(bytes.subarray(0, 200)).trim();
    if (text.startsWith('magnet:')) return fromMagnet(text.split(/\s/)[0]!);
    const infoHash = torrentInfoHash(bytes);
    if (!infoHash) throw new TorrentFetchError("The Source sent something that isn't a torrent. Pick another copy.");
    return { payload: { kind: 'file', bytes, name: `${infoHash}.torrent` }, infoHash };
  }
  throw new TorrentFetchError(`The Source's download link went round in circles (${redactUrl(url)}).`);
}

function fromMagnet(uri: string): FetchedTorrent {
  const hash = magnetInfoHash(uri);
  if (!hash) throw new TorrentFetchError("The Source sent a magnet link without an info-hash. Pick another copy.");
  return { payload: { kind: 'magnet', uri }, infoHash: hash };
}

/** The v1 info-hash in a magnet link (hex or base32), as lowercase hex. */
export function magnetInfoHash(uri: string): string | null {
  const m = /[?&]xt=urn:btih:([a-z0-9]+)/i.exec(uri);
  if (!m) return null;
  const v = m[1]!;
  if (/^[0-9a-f]{40}$/i.test(v)) return v.toLowerCase();
  if (/^[a-z2-7]{32}$/i.test(v)) return base32ToHex(v);
  return null;
}

function base32ToHex(s: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of s.toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  let hex = '';
  for (let i = 0; i + 4 <= bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

/**
 * SHA-1 of the bencoded `info` dictionary, exactly as it appears in the file.
 * Returns null if the bytes aren't a torrent.
 */
export function torrentInfoHash(b: Uint8Array): string | null {
  // Walks bencode just far enough to find where the top-level "info" value starts and ends.
  const end = (i: number): number => {
    const c = b[i];
    if (c === 0x69 /* i */) {
      const e = b.indexOf(0x65, i);
      if (e < 0) throw new Error('bad int');
      return e + 1;
    }
    if (c === 0x6c /* l */ || c === 0x64 /* d */) {
      let j = i + 1;
      while (b[j] !== 0x65) {
        if (j >= b.length) throw new Error('unterminated');
        j = end(j);
      }
      return j + 1;
    }
    if (c !== undefined && c >= 0x30 && c <= 0x39) {
      const colon = b.indexOf(0x3a, i);
      if (colon < 0) throw new Error('bad string');
      const len = Number(new TextDecoder().decode(b.subarray(i, colon)));
      if (!Number.isFinite(len)) throw new Error('bad length');
      return colon + 1 + len;
    }
    throw new Error('bad token');
  };
  try {
    if (b[0] !== 0x64) return null;
    let i = 1;
    while (i < b.length && b[i] !== 0x65) {
      const keyEnd = end(i);
      const colon = b.indexOf(0x3a, i);
      const key = new TextDecoder().decode(b.subarray(colon + 1, keyEnd));
      const valueEnd = end(keyEnd);
      if (key === 'info') {
        if (b[keyEnd] !== 0x64 || valueEnd > b.length) return null;
        return createHash('sha1').update(b.subarray(keyEnd, valueEnd)).digest('hex');
      }
      i = valueEnd;
    }
    return null;
  } catch {
    return null;
  }
}
