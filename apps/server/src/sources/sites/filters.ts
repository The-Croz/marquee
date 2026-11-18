import { applyTemplate, type Vars } from './template.js';
import { fromFuzzy, fromTimeAgo, parseDateLayout, toRegex, toReplacement } from './text.js';

/**
 * The text filters site definitions chain onto a value (`filters:` blocks).
 * Unknown filters leave the value as it is. Dates come out as ISO text, so
 * later filters and fields can read them.
 */

export interface Filter {
  name: string;
  args?: unknown;
}

export const KNOWN_FILTERS = new Set([
  'replace', 're_replace', 'regexp', 'split', 'trim', 'prepend', 'append', 'toupper', 'tolower', 'urldecode', 'urlencode', 'querystring',
  'dateparse', 'timeparse', 'timeago', 'reltime', 'fuzzytime', 'htmldecode', 'htmlencode', 'diacritics', 'validfilename', 'validate', 'andmatch',
  'strdump', 'jsonjoinarray', 'base64decode', 'hexdump',
]);

const list = (a: unknown): unknown[] => (Array.isArray(a) ? a : a === undefined || a === null ? [] : [a]);
const str = (a: unknown): string => (a === undefined || a === null ? '' : String(a));

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
export function htmlDecode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const iso = (t: number | null, fallback: string) => (t === null ? fallback : new Date(t).toISOString());

export function applyFilters(value: string | null, filters: Filter[] | undefined, vars: Vars, now: number): string | null {
  if (value === null || !filters) return value;
  let data: string = value;
  for (const f of filters) {
    const args = list(f.args);
    const arg = (i: number) => applyTemplate(str(args[i]), vars);
    switch (f.name) {
      case 'replace':
        data = data.split(str(args[0])).join(arg(1));
        break;
      case 're_replace': {
        const re = toRegex(str(args[0]), 'g');
        if (re) data = data.replace(re, toReplacement(arg(1)));
        break;
      }
      case 'regexp': {
        const re = toRegex(str(f.args));
        const m = re?.exec(data);
        data = m ? (m[1] ?? m[0]) : '';
        break;
      }
      case 'split': {
        const parts = data.split(str(args[0]));
        const i = Number(args[1] ?? 0);
        data = (i < 0 ? parts[parts.length + i] : parts[i]) ?? '';
        break;
      }
      case 'trim':
        data = args.length ? trimChars(data, str(args[0])) : data.trim();
        break;
      case 'prepend':
        data = applyTemplate(str(f.args), vars) + data;
        break;
      case 'append':
        data = data + applyTemplate(str(f.args), vars);
        break;
      case 'toupper':
        data = data.toUpperCase();
        break;
      case 'tolower':
        data = data.toLowerCase();
        break;
      case 'urldecode':
        try {
          data = decodeURIComponent(data.replace(/\+/g, ' '));
        } catch {
          /* keep it */
        }
        break;
      case 'urlencode':
        data = encodeURIComponent(data);
        break;
      case 'querystring': {
        try {
          const u = new URL(data, 'http://x/');
          data = u.searchParams.get(str(f.args)) ?? '';
        } catch {
          data = '';
        }
        break;
      }
      case 'dateparse':
      case 'timeparse':
        data = iso(parseDateLayout(data, str(f.args), now), data);
        break;
      case 'timeago':
      case 'reltime':
        data = iso(fromTimeAgo(data, now), data);
        break;
      case 'fuzzytime':
        data = iso(fromFuzzy(data, now), data);
        break;
      case 'htmldecode':
        data = htmlDecode(data);
        break;
      case 'htmlencode':
        data = data.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        break;
      case 'diacritics':
        data = data.normalize('NFKD').replace(/[̀-ͯ]/g, '');
        break;
      case 'validfilename':
        data = data.replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ');
        break;
      case 'validate': {
        // Keeps only the words that are in the allowed list.
        const allowed = str(f.args).toLowerCase().split(/[,\s]+/).filter(Boolean);
        data = data.split(/[,\s]+/).filter((w) => allowed.includes(w.toLowerCase())).join(',');
        break;
      }
      case 'jsonjoinarray':
        try {
          const parsed = JSON.parse(data) as unknown;
          data = Array.isArray(parsed) ? parsed.join(str(args[1] ?? ',')) : data;
        } catch {
          /* keep it */
        }
        break;
      case 'base64decode':
        data = Buffer.from(data, 'base64').toString('utf8');
        break;
      // Row filters and debugging aids: nothing to do to the value.
      case 'andmatch':
      case 'strdump':
      case 'hexdump':
      default:
        break;
    }
  }
  return data;
}

function trimChars(s: string, chars: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && chars.includes(s[a]!)) a++;
  while (b > a && chars.includes(s[b - 1]!)) b--;
  return s.slice(a, b);
}
