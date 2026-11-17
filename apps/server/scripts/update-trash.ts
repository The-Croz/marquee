/**
 * Refreshes Marquee's copy of the TRaSH Guides rules (custom formats), rule
 * groups, the quality profiles our presets are built on, and file sizes.
 *
 *   pnpm --filter @marquee/server trash:update            (latest TRaSH commit)
 *   pnpm --filter @marquee/server trash:update <commit>   (a specific one)
 *
 * Writes src/releases/trash/{radarr,sonarr}.json. Only rules reachable from
 * the base profiles below are kept, opt-in ones included, so the files stay
 * small. TRaSH Guides is MIT licensed (see src/releases/trash/LICENSE).
 * After updating, run the tests: they check every rule still works and has a
 * plain-English explanation.
 */
import fs from 'node:fs';
import path from 'node:path';

const REPO = 'TRaSH-Guides/Guides';
const OUT = path.resolve(import.meta.dirname, '../src/releases/trash');

/** The TRaSH profiles Marquee's presets start from. */
const BASE_PROFILES = {
  radarr: ['uhd-bluray-web', 'hd-bluray-web'],
  sonarr: ['web-2160p', 'web-1080p'],
} as const;
const SIZES = { radarr: 'movie', sonarr: 'series' } as const;

type Json = Record<string, any>;

async function get(url: string): Promise<any> {
  const res = await fetch(url, { headers: { 'User-Agent': 'marquee-trash-update', Accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
}

const commit: string = process.argv[2] ?? (await get(`https://api.github.com/repos/${REPO}/commits/master`)).sha;
const tree = (await get(`https://api.github.com/repos/${REPO}/git/trees/${commit}?recursive=1`)).tree as { path: string }[];
const raw = (p: string) => get(`https://raw.githubusercontent.com/${REPO}/${commit}/${p}`);

/** Downloads a folder's JSON files, a few at a time. */
async function folder(app: string, name: string): Promise<Json[]> {
  const paths = tree.map((t) => t.path).filter((p) => p.startsWith(`docs/json/${app}/${name}/`) && p.endsWith('.json'));
  const out: Json[] = [];
  for (let i = 0; i < paths.length; i += 16) out.push(...(await Promise.all(paths.slice(i, i + 16).map(raw))));
  return out;
}

for (const app of ['radarr', 'sonarr'] as const) {
  const [groupsAll, formatsAll] = await Promise.all([folder(app, 'cf-groups'), folder(app, 'cf')]);
  const sizes = await raw(`docs/json/${app}/quality-size/${SIZES[app]}.json`);
  const profiles: Json[] = await Promise.all(BASE_PROFILES[app].map((file) => raw(`docs/json/${app}/quality-profiles/${file}.json`)));
  const names = new Set(profiles.map((p) => p.name));

  // Groups that list one of our profiles; anime and language-specific groups are left out (Marquee is English, no anime).
  const groups = groupsAll.filter((g) => Object.keys(g.quality_profiles?.include ?? {}).some((n) => names.has(n)) && !/anime|french|german|dutch|asian/i.test(g.name));
  const wanted = new Set<string>([...profiles.flatMap((p) => Object.values(p.formatItems as Record<string, string>)), ...groups.flatMap((g) => g.custom_formats.map((c: Json) => c.trash_id))]);
  const formats = formatsAll.filter((f) => wanted.has(f.trash_id)).sort((a, b) => a.name.localeCompare(b.name));
  const missing = [...wanted].filter((id) => !formats.some((f) => f.trash_id === id));
  if (missing.length) throw new Error(`${app}: rules referenced but not found: ${missing.join(', ')}`);

  const data = {
    source: `https://github.com/${REPO}/tree/${commit}/docs/json/${app}`,
    commit,
    fetchedAt: new Date().toISOString().slice(0, 10),
    profiles: profiles.map(({ trash_id, name, trash_description, cutoff, upgradeAllowed, minFormatScore, cutoffFormatScore, minUpgradeFormatScore, items, formatItems }) => ({
      trash_id,
      name,
      trash_description,
      cutoff,
      upgradeAllowed,
      minFormatScore,
      cutoffFormatScore,
      minUpgradeFormatScore,
      items,
      formatItems,
    })),
    groups: groups.map(({ trash_id, name, trash_description, default: def, custom_formats, quality_profiles }) => ({
      trash_id,
      name,
      trash_description,
      default: def === true || def === 'true',
      custom_formats,
      profiles: Object.keys(quality_profiles?.include ?? {}).filter((n) => names.has(n)),
    })),
    formats: formats.map(({ trash_id, name, trash_scores, specifications }) => ({ trash_id, name, trash_scores, specifications })),
    sizes: sizes.qualities,
  };
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `${app}.json`), `${JSON.stringify(data, null, 1)}\n`);
  console.log(`${app}: ${data.profiles.length} profiles, ${data.groups.length} groups, ${data.formats.length} rules (TRaSH ${commit.slice(0, 7)})`);
}
