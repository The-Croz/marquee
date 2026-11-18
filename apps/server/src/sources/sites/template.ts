import { toRegex, toReplacement } from './text.js';

/**
 * The small template language site definitions use, after Go's text/template
 * as Prowlarr reads it: `{{ .Config.sort }}`, `{{ if .Keywords }}…{{ else }}…{{ end }}`,
 * `{{ range .Categories }}cat={{ . }}&{{ end }}`, and the functions and, or,
 * not, eq, ne, join, re_replace and len.
 *
 * Variables are flat: ".Config.sort", ".Result.title", ".Query.IMDBID". An
 * on checkbox is ".True" and an off one is null, as in Prowlarr, so
 * `eq .Config.x .False` is true when x is off.
 */

export type TValue = string | string[] | boolean | null | undefined;
export type Vars = Record<string, TValue>;

export class TemplateError extends Error {}

type Expr =
  | { t: 'var'; name: string }
  | { t: 'dot' }
  | { t: 'local'; name: string }
  | { t: 'lit'; value: string }
  | { t: 'call'; fn: string; args: Expr[] };

type Node =
  | { t: 'text'; text: string }
  | { t: 'print'; expr: Expr }
  | { t: 'if'; branches: { cond: Expr; body: Node[] }[]; otherwise: Node[] }
  | { t: 'range'; expr: Expr; index: string | null; elem: string | null; body: Node[] };

/** How many arguments each function takes, so `and eq .A "x" eq .B "y"` (no brackets) still reads. */
const ARITY: Record<string, number> = { eq: 2, ne: 2, lt: 2, le: 2, gt: 2, ge: 2, not: 1, join: 2, re_replace: 3, len: 1, index: 2 };
const VARIADIC = new Set(['and', 'or', 'print']);

// ---------------------------------------------------------------- parsing

function tokens(src: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
    } else if (c === '(' || c === ')' || c === '|' || c === ',') {
      out.push(c);
      i++;
    } else if (c === '"') {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== '"') {
        // Only \" is an escape: site files put regular expressions in quotes, backslashes and all.
        if (src[j] === '\\' && src[j + 1] === '"') {
          s += '"';
          j += 2;
        } else s += src[j++];
      }
      out.push(`"${s}`);
      i = j + 1;
    } else if (c === '`') {
      const j = src.indexOf('`', i + 1);
      out.push(`"${src.slice(i + 1, j < 0 ? undefined : j)}`);
      i = j < 0 ? src.length : j + 1;
    } else if (src.startsWith(':=', i)) {
      out.push(':=');
      i += 2;
    } else {
      let j = i;
      while (j < src.length && !/[\s()|,"]/.test(src[j]!) && !src.startsWith(':=', j)) j++;
      out.push(src.slice(i, j));
      i = j;
    }
  }
  return out;
}

class ExprParser {
  private i = 0;
  constructor(private readonly toks: string[]) {}

  parse(): Expr {
    const e = this.pipeline();
    if (this.i < this.toks.length) throw new TemplateError(`Unexpected "${this.toks[this.i]}"`);
    return e;
  }

  private pipeline(): Expr {
    let e = this.command();
    while (this.toks[this.i] === '|') {
      this.i++;
      const next = this.command();
      // a | f b  →  f b a
      e = next.t === 'call' ? { ...next, args: [...next.args, e] } : next;
    }
    return e;
  }

  private command(): Expr {
    const tok = this.toks[this.i];
    if (tok && /^[a-z_][a-z_0-9]*$/i.test(tok) && tok !== 'true' && tok !== 'false' && tok !== 'nil') {
      this.i++;
      const args: Expr[] = [];
      const arity = ARITY[tok];
      while (this.i < this.toks.length && this.toks[this.i] !== ')' && this.toks[this.i] !== '|') {
        if (arity !== undefined && args.length >= arity) break;
        args.push(this.argument());
      }
      return { t: 'call', fn: tok, args };
    }
    return this.operand();
  }

  /** An argument: an operand, or a function call written without brackets. */
  private argument(): Expr {
    const tok = this.toks[this.i];
    if (tok && (ARITY[tok] !== undefined || VARIADIC.has(tok))) return this.command();
    return this.operand();
  }

