import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { STATE_TEXT } from '../src/sources/service.js';
import { DOWNLOADER_TEXT } from '../src/downloads/service.js';
import { unpackText, type UnpackProblem } from '../src/downloads/unpack.js';

/**
 * Screens use Marquee's own words (docs/GLOSSARY.md), not the jargon older
 * apps use. This scans the web app's source for the older words.
 */

const WEB_SRC = path.resolve(import.meta.dirname, '../../web/src');

const BANNED: { word: RegExp; use: string }[] = [
  { word: /\bindexers?\b/i, use: 'Source' },
  { word: /\bcustom formats?\b/i, use: 'rule' },
  { word: /\broot folders?\b/i, use: 'library folder' },
  { word: /\bdownload clients?\b/i, use: 'downloader' },
  { word: /\binteractive search\b/i, use: 'Copies we found' },
  { word: /\bblocklist(ed)?\b/i, use: 'never pick' },
  { word: /\bstalledDL\b|\bcutoff unmet\b/i, use: 'plain words' },
];

/** Places an older word may appear on purpose. Add one only with a reason. */
const ALLOWED = [
  'Older apps call them indexers', // the one bridge sentence on Settings → Sources
  '/api/v2.0/indexers/', // part of a Jackett address in a placeholder
];

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return files(p);
    return /\.(tsx?|css|html)$/.test(e.name) ? [p] : [];
  });
}

/** Removes comments and imports so only code and on-screen text are checked. */
function visible(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/^import .*$/gm, '');
}

describe('word check', () => {
  it('the web app uses Marquee words, not older-app jargon', () => {
    const found: string[] = [];
    for (const file of files(WEB_SRC)) {
      let text = visible(fs.readFileSync(file, 'utf8'));
      for (const ok of ALLOWED) text = text.split(ok).join('');
      text.split('\n').forEach((line, i) => {
        for (const b of BANNED) {
          const m = line.match(b.word);
          if (m) found.push(`${path.relative(WEB_SRC, file)}:${i + 1} says "${m[0]}"; use "${b.use}"`);
        }
      });
    }
    expect(found).toEqual([]);
  });

  it('server messages shown on screen use them too', () => {
    const unpack: UnpackProblem[] = ['password', 'no_video', 'unsafe', 'missing_part', 'broken', 'no_tool', 'no_room', 'failed'];
    const messages = [...Object.values(STATE_TEXT), ...Object.values(DOWNLOADER_TEXT)].flatMap((t) => [t.label, t.fix ?? '']).concat(unpack.map((k) => unpackText(k, 'detail')));
    for (const m of messages) for (const b of BANNED) expect(m).not.toMatch(b.word);
  });
});
