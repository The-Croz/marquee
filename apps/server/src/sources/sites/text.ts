/**
 * Text helpers for site definitions: .NET-style regular expressions, sizes and
 * dates the way torrent sites write them. Pure: no network or database.
 */

/**
 * Turns a .NET regular expression (as site definitions are written) into a
 * JavaScript one: inline flags like `(?i)` become flags, and `${name}` in a
 * replacement becomes `$<name>`. Returns null if it still can't be read.
 */
export function toRegex(pattern: string, flags = ''): RegExp | null {
  let p = pattern;
  const f = new Set(flags.split(''));
  p = p.replace(/\(\?([imsx]+)\)/g, (_, fl: string) => {
    for (const c of fl) if (c !== 'x') f.add(c);
    return '';
  });
  p = p.replace(/\\p\{IsCJKUnifiedIdeographs\}/g, '\\u4E00-\\u9FFF').replace(/\\p\{Is[A-Za-z]+\}/g, '\\p{L}');
  if (/\\p\{/.test(p)) f.add('u');
  try {
    return new RegExp(p, [...f].join(''));
  } catch {
    return null;
  }
}

export function toReplacement(r: string): string {
  return r.replace(/\$\{(\d+)\}/g, '$$$1').replace(/\$\{([A-Za-z_]\w*)\}/g, '$$<$1>');
}

const UNITS: Record<string, number> = { b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4, p: 1024 ** 5 };

/** "1.4 GB", "700 MiB", "1,234.5 MB", "1,5 GB", "123456789" → bytes, or null. */
export function parseBytes(text: string | null | undefined): number | null {
  if (text == null) return null;
  const s = text.replace(/ /g, ' ').trim();
  const m = /([\d.,]+)\s*([kmgtp]?)(?:i?b|bytes?|o)?\b/i.exec(s);
  if (!m) return null;
  let n = m[1]!;
  if (n.includes('.') && n.includes(',')) n = n.indexOf(',') < n.indexOf('.') ? n.replace(/,/g, '') : n.replace(/\./g, '').replace(',', '.');
  else if (n.includes(',')) n = /,\d{3}(?!\d)/.test(n) && !/,\d{1,2}$/.test(n) ? n.replace(/,/g, '') : n.replace(',', '.');
  const v = Number.parseFloat(n);
  if (!Number.isFinite(v)) return null;
  return Math.round(v * (UNITS[(m[2] || 'b').toLowerCase()] ?? 1));
}

/** Leading whole number in text ("1,234 seeders" → 1234), or null. */
export function parseCount(text: string | null | undefined): number | null {
  if (text == null) return null;
  const m = /-?\d[\d,.]*/.exec(text.replace(/\s/g, ''));
  if (!m) return null;
  const n = Number.parseInt(m[0].replace(/[,.](?=\d{3}\b)/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------- dates

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const SPANS: [RegExp, number][] = [
  [/^(sec|second)s?$/, 1000],
  [/^(min|minute|mins|minutes|m)$/, MINUTE],
  [/^(h|hr|hrs|hour|hours)$/, HOUR],
  [/^(d|day|days)$/, DAY],
  [/^(w|wk|wks|week|weeks)$/, 7 * DAY],
  [/^(mo|mon|mos|month|months)$/, 30 * DAY],
  [/^(y|yr|yrs|year|years)$/, 365 * DAY],
];

/** "3 hours ago", "2 days, 4 hours", "1 week", "Last Month", "just now" → time, or null. */
export function fromTimeAgo(text: string, now: number): number | null {
  const s = text.toLowerCase().replace(/\bago\b|\band\b|,/g, ' ').replace(/\blast\b/g, '1').replace(/\ban?\b/g, '1').trim();
  if (/^(now|just now|moments?|seconds?)$/.test(s)) return now;
  let total = 0;
  let found = false;
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+)/g)) {
    const span = SPANS.find(([re]) => re.test(m[2]!));
    if (!span) continue;
    total += Number.parseFloat(m[1]!) * span[1];
    found = true;
  }
  return found ? now - total : null;
}

/** "Today 12:30", "Yesterday", "Today" (and the time if any), else null. */
export function fromFuzzy(text: string, now: number): number | null {
  const s = text.toLowerCase();
  const time = /(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?/.exec(s);
  const base = new Date(now);
  base.setUTCHours(0, 0, 0, 0);
  let day: number | null = null;
  if (/\btoday\b/.test(s)) day = base.getTime();
  else if (/\byesterday\b/.test(s)) day = base.getTime() - DAY;
  else if (/\btomorrow\b/.test(s)) day = base.getTime() + DAY;
  if (day === null) return fromTimeAgo(s, now);
  if (!time) return day;
  let h = Number(time[1]) % 24;
  if (time[4] === 'pm' && h < 12) h += 12;
  if (time[4] === 'am' && h === 12) h = 0;
  return day + h * HOUR + Number(time[2]) * MINUTE + Number(time[3] ?? 0) * 1000;
}

/** Whatever a site gives as a date: Unix time, ISO or RFC dates, "x ago", "Today 12:30". */
export function fromUnknown(text: string | null | undefined, now: number): number | null {
  if (text == null) return null;
  const s = text.trim();
  if (!s) return null;
  if (/^\d{9,10}$/.test(s)) return Number(s) * 1000;
  if (/^\d{12,13}$/.test(s)) return Number(s);
  if (/^now$/i.test(s)) return now;
  const iso = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?(\.\d+)?$/.test(s) ? `${s.replace(' ', 'T')}Z` : s;
  const parsed = Date.parse(iso);
  if (!Number.isNaN(parsed)) return parsed;
  return fromFuzzy(s, now);
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const GO_REFERENCE = /2006|\b06\b|January|Jan|Monday|Mon\b|\b01\b|\b02\b|\b15\b|\b04\b|\b05\b|_2|-0700|-07:00|MST/;

type Tok = { kind: 'year4' | 'year2' | 'monthName' | 'month' | 'day' | 'hour24' | 'hour12' | 'minute' | 'second' | 'fraction' | 'ampm' | 'zone' | 'weekday' } | { kind: 'lit'; text: string };

const GO_TOKENS: [string, Exclude<Tok['kind'], 'lit'>][] = [
  ['January', 'monthName'], ['Monday', 'weekday'], ['2006', 'year4'], ['-07:00', 'zone'], ['-0700', 'zone'], ['Z07:00', 'zone'], ['MST', 'zone'],
  ['Jan', 'monthName'], ['Mon', 'weekday'], ['.000', 'fraction'], ['06', 'year2'], ['01', 'month'], ['02', 'day'], ['_2', 'day'], ['15', 'hour24'], ['03', 'hour12'],
  ['04', 'minute'], ['05', 'second'], ['PM', 'ampm'], ['pm', 'ampm'], ['1', 'month'], ['2', 'day'], ['3', 'hour12'], ['4', 'minute'], ['5', 'second'],
];
const NET_TOKENS: [string, Exclude<Tok['kind'], 'lit'>][] = [
  ['dddd', 'weekday'], ['ddd', 'weekday'], ['yyyy', 'year4'], ['MMMM', 'monthName'], ['MMM', 'monthName'], ['fff', 'fraction'], ['zzz', 'zone'],
  ['yy', 'year2'], ['MM', 'month'], ['dd', 'day'], ['HH', 'hour24'], ['hh', 'hour12'], ['mm', 'minute'], ['ss', 'second'], ['tt', 'ampm'], ['zz', 'zone'],
  ['M', 'month'], ['d', 'day'], ['H', 'hour24'], ['h', 'hour12'], ['m', 'minute'], ['s', 'second'], ['t', 'ampm'], ['z', 'zone'], ['K', 'zone'],
];

function tokenize(layout: string): Tok[] {
  const table = GO_REFERENCE.test(layout) ? GO_TOKENS : NET_TOKENS;
  const out: Tok[] = [];
  let i = 0;
  while (i < layout.length) {
    if (table === NET_TOKENS && (layout[i] === '"' || layout[i] === "'")) {
      const end = layout.indexOf(layout[i]!, i + 1);
      out.push({ kind: 'lit', text: layout.slice(i + 1, end < 0 ? undefined : end) });
      i = end < 0 ? layout.length : end + 1;
      continue;
    }
    if (table === NET_TOKENS && layout[i] === '\\') {
      out.push({ kind: 'lit', text: layout[i + 1] ?? '' });
      i += 2;
      continue;
    }
    const hit = table.find(([t]) => layout.startsWith(t, i));
    if (hit) {
      out.push({ kind: hit[1] });
      i += hit[0].length;
    } else {
      out.push({ kind: 'lit', text: layout[i]! });
      i++;
    }
  }
  return out;
}

const PART: Record<Exclude<Tok['kind'], 'lit'>, string> = {
  year4: '(\\d{4})', year2: '(\\d{2})', monthName: '([A-Za-z]+)\\.?', month: '(\\d{1,2})', day: '\\s?(\\d{1,2})', hour24: '(\\d{1,2})', hour12: '(\\d{1,2})',
  minute: '(\\d{1,2})', second: '(\\d{1,2})', fraction: '\\.?(\\d+)', ampm: '([AaPp]\\.?[Mm]\\.?)', zone: '(Z|[+-]\\d{2}:?\\d{2}|[A-Z]{2,5})', weekday: '([A-Za-z]+)',
};

/** Reads a date written in a Go or .NET layout ("2006-01-02 15:04", "MMM. d yy"). Times without a zone are UTC. */
export function parseDateLayout(text: string, layout: string, now: number): number | null {
  const toks = tokenize(layout);
  const re = new RegExp(`^\\s*${toks.map((t) => (t.kind === 'lit' ? t.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*') : PART[t.kind])).join('')}\\s*$`, 'i');
  const m = re.exec(text.trim().replace(/(\d)(st|nd|rd|th)\b/g, '$1'));
  if (!m) return null;
  const today = new Date(now);
  let year = today.getUTCFullYear();
  let month = 0;
  let day = 1;
  let hour = 0;
  let minute = 0;
  let second = 0;
  let pm: boolean | null = null;
  let offset = 0;
  let hadYear = false;
  let g = 1;
  for (const t of toks) {
    if (t.kind === 'lit') continue;
    const v = m[g++]!;
    switch (t.kind) {
      case 'year4': year = Number(v); hadYear = true; break;
      case 'year2': year = 2000 + Number(v); hadYear = true; break;
      case 'monthName': {
        const i = MONTHS.indexOf(v.slice(0, 3).toLowerCase());
        if (i < 0) return null;
        month = i;
        break;
      }
      case 'month': month = Number(v) - 1; break;
      case 'day': day = Number(v); break;
      case 'hour24': case 'hour12': hour = Number(v); break;
      case 'minute': minute = Number(v); break;
      case 'second': second = Number(v); break;
      case 'ampm': pm = /^p/i.test(v); break;
      case 'zone': {
        const z = /^([+-])(\d{2}):?(\d{2})$/.exec(v);
        if (z) offset = (z[1] === '-' ? -1 : 1) * (Number(z[2]) * 60 + Number(z[3])) * MINUTE;
        break;
      }
      default: break;
    }
  }
  if (pm === true && hour < 12) hour += 12;
  if (pm === false && hour === 12) hour = 0;
  let t = Date.UTC(year, month, day, hour, minute, second) - offset;
  // No year given and the date would be in the future: it's from last year.
  if (!hadYear && t > now + DAY) t = Date.UTC(year - 1, month, day, hour, minute, second) - offset;
  return Number.isNaN(t) ? null : t;
}