  private operand(): Expr {
    const tok = this.toks[this.i++];
    if (tok === undefined) throw new TemplateError('The template ends too soon');
    if (tok === '(') {
      const e = this.pipeline();
      if (this.toks[this.i++] !== ')') throw new TemplateError('A bracket is not closed');
      return e;
    }
    if (tok.startsWith('"')) return { t: 'lit', value: tok.slice(1) };
    if (tok === '.') return { t: 'dot' };
    if (tok.startsWith('.')) return { t: 'var', name: tok };
    if (tok.startsWith('$')) return { t: 'local', name: tok };
    if (tok === 'true') return { t: 'lit', value: 'True' };
    if (tok === 'false' || tok === 'nil') return { t: 'call', fn: '__null', args: [] };
    if (/^-?\d+(\.\d+)?$/.test(tok)) return { t: 'lit', value: tok };
    throw new TemplateError(`Can't read "${tok}"`);
  }
}

function parseExpr(src: string): Expr {
  return new ExprParser(tokens(src)).parse();
}

type Action = { kind: 'if' | 'elseif' | 'else' | 'end' | 'range' | 'print' | 'comment'; src: string };

function split(template: string): (string | Action)[] {
  const out: (string | Action)[] = [];
  let i = 0;
  while (i < template.length) {
    const open = template.indexOf('{{', i);
    if (open < 0) {
      out.push(template.slice(i));
      break;
    }
    let text = template.slice(i, open);
    let start = open + 2;
    if (template[start] === '-' && /\s/.test(template[start + 1] ?? '')) {
      text = text.replace(/\s+$/, '');
      start++;
    }
    const close = template.indexOf('}}', start);
    if (close < 0) throw new TemplateError('A {{ is not closed');
    let inner = template.slice(start, close);
    let next = close + 2;
    if (/\s-$/.test(inner)) {
      inner = inner.slice(0, -1);
      const m = /^\s*/.exec(template.slice(next))!;
      next += m[0].length;
    }
    if (text) out.push(text);
    const s = inner.trim();
    if (s.startsWith('/*')) out.push({ kind: 'comment', src: '' });
    else if (/^if\b/.test(s)) out.push({ kind: 'if', src: s.slice(2) });
    else if (/^else\s+if\b/.test(s)) out.push({ kind: 'elseif', src: s.replace(/^else\s+if/, '') });
    else if (s === 'else') out.push({ kind: 'else', src: '' });
    else if (s === 'end') out.push({ kind: 'end', src: '' });
    else if (/^range\b/.test(s)) out.push({ kind: 'range', src: s.slice(5) });
    else out.push({ kind: 'print', src: s });
    i = next;
  }
  return out;
}

function build(parts: (string | Action)[]): Node[] {
  let i = 0;
  const block = (stops: Action['kind'][]): { nodes: Node[]; stop: Action | null } => {
    const nodes: Node[] = [];
    while (i < parts.length) {
      const p = parts[i++]!;
      if (typeof p === 'string') {
        nodes.push({ t: 'text', text: p });
        continue;
      }
      if (stops.includes(p.kind)) return { nodes, stop: p };
      if (p.kind === 'comment') continue;
      if (p.kind === 'print') nodes.push({ t: 'print', expr: parseExpr(p.src) });
      else if (p.kind === 'if') {
        const branches: { cond: Expr; body: Node[] }[] = [];
        let cond = parseExpr(p.src);
        let otherwise: Node[] = [];
        for (;;) {
          const b = block(['elseif', 'else', 'end']);
          branches.push({ cond, body: b.nodes });
          if (!b.stop) throw new TemplateError('An {{ if }} has no {{ end }}');
          if (b.stop.kind === 'elseif') {
            cond = parseExpr(b.stop.src);
            continue;
          }
          if (b.stop.kind === 'else') {
            const e = block(['end']);
            if (!e.stop) throw new TemplateError('An {{ else }} has no {{ end }}');
            otherwise = e.nodes;
          }
          break;
        }
        nodes.push({ t: 'if', branches, otherwise });
      } else if (p.kind === 'range') {
        const m = /^\s*(?:(\$\w+)\s*(?:,\s*(\$\w+))?\s*:=)?\s*(.+)$/.exec(p.src)!;
        const [index, elem] = m[2] ? [m[1]!, m[2]] : [null, m[1] ?? null];
        const b = block(['end']);
        if (!b.stop) throw new TemplateError('A {{ range }} has no {{ end }}');
        nodes.push({ t: 'range', expr: parseExpr(m[3]!), index, elem, body: b.nodes });
      } else throw new TemplateError(`Unexpected {{ ${p.kind} }}`);
    }
    return { nodes, stop: null };
  };
  const { nodes, stop } = block([]);
  if (stop) throw new TemplateError(`Unexpected {{ ${stop.kind} }}`);
  return nodes;
}

// ---------------------------------------------------------------- evaluation

