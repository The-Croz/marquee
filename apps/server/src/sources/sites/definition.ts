import { parse } from 'yaml';
import type { SiteField } from '@marquee/shared';
import { KNOWN_FILTERS, type Filter } from './filters.js';
import { htmlDecode } from './filters.js';

/**
 * A site definition: the YAML file (Prowlarr's format, after Jackett's
 * Cardigann) that says how to sign in to a site, search it and read its
 * results. Marquee reads the same files, so the catalogue keeps up as sites
 * change without a Marquee update.
 */

export interface SelectorBlock {
  selector?: string;
  attribute?: string;
  text?: string | number;
  filters?: Filter[];
  optional?: boolean;
  default?: string | number;
  case?: Record<string, string | number>;
  remove?: string;
}

export interface SearchPath {
  path: string;
  method?: string;
  inputs?: Record<string, string | number>;
  inheritinputs?: boolean;
  categories?: (string | number)[];
  response?: { type?: string; noResultsMessage?: string };
  followredirect?: boolean;
}

export interface Definition {
  id: string;
  name: string;
  description?: string;
  type?: string;
  language?: string;
  encoding?: string;
  requestDelay?: number;
  links: string[];
  legacylinks?: string[];
  settings?: { name: string; type: string; label?: string; default?: unknown; options?: Record<string, string> }[];
  caps: {
    categories?: Record<string, string>;
    categorymappings?: { id: string | number; cat: string; desc?: string; default?: boolean }[];
    modes?: Record<string, string[]>;
    allowrawsearch?: boolean;
  };
  login?: {
    method?: string;
    path?: string;
    submitpath?: string;
    form?: string;
    inputs?: Record<string, string | number>;
    selectorinputs?: Record<string, SelectorBlock>;
    getselectorinputs?: Record<string, SelectorBlock>;
    cookies?: string[];
    headers?: Record<string, string[] | string>;
    captcha?: unknown;
    error?: { selector: string; message?: SelectorBlock }[];
    test?: { path?: string; selector?: string };
  };
  search: {
    path?: string;
    paths?: SearchPath[];
    inputs?: Record<string, string | number>;
    headers?: Record<string, string[] | string>;
    keywordsfilters?: Filter[];
    allowEmptyInputs?: boolean;
    error?: { selector: string; message?: SelectorBlock }[];
    preprocessingfilters?: Filter[];
    rows: SelectorBlock & { after?: number; count?: SelectorBlock; multiple?: boolean; missingAttributeEqualsNoResults?: boolean; dateheaders?: SelectorBlock };
    fields: Record<string, SelectorBlock>;
  };
  download?: {
    selectors?: SelectorBlock[];
    method?: string;
    before?: { path?: string; method?: string; inputs?: Record<string, string> };
    infohash?: unknown;
    headers?: Record<string, string[] | string>;
  };
}

export class DefinitionError extends Error {}

export function readDefinition(yamlText: string): Definition {
  let d: Definition;
  try {
    d = parse(yamlText, { uniqueKeys: false }) as Definition;
  } catch (err) {
    throw new DefinitionError(`The site file isn't valid YAML: ${(err as Error).message}`);
  }
  if (!d || typeof d !== 'object' || !d.id || !d.name || !Array.isArray(d.links) || !d.search) throw new DefinitionError('The site file is missing its id, name, links or search.');
  d.id = String(d.id).toLowerCase();
  d.caps ??= {};
  d.search.paths ??= d.search.path ? [{ path: d.search.path }] : [];
  return d;
}

// ---------------------------------------------------------------- categories

/** The standard category numbers (Movies 2000, TV 5000, …) by name, as definitions write them. */
const STANDARD: Record<string, number> = {
  Console: 1000, Movies: 2000, 'Movies/Foreign': 2010, 'Movies/Other': 2020, 'Movies/SD': 2030, 'Movies/HD': 2040, 'Movies/UHD': 2045, 'Movies/BluRay': 2050,
  'Movies/3D': 2060, 'Movies/DVD': 2070, 'Movies/WEB-DL': 2080, Audio: 3000, PC: 4000, TV: 5000, 'TV/WEB-DL': 5010, 'TV/Foreign': 5020, 'TV/SD': 5030, 'TV/HD': 5040,
  'TV/UHD': 5045, 'TV/Other': 5050, 'TV/Sport': 5060, 'TV/Anime': 5070, 'TV/Documentary': 5080, XXX: 6000, Books: 7000, Other: 8000,
};
const MAIN: Record<string, number> = { Console: 1000, Movies: 2000, Audio: 3000, PC: 4000, TV: 5000, XXX: 6000, Books: 7000, Other: 8000 };

export function standardCategory(name: string): number | null {
  return STANDARD[name] ?? MAIN[name.split('/')[0]!] ?? null;
}

export interface CategoryMap {
  /** Site category id → standard numbers. */
  toStandard: Map<string, number[]>;
  /** Site category description (lowercase) → standard numbers. */
  byDesc: Map<string, number[]>;
  /** Site ids marked default, used when nothing else maps. */
  defaults: string[];
}

