/**
 * Reads every site file in a folder and reports which Marquee can run, and
 * any templates it can't read. For checking the engine against Prowlarr's
 * catalogue: `tsx scripts/check-catalogue.ts <folder of .yml files>`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { hasMoviesOrTv, readDefinition, unsupportedReason } from '../src/sources/sites/definition.js';
import { applyTemplate } from '../src/sources/sites/template.js';

const dir = process.argv[2];
if (!dir) throw new Error('Give a folder of .yml site files.');
const reasons = new Map<string, string[]>();
let ok = 0;
let skipped = 0;
const templateErrors: string[] = [];
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.yml'))) {
  const text = fs.readFileSync(path.join(dir, f), 'utf8');
  try {
    const d = readDefinition(text);
    if (!hasMoviesOrTv(d)) {
      skipped++;
      continue;
    }
    const why = unsupportedReason(d);
    if (why) reasons.set(why, [...(reasons.get(why) ?? []), d.id]);
    else ok++;
    for (const m of text.matchAll(/"((?:[^"\\]|\\.)*\{\{(?:[^"\\]|\\.)*)"|'([^']*\{\{[^']*)'|:\s+([^"'\n][^\n]*\{\{[^\n]*)/g)) {
      const t = (m[1] ?? m[2] ?? m[3])!.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      try {
        applyTemplate(t, { '.Categories': ['1', '2'], '.Keywords': 'x', '.Config.sitelink': 'https://x/' });
      } catch (err) {
        templateErrors.push(`${d.id}: ${(err as Error).message} in ${t.slice(0, 120)}`);
      }
    }
  } catch (err) {
    reasons.set((err as Error).message.slice(0, 80), [...(reasons.get((err as Error).message.slice(0, 80)) ?? []), f]);
  }
}
console.log(`runnable: ${ok}, no movies or TV: ${skipped}`);
for (const [why, ids] of [...reasons].sort((a, b) => b[1].length - a[1].length)) console.log(`${ids.length}  ${why}  (${ids.slice(0, 5).join(', ')})`);
console.log(`template problems: ${templateErrors.length}`);
for (const e of templateErrors.slice(0, 25)) console.log('  ', e);