export function truthy(v: TValue): boolean {
  if (v == null || v === false) return false;
  if (v === true) return true;
  if (Array.isArray(v)) return v.length > 0;
  return v.trim() !== '';
}

function asText(v: TValue): string | null {
  if (v == null) return null;
  if (v === true) return 'True';
  if (v === false) return null;
  if (Array.isArray(v)) return v.join(' ');
  return v;
}

interface Scope {
  vars: Vars;
  dot: TValue;
  locals: Record<string, TValue>;
}

function evaluate(e: Expr, s: Scope): TValue {
  switch (e.t) {
    case 'lit':
      return e.value;
    case 'dot':
      return s.dot;
    case 'local':
      return s.locals[e.name] ?? null;
    case 'var':
      return s.vars[e.name] ?? null;
    case 'call':
      return call(e.fn, e.args, s);
  }
}

function call(fn: string, args: Expr[], s: Scope): TValue {
  const v = (i: number) => evaluate(args[i]!, s);
  switch (fn) {
    case '__null':
      return null;
    case 'and': {
      let last: TValue = null;
      for (const a of args) {
        last = evaluate(a, s);
        if (!truthy(last)) return last;
      }
      return last;
    }
    case 'or': {
      let last: TValue = null;
      for (const a of args) {
        last = evaluate(a, s);
        if (truthy(last)) return last;
      }
      return last;
    }
    case 'not':
      return !truthy(v(0));
    case 'eq': {
      const first = asText(v(0));
      return args.slice(1).some((_, i) => asText(v(i + 1)) === first);
    }
    case 'ne':
      return asText(v(0)) !== asText(v(1));
    case 'lt':
    case 'le':
    case 'gt':
    case 'ge': {
      const a = Number(asText(v(0)));
      const b = Number(asText(v(1)));
      return fn === 'lt' ? a < b : fn === 'le' ? a <= b : fn === 'gt' ? a > b : a >= b;
    }
    case 'len': {
      const x = v(0);
      return String(Array.isArray(x) ? x.length : (asText(x) ?? '').length);
    }
    case 'index': {
      const x = v(0);
      return Array.isArray(x) ? (x[Number(asText(v(1)))] ?? null) : null;
    }
    case 'join': {
      const x = v(0);
      return (Array.isArray(x) ? x : x == null ? [] : [asText(x) ?? '']).join(asText(v(1)) ?? '');
    }
    case 're_replace': {
      const re = toRegex(asText(v(1)) ?? '', 'g');
      const text = asText(v(0)) ?? '';
      return re ? text.replace(re, toReplacement(asText(v(2)) ?? '')) : text;
    }
    case 'print':
      return args.map((_, i) => asText(v(i)) ?? '').join('');
    default:
      throw new TemplateError(`Unknown function "${fn}"`);
  }
}

function render(nodes: Node[], s: Scope, modifier: ((v: string) => string) | undefined): string {
  let out = '';
  for (const n of nodes) {
    if (n.t === 'text') out += n.text;
    else if (n.t === 'print') {
      const value = asText(evaluate(n.expr, s));
      // Values from variables are encoded for addresses; text written in the template isn't.
      out += value == null ? '' : modifier && n.expr.t !== 'lit' ? modifier(value) : value;
    } else if (n.t === 'if') {
      const hit = n.branches.find((b) => truthy(evaluate(b.cond, s)));
      out += render(hit ? hit.body : n.otherwise, s, modifier);
    } else {
      const list = evaluate(n.expr, s);
      const items = Array.isArray(list) ? list : list == null || list === false ? [] : [asText(list) ?? ''];
      items.forEach((item, i) => {
        const locals = { ...s.locals };
        if (n.index) locals[n.index] = String(i);
        if (n.elem) locals[n.elem] = item;
        out += render(n.body, { vars: s.vars, dot: item, locals }, modifier);
      });
    }
  }
  return out;
}

const cache = new Map<string, Node[]>();

/** Fills in a template. `modifier` encodes values taken from variables (for addresses). */
export function applyTemplate(template: string | number | boolean | null | undefined, vars: Vars, modifier?: (v: string) => string): string {
  if (template == null) return '';
  const src = String(template);
  if (!src.includes('{{')) return src;
  let nodes = cache.get(src);
  if (!nodes) {
    nodes = build(split(src));
    if (cache.size > 5000) cache.clear();
    cache.set(src, nodes);
  }
  return render(nodes, { vars, dot: null, locals: {} }, modifier);
}

/** Encodes a value for an address the way Prowlarr does (spaces as %20). */
export const urlEncode = (v: string) => encodeURIComponent(v).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