export function categoryMap(d: Definition): CategoryMap {
  const toStandard = new Map<string, number[]>();
  const byDesc = new Map<string, number[]>();
  const defaults: string[] = [];
  const add = (id: string, cat: string, desc?: string) => {
    const n = standardCategory(cat);
    if (n === null) return;
    toStandard.set(id, [...(toStandard.get(id) ?? []), n]);
    if (desc) byDesc.set(desc.toLowerCase(), [...(byDesc.get(desc.toLowerCase()) ?? []), n]);
    byDesc.set(cat.toLowerCase(), [...(byDesc.get(cat.toLowerCase()) ?? []), n]);
  };
  for (const [id, cat] of Object.entries(d.caps.categories ?? {})) add(String(id), String(cat), String(cat));
  for (const m of d.caps.categorymappings ?? []) {
    add(String(m.id), m.cat, m.desc);
    if (m.default) defaults.push(String(m.id));
  }
  return { toStandard, byDesc, defaults };
}

/** The site's own category ids for movies (2xxx) or TV (5xxx). */
export function siteCategories(map: CategoryMap, kind: 'movie' | 'tv'): string[] {
  const base = kind === 'movie' ? 2000 : 5000;
  return [...map.toStandard].filter(([, std]) => std.some((n) => Math.floor(n / 1000) * 1000 === base)).map(([id]) => id);
}

/** Whether the site has movies or TV at all (others are left out of the list). */
export function hasMoviesOrTv(d: Definition): boolean {
  const m = categoryMap(d);
  return siteCategories(m, 'movie').length > 0 || siteCategories(m, 'tv').length > 0;
}

// ---------------------------------------------------------------- settings form

const stripHtml = (s: string) => htmlDecode(s.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

const INFO_TEXT: Record<string, string> = {
  info_cookie:
    'To get the cookie: sign in to the site in your browser, open the developer tools (F12), go to Network, reload the page, click the first request and copy the whole "Cookie" line from its request headers.',
  info_useragent: 'Copy your browser’s user agent too (search “what is my user agent”), since some sites tie the cookie to the browser it came from.',
  info_flaresolverr: 'This site sometimes puts a bot check in front of its pages. Turn on bot-check solving in Settings → Sources if it shows “Blocked by a bot check”.',
  info_category_8000: '',
};

/** The form a person fills in to add the site: its own settings, in plain labels. */
export function siteFields(d: Definition): SiteField[] {
  const out: SiteField[] = [];
  for (const s of d.settings ?? []) {
    if (s.type.startsWith('info')) {
      const text = INFO_TEXT[s.type] ?? stripHtml(String(s.default ?? ''));
      if (text) out.push({ name: s.name, type: 'info', label: stripHtml(s.label ?? ''), text });
      continue;
    }
    const type = s.type === 'password' ? 'password' : s.type === 'checkbox' ? 'checkbox' : s.type === 'select' ? 'select' : s.type === 'multi-select' ? 'multiselect' : 'text';
    out.push({
      name: s.name,
      type,
      label: stripHtml(s.label ?? s.name),
      // Cookies and keys are secrets too, whatever the file calls them.
      secret: type === 'password' || /^(cookie|apikey|api_key|passkey|rsskey|token|pid)$/i.test(s.name),
      default: s.default === undefined || s.default === null ? null : Array.isArray(s.default) ? s.default.map(String) : typeof s.default === 'boolean' ? s.default : String(s.default),
      options: s.options ? Object.entries(s.options).map(([value, label]) => ({ value, label: stripHtml(String(label)) })) : undefined,
    });
  }
  return out;
}

// ---------------------------------------------------------------- what Marquee can run

const LOGIN_METHODS = new Set(['form', 'post', 'get', 'cookie', 'oneurl']);

/** Why Marquee can't run this site yet, in plain words, or null when it can. */
export function unsupportedReason(d: Definition): string | null {
  const method = d.login?.method ?? (d.login ? 'form' : null);
  if (method && !LOGIN_METHODS.has(method)) return `It signs in a way Marquee can’t do yet (${method}).`;
  if (d.login?.captcha) return 'It asks for a captcha when you sign in, which Marquee can’t do yet.';
  if (!d.search.paths?.length) return 'Its file doesn’t say how to search it.';
  if (!d.search.fields?.title) return 'Its file doesn’t say where the names of copies are.';
  for (const f of collectFilters(d)) if (!KNOWN_FILTERS.has(f)) return `It uses a step Marquee doesn’t know yet (${f}).`;
  return null;
}

function collectFilters(d: Definition): Set<string> {
  const names = new Set<string>();
  const walk = (o: unknown) => {
    if (Array.isArray(o)) o.forEach(walk);
    else if (o && typeof o === 'object') {
      const filters = (o as { filters?: unknown }).filters;
      if (Array.isArray(filters)) for (const f of filters) if (f && typeof f === 'object' && 'name' in f) names.add(String((f as Filter).name));
      Object.values(o).forEach(walk);
    }
  };
  walk(d.search);
  walk(d.download);
  walk(d.login);
  for (const f of d.search.keywordsfilters ?? []) names.add(f.name);
  return names;
}
