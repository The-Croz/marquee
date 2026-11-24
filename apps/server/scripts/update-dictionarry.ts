/**
 * Refreshes Marquee's pinned copy of Dictionarry (Profilarr's database of
 * rules and profiles), the default rules for new installs.
 *
 *   pnpm --filter @marquee/server dictionarry:update            (newest commit on its v2 branch)
 *   pnpm --filter @marquee/server dictionarry:update <commit>   (a specific one)
 *
 * Writes src/releases/dictionarry/{radarr,sonarr}.json. Dictionarry declares
 * itself MIT licensed in its pcd.json (see src/releases/dictionarry/LICENSE).
 * Installs also check for newer versions weekly by themselves (Settings →
 * Quality → Rule updates); this only moves the starting point.
 * After updating, run the tests: they check every rule works and has plain words.
 */
import fs from 'node:fs';
import path from 'node:path';
import { downloadDictionarry, githubFetch } from '../src/releases/dictionarry.js';

const OUT = path.resolve(import.meta.dirname, '../src/releases/dictionarry');
const data = await downloadDictionarry(githubFetch(), process.argv[2]);
fs.mkdirSync(OUT, { recursive: true });
for (const app of ['radarr', 'sonarr'] as const) {
  const d = data[app];
  fs.writeFileSync(path.join(OUT, `${app}.json`), `${JSON.stringify(d)}\n`);
  console.log(`${app}: ${d.profiles.length} profiles, ${d.formats.length} rules, ${d.unmapped.length} tests Marquee can't check (Dictionarry ${d.commit.slice(0, 7)})`);
  for (const u of d.unmapped) console.log(`  can't check: ${u}`);
}
