import { gzipSync } from 'fflate';
import type { DictionarryFetch } from '../../src/releases/dictionarry.js';

/**
 * A small Dictionarry of our own (same tables and step format as the real one,
 * none of its content) and a fake GitHub that serves it as tarballs.
 */

/** Only the tables Marquee reads. */
export const SCHEMA_SQL = `
CREATE TABLE tags (name TEXT PRIMARY KEY);
CREATE TABLE regular_expressions (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, pattern TEXT NOT NULL);
CREATE TABLE qualities (name TEXT PRIMARY KEY);
CREATE TABLE quality_api_mappings (quality_name TEXT NOT NULL, arr_type TEXT NOT NULL, api_name TEXT NOT NULL, PRIMARY KEY (quality_name, arr_type));
CREATE TABLE custom_formats (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, description TEXT);
CREATE TABLE custom_format_conditions (id INTEGER PRIMARY KEY AUTOINCREMENT, custom_format_name TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, arr_type TEXT NOT NULL DEFAULT 'all', negate INTEGER NOT NULL DEFAULT 0, required INTEGER NOT NULL DEFAULT 0, UNIQUE (custom_format_name, name));
CREATE TABLE custom_format_tags (custom_format_name TEXT NOT NULL, tag_name TEXT NOT NULL);
CREATE TABLE condition_patterns (custom_format_name TEXT, condition_name TEXT, regular_expression_name TEXT);
CREATE TABLE condition_languages (custom_format_name TEXT, condition_name TEXT, language_name TEXT, except_language INTEGER NOT NULL DEFAULT 0);
CREATE TABLE condition_indexer_flags (custom_format_name TEXT, condition_name TEXT, flag TEXT);
CREATE TABLE condition_sources (custom_format_name TEXT, condition_name TEXT, source TEXT);
CREATE TABLE condition_resolutions (custom_format_name TEXT, condition_name TEXT, resolution TEXT);
CREATE TABLE condition_quality_modifiers (custom_format_name TEXT, condition_name TEXT, quality_modifier TEXT);
CREATE TABLE condition_sizes (custom_format_name TEXT, condition_name TEXT, min_bytes INTEGER, max_bytes INTEGER);
CREATE TABLE condition_release_types (custom_format_name TEXT, condition_name TEXT, release_type TEXT);
CREATE TABLE condition_years (custom_format_name TEXT, condition_name TEXT, min_year INTEGER, max_year INTEGER);
CREATE TABLE quality_profiles (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, description TEXT, upgrades_allowed INTEGER NOT NULL DEFAULT 1, minimum_custom_format_score INTEGER NOT NULL DEFAULT 0, upgrade_until_score INTEGER NOT NULL DEFAULT 0, upgrade_score_increment INTEGER NOT NULL DEFAULT 1);
CREATE TABLE quality_groups (quality_profile_name TEXT, name TEXT);
CREATE TABLE quality_group_members (quality_profile_name TEXT, quality_group_name TEXT, quality_name TEXT);
CREATE TABLE quality_profile_qualities (id INTEGER PRIMARY KEY AUTOINCREMENT, quality_profile_name TEXT, quality_name TEXT, quality_group_name TEXT, position INTEGER, enabled INTEGER, upgrade_until INTEGER DEFAULT 0);
CREATE TABLE quality_profile_custom_formats (quality_profile_name TEXT, custom_format_name TEXT, arr_type TEXT, score INTEGER);
CREATE TABLE radarr_quality_definitions (name TEXT, quality_name TEXT, min_size INTEGER, max_size INTEGER, preferred_size INTEGER);
CREATE TABLE sonarr_quality_definitions (name TEXT, quality_name TEXT, min_size INTEGER, max_size INTEGER, preferred_size INTEGER);
CREATE TABLE radarr_media_settings (name TEXT, propers_repacks TEXT);
CREATE TABLE sonarr_media_settings (name TEXT, propers_repacks TEXT);
`;

const QUALITIES = ['Bluray-1080p', 'WEBDL-1080p', 'Remux-1080p', 'CAM'];

/** Step 1: one profile, "Small", with three rules and a group of 1080p qualities. */
export const OPS_V1: [string, string][] = [
  [
    '0.base.sql',
    `
INSERT INTO regular_expressions (name, pattern) VALUES ('x265', '[xh][ ._-]?265|\\bHEVC\\b'), ('Good', '^(Good|Fine)$'), ('3D', '\\b3D\\b');
${QUALITIES.map((q) => `INSERT INTO qualities VALUES ('${q}');`).join('\n')}
${QUALITIES.filter((q) => q !== 'CAM').map((q) => `INSERT INTO quality_api_mappings VALUES ('${q}', 'radarr', '${q}');`).join('\n')}
INSERT INTO quality_api_mappings VALUES ('CAM', 'radarr', 'CAM'), ('Bluray-1080p', 'sonarr', 'Bluray-1080p'), ('WEBDL-1080p', 'sonarr', 'WEBDL-1080p'), ('Remux-1080p', 'sonarr', 'Bluray-1080p Remux');
INSERT INTO custom_formats (name, description) VALUES ('Good Group', 'Groups we like'), ('x265', 'HEVC video'), ('3D', 'Three dimensions'), ('Radarr Remux', 'Only for movies');
INSERT INTO custom_format_tags VALUES ('Good Group', 'Release Group Tier'), ('x265', 'Codec');
INSERT INTO custom_format_conditions (custom_format_name, name, type, arr_type, negate, required) VALUES
  ('Good Group', 'group', 'release_group', 'all', 0, 0),
  ('Good Group', '1080p', 'resolution', 'all', 0, 1),
  ('Good Group', 'Bluray', 'source', 'all', 0, 1),
  ('x265', 'x265', 'release_title', 'all', 0, 0),
  ('3D', '3D', 'release_title', 'all', 0, 0),
  ('Radarr Remux', 'remux', 'quality_modifier', 'radarr', 0, 0);
INSERT INTO condition_patterns VALUES ('Good Group', 'group', 'Good'), ('x265', 'x265', 'x265'), ('3D', '3D', '3D');
INSERT INTO condition_resolutions VALUES ('Good Group', '1080p', '1080p');
INSERT INTO condition_sources VALUES ('Good Group', 'Bluray', 'bluray');
INSERT INTO condition_quality_modifiers VALUES ('Radarr Remux', 'remux', 'remux');
INSERT INTO quality_profiles (name, description, minimum_custom_format_score, upgrade_until_score) VALUES ('Small', 'Small **x265** copies', 100, 1000);
INSERT INTO quality_group_members VALUES ('Small', 'Small', 'Bluray-1080p'), ('Small', 'Small', 'WEBDL-1080p');
INSERT INTO quality_profile_qualities (quality_profile_name, quality_name, quality_group_name, position, enabled, upgrade_until) VALUES
  ('Small', NULL, 'Small', 0, 1, 1), ('Small', 'Remux-1080p', NULL, 1, 0, 0), ('Small', 'CAM', NULL, 2, 0, 0);
INSERT INTO quality_profile_custom_formats VALUES ('Small', 'Good Group', 'all', 500), ('Small', 'x265', 'radarr', 50), ('Small', 'x265', 'sonarr', 20), ('Small', '3D', 'all', -999999), ('Small', 'Radarr Remux', 'radarr', -999999);
INSERT INTO radarr_quality_definitions VALUES ('Radarr', 'Bluray-1080p', 0, 0, 1990);
INSERT INTO radarr_media_settings VALUES ('Radarr', 'doNotPrefer');
INSERT INTO sonarr_media_settings VALUES ('Sonarr', 'preferAndUpgrade');
`,
  ],
];

/** Step 2: x265 is worth more, 3D's test changes, a rule is added and one dropped. */
export const OPS_V2: [string, string][] = [
  ...OPS_V1,
  [
    '1.tweak.sql',
    `
UPDATE quality_profile_custom_formats SET score = 80 WHERE custom_format_name = 'x265' AND arr_type = 'radarr';
UPDATE regular_expressions SET pattern = '\\b(3D|SBS)\\b' WHERE name = '3D';
INSERT INTO custom_formats (name, description) VALUES ('Year', 'Old films');
INSERT INTO custom_format_conditions (custom_format_name, name, type) VALUES ('Year', 'old', 'year');
INSERT INTO condition_years VALUES ('Year', 'old', 1900, 1970);
INSERT INTO quality_profile_custom_formats VALUES ('Small', 'Year', 'all', 5);
DELETE FROM quality_profile_custom_formats WHERE custom_format_name = 'Radarr Remux';
`,
  ],
];

/** A .tar.gz of `files` under GitHub's "<owner>-<repo>-<sha>/" folder. */
export function tarball(files: Record<string, string>, top = 'Dictionarry-Hub-database-abc'): Uint8Array {
  const enc = new TextEncoder();
  const blocks: Uint8Array[] = [];
  const header = (name: string, size: number) => {
    const h = new Uint8Array(512);
    const put = (s: string, at: number) => h.set(enc.encode(s), at);
    put(name, 0);
    put('0000644\0', 100);
    put('0000000\0', 108);
    put('0000000\0', 116);
    put(`${size.toString(8).padStart(11, '0')}\0`, 124);
    put('00000000000\0', 136);
    put('        ', 148);
    h[156] = 48; // '0': a file
    put('ustar\0', 257);
    put('00', 263);
    const sum = h.reduce((a, b) => a + b, 0);
    put(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    return h;
  };
  for (const [name, text] of Object.entries(files)) {
    const body = enc.encode(text);
    blocks.push(header(`${top}/${name}`, body.length), body, new Uint8Array((512 - (body.length % 512)) % 512));
  }
  blocks.push(new Uint8Array(1024));
  const total = blocks.reduce((n, b) => n + b.length, 0);
  const tar = new Uint8Array(total);
  let at = 0;
  for (const b of blocks) {
    tar.set(b, at);
    at += b.length;
  }
  return gzipSync(tar);
}

/** GitHub with our own Dictionarry at two commits. */
export class FakeDictionarry implements DictionarryFetch {
  latestSha = 'v1sha';
  calls: string[] = [];
  fail = false;
  constructor(private versions: Record<string, [string, string][]> = { v1sha: OPS_V1, v2sha: OPS_V2 }) {}
  async latest(): Promise<string> {
    this.calls.push('latest');
    if (this.fail) throw new Error('GitHub answered 503.');
    return this.latestSha;
  }
  async tarball(repo: string, ref: string): Promise<Uint8Array> {
    this.calls.push(`${repo}@${ref}`);
    if (repo.endsWith('/schema')) return tarball({ 'ops/0.schema.sql': SCHEMA_SQL, 'pcd.json': '{}' }, 'Dictionarry-Hub-schema-1');
    const ops = this.versions[ref];
    if (!ops) throw new Error(`no such commit ${ref}`);
    return tarball({ 'pcd.json': JSON.stringify({ dependencies: { 'https://github.com/Dictionarry-Hub/schema': '1.1.0' } }), ...Object.fromEntries(ops.map(([f, sql]) => [`ops/${f}`, sql])) });
  }
}
