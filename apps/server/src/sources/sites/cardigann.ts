import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import { TorznabError, type Release, type SearchQuery, type TorznabApi, type TorznabCaps } from '../torznab.js';
import { categoryMap, siteCategories, type CategoryMap, type Definition, type SearchPath, type SelectorBlock } from './definition.js';
import { applyFilters } from './filters.js';
import { parseCookieHeader, type SiteHttp, type SiteResponse } from './http.js';
import { applyTemplate, urlEncode, type Vars } from './template.js';
import { fromUnknown, parseBytes, parseCount } from './text.js';

/**
 * Runs a site from its definition file: signs in the way the file says,
 * builds the search addresses from its templates, and reads each result row
 * into a copy. Copies that need the site's cookies (or a trip to the copy's
 * page) to download carry a `resolveDownload` that does that later.
 *
 * Behaves like Prowlarr's Cardigann engine, which the files are written for.
 */

/** Fields that may be missing without the row being thrown away. */
const OPTIONAL = new Set(['imdb', 'imdbid', 'tmdbid', 'rageid', 'tvdbid', 'tvmazeid', 'traktid', 'doubanid', 'poster', 'banner', 'description', 'genre', 'files', 'grabs', 'date', 'leechers', 'minimumratio', 'minimumseedtime', 'downloadvolumefactor', 'uploadvolumefactor', 'year', 'categorydesc', 'details', 'comments', 'infohash', 'magnet', 'download']);

export interface SiteSettingsValues {
  [name: string]: string | string[] | boolean | null | undefined;
}

export interface CardigannOptions {
  def: Definition;
  settings: SiteSettingsValues;
  /** The address chosen for the site, from its links. */
  baseUrl: string;
  http: SiteHttp;
  now: () => number;
  /** Waits between requests when a search takes several (the file's requestDelay). */
  sleep: (ms: number) => Promise<void>;
}

type Row = { kind: 'html'; $: CheerioAPI; el: Cheerio<any> } | { kind: 'json'; obj: unknown; parent: unknown };

export class CardigannSite implements TorznabApi {
  private readonly def: Definition;
  private readonly cats: CategoryMap;
  private readonly base: string;
  private signedIn = false;

  constructor(private readonly o: CardigannOptions) {
    this.def = o.def;
    this.cats = categoryMap(o.def);
    this.base = o.baseUrl.endsWith('/') ? o.baseUrl : `${o.baseUrl}/`;
  }

  // ---------------------------------------------------------------- what it can do

  async caps(): Promise<TorznabCaps> {
    const modes = this.def.caps.modes ?? {};
    const tv = modes['tv-search'] ?? [];
    const movie = modes['movie-search'] ?? [];
    return {
      movieSearch: { available: !!modes['movie-search'], tmdbId: movie.includes('tmdbid'), imdbId: movie.includes('imdbid') },
      tvSearch: { available: !!modes['tv-search'], tvdbId: tv.includes('tvdbid'), tmdbId: tv.includes('tmdbid'), imdbId: tv.includes('imdbid'), season: tv.includes('season'), episode: tv.includes('ep') },
      categories: [...new Set([...this.cats.toStandard.values()].flat())],
    };
  }

  // ---------------------------------------------------------------- variables

  private configVars(): Vars {
    const vars: Vars = { '.Config.sitelink': this.base, '.True': 'True', '.False': null, '.Today.Year': String(new Date(this.o.now()).getUTCFullYear()) };
    for (const s of this.def.settings ?? []) {
      if (s.type.startsWith('info')) continue;
      const v = this.o.settings[s.name];
      const value = v === undefined || v === null || v === '' ? s.default : v;
      const name = `.Config.${s.name}`;
      if (s.type === 'checkbox') vars[name] = value === true || value === 'true' || value === 'True' ? '.True' : null;
      else if (s.type === 'multi-select') vars[name] = Array.isArray(value) ? value.map(String) : value == null ? [] : [String(value)];
      else vars[name] = value == null ? null : String(value);
    }
    return vars;
  }

  private resolve(path: string, from: string = this.base): string {
    try {
      return new URL(path, from).toString();
    } catch {
      return path;
    }
  }

  private headers(spec: Record<string, string[] | string> | undefined, vars: Vars): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(spec ?? {})) out[k] = applyTemplate(Array.isArray(v) ? v[0] : v, vars);
    return out;
  }

  // ---------------------------------------------------------------- signing in

  private async signIn(): Promise<void> {
    const login = this.def.login;
    if (!login) return;
    const vars = this.configVars();
    const method = login.method ?? 'form';
    const headers = this.headers(login.headers, vars);
    const http = this.o.http;
    if (method === 'cookie') {
      const cookie = String(this.o.settings.cookie ?? '');
      if (!cookie.trim()) throw new TorznabError('sign_in_failed', 'Paste the cookie from your browser into the site’s settings.');
      http.setCookies(parseCookieHeader(cookie), true);
    } else {
      http.clearCookies();
      for (const c of login.cookies ?? []) http.setCookies(parseCookieHeader(c));
      const inputs = Object.fromEntries(Object.entries(login.inputs ?? {}).map(([k, v]) => [k, applyTemplate(v, vars)]));
      let res: SiteResponse;
      if (method === 'form') {
        const page = await http.request({ url: this.resolve(login.path ?? ''), headers });
        const $ = load(page.body);
        const form = $(login.form ?? 'form').first();
        if (!form.length) throw new TorznabError('sign_in_failed', 'Couldn’t find the sign-in form on the site. Its page may have changed; the catalogue usually catches up within a day.');
        const fields: Record<string, string> = {};
        form.find('input[name]').each((_, el) => {
          const e = $(el);
          const type = (e.attr('type') ?? 'text').toLowerCase();
          if ((type === 'checkbox' || type === 'radio') && e.attr('checked') === undefined) return;
          if (type === 'submit' || type === 'image') return;
          fields[e.attr('name')!] = e.attr('value') ?? '';
        });
        for (const [k, sel] of Object.entries(login.selectorinputs ?? {})) fields[k] = this.htmlValue($, $.root(), sel, vars, true) ?? '';
        Object.assign(fields, inputs);
        const action = login.submitpath ? this.resolve(login.submitpath) : this.resolve(form.attr('action') ?? '', page.url);
        const post = (form.attr('method') ?? 'post').toLowerCase() !== 'get';
        const body = new URLSearchParams(fields).toString();
        res = post
          ? await http.request({ url: action, method: 'POST', headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded', Referer: page.url }, body })
          : await http.request({ url: `${action}${action.includes('?') ? '&' : '?'}${body}`, headers });
      } else if (method === 'post') {
        res = await http.request({ url: this.resolve(login.path ?? ''), method: 'POST', headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(inputs).toString() });
      } else {
        const qs = new URLSearchParams(inputs).toString();
        const url = this.resolve(login.path ?? '');
        res = await http.request({ url: qs ? `${url}${url.includes('?') ? '&' : '?'}${qs}` : url, headers });
      }
      this.checkLoginErrors(res, vars);
    }
    if (login.test?.path !== undefined || login.test?.selector) {
      const test = await http.request({ url: this.resolve(applyTemplate(login.test?.path ?? '', vars)), headers });
      if (test.status === 401 || test.status === 403) throw new TorznabError('sign_in_failed', method === 'cookie' ? 'The site turned down the cookie. Copy a fresh one from your browser.' : 'The site turned down the sign-in.');
      if (login.test?.selector && !load(test.body)(applyTemplate(login.test.selector, vars)).length) {
        throw new TorznabError('sign_in_failed', method === 'cookie' ? 'The site doesn’t see you as signed in with that cookie. Copy a fresh one from your browser (and its user agent, if asked).' : 'Signed in, but the site doesn’t show you as signed in. Check the username and password.');
      }
    }
    this.signedIn = true;
  }

  private checkLoginErrors(res: SiteResponse, vars: Vars): void {
    if (res.status === 401 || res.status === 403) throw new TorznabError('sign_in_failed', 'The site turned down the sign-in. Check the username and password.');
    const $ = load(res.body);
    for (const e of this.def.login?.error ?? []) {
      const hit = $(applyTemplate(e.selector, vars)).first();
      if (!hit.length) continue;
      const message = e.message ? this.htmlValue($, $.root(), e.message, vars, true) : hit.text().trim();
      throw new TorznabError('sign_in_failed', `The site said: ${(message || 'the sign-in failed').replace(/\s+/g, ' ').slice(0, 300)}`);
    }
  }

  private async ensureSignedIn(): Promise<void> {
    if (!this.def.login || this.signedIn) return;
    // Cookies from last time usually still work; only sign in again if they don't.
    if (this.def.login.method !== 'cookie' && Object.keys(this.o.http.session.cookies).length) {
      this.signedIn = true;
      return;
    }
    await this.signIn();
  }

  /** The search page looks like a sign-in page: the session ran out. */
  private looksSignedOut(res: SiteResponse & { redirects: string[] }): boolean {
    const login = this.def.login;
    if (!login) return false;
    const loginPath = login.path ? this.resolve(login.path).split('?')[0]! : null;
    if (loginPath && res.redirects.some((r) => r.split('?')[0] === loginPath)) return true;
    if (res.redirects.some((r) => /\/login(\.php)?\b/i.test(r))) return true;
    return false;
  }

  // ---------------------------------------------------------------- searching

  private queryVars(query: SearchQuery): { vars: Vars; kind: 'movie' | 'tv' } {
    const vars = this.configVars();
    const modes = this.def.caps.modes ?? {};
    let kind: 'movie' | 'tv' = 'movie';
    let q = '';
    let episode = '';
    if (query.kind === 'recent') {
      kind = query.for ?? 'movie';
    } else if (query.kind === 'movie') {
      const m = modes['movie-search'] ?? [];
      q = query.title;
      if (query.year) vars['.Query.Year'] = String(query.year);
      if (m.includes('imdbid') && query.imdbId) {
        vars['.Query.IMDBID'] = query.imdbId;
        vars['.Query.IMDBIDShort'] = query.imdbId.replace(/^tt/, '');
      }
      if (m.includes('tmdbid') && query.tmdbId) vars['.Query.TMDBID'] = String(query.tmdbId);
    } else {
      kind = 'tv';
      const t = modes['tv-search'] ?? [];
      q = query.title;
      if (query.season !== undefined) {
        vars['.Query.Season'] = String(query.season);
        episode = `S${String(query.season).padStart(2, '0')}`;
        if (query.episode !== undefined) {
          vars['.Query.Ep'] = String(query.episode);
          episode += `E${String(query.episode).padStart(2, '0')}`;
        }
        vars['.Query.Episode'] = episode;
      }
      if (t.includes('imdbid') && query.imdbId) {
        vars['.Query.IMDBID'] = query.imdbId;
        vars['.Query.IMDBIDShort'] = query.imdbId.replace(/^tt/, '');
      }
      if (t.includes('tvdbid') && query.tvdbId) vars['.Query.TVDBID'] = String(query.tvdbId);
      if (t.includes('tmdbid') && query.tmdbId) vars['.Query.TMDBID'] = String(query.tmdbId);
    }
    vars['.Query.Q'] = q;
    const keywords = [q, query.kind === 'movie' && query.year ? String(query.year) : '', episode].filter(Boolean).join(' ');
    vars['.Query.Keywords'] = keywords;
    vars['.Keywords'] = applyFilters(keywords, this.def.search.keywordsfilters, vars, this.o.now()) ?? '';
    return { vars, kind };
  }

  async search(query: SearchQuery): Promise<Release[]> {
    await this.ensureSignedIn();
    try {
      return await this.searchOnce(query);
    } catch (err) {
      if (!(err instanceof SignedOut) || this.def.login?.method === 'cookie') {
        if (err instanceof SignedOut) throw new TorznabError('sign_in_failed', 'The site signed Marquee out. Copy a fresh cookie from your browser.');
        throw err;
      }
      // Signed out since last time: sign in again and try once more.
      await this.signIn();
      try {
        return await this.searchOnce(query);
      } catch (again) {
        if (again instanceof SignedOut) throw new TorznabError('sign_in_failed', 'The site keeps sending Marquee to its sign-in page. Check the username and password.');
        throw again;
      }
    }
  }

  private async searchOnce(query: SearchQuery): Promise<Release[]> {
    const { vars, kind } = this.queryVars(query);
    const search = this.def.search;
    let mapped = siteCategories(this.cats, kind);
    if (!mapped.length) mapped = this.cats.defaults;
    const out: Release[] = [];
    const seen = new Set<string>();
    const urls = new Set<string>();
    let first = true;
    for (const path of search.paths ?? []) {
      const cats = this.pathCategories(path, mapped);
      if (cats === null) continue;
      vars['.Categories'] = cats;
      const req = this.buildRequest(path, vars);
      if (req.method === 'GET' && urls.has(req.url)) continue;
      urls.add(req.url);
      if (!first && this.def.requestDelay) await this.o.sleep(this.def.requestDelay * 1000);
      first = false;
      const res = await this.o.http.request(req, true);
      if (this.looksSignedOut(res)) throw new SignedOut();
      this.checkStatus(res);
      const rows = path.response?.type === 'json' ? this.parseJson(res, vars, path) : this.parseHtml(res, vars);
      for (const r of rows) {
        const key = r.guid || r.downloadUrl;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(r);
      }
    }
    return out;
  }

  /** The categories to send for this path, or null to skip it (Prowlarr's rules). */
  private pathCategories(path: SearchPath, mapped: string[]): string[] | null {
    if (!path.categories?.length || !mapped.length) return mapped;
    const list = path.categories.map(String);
    const negate = list[0] === '!';
    const hit = mapped.some((c) => list.includes(c));
    if (negate ? hit : !hit) return null;
    return negate ? mapped.filter((c) => !list.includes(c)) : mapped.filter((c) => list.includes(c));
  }

  private buildRequest(path: SearchPath, vars: Vars): { url: string; method: 'GET' | 'POST'; headers: Record<string, string>; body?: string } {
    const search = this.def.search;
    let url = this.resolve(applyTemplate(path.path, vars, urlEncode));
    const method = applyTemplate(path.method ?? 'get', vars).toLowerCase() === 'post' ? 'POST' : 'GET';
    const params: [string, string][] = [];
    const inputs = [...(path.inheritinputs !== false ? [search.inputs ?? {}] : []), path.inputs ?? {}];
    for (const set of inputs) {
      for (const [k, v] of Object.entries(set)) {
        if (k === '$raw') {
          for (const part of applyTemplate(v, vars, urlEncode).split('&')) {
            const [key, ...rest] = part.split('=');
            if (key) params.push([decodeURIComponent(key), decodeURIComponent(rest.join('='))]);
          }
          continue;
        }
        const value = applyTemplate(v, vars);
        if (value.trim() || search.allowEmptyInputs) params.push([k, value]);
      }
    }
    const headers = this.headers(search.headers, vars);
    const qs = params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    if (method === 'GET') {
      if (qs) url += `${url.includes('?') ? '&' : '?'}${qs}`;
      return { url, method, headers };
    }
    return { url, method, headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body: qs };
  }

  private checkStatus(res: SiteResponse): void {
    if (res.status === 429) throw new TorznabError('slowed_down', 'The site asked Marquee to slow down.', Number(res.headers['retry-after']) || undefined);
    if (res.status === 401 || res.status === 403) throw new TorznabError(this.def.login ? 'sign_in_failed' : 'error', `The site turned the search down (${res.status}).`);
    if (res.status >= 500) throw new TorznabError('unreachable', `The site is having trouble (it answered ${res.status}).`);
    if (res.status >= 400) throw new TorznabError('error', `The site answered ${res.status} to the search. Its address may have changed; try another under the site’s settings.`);
  }

  // ---------------------------------------------------------------- reading results

  private htmlValue($: CheerioAPI, scope: Cheerio<any>, block: SelectorBlock, vars: Vars, required: boolean): string | null {
    if (block.text !== undefined) return applyFilters(applyTemplate(block.text, vars), block.filters, vars, this.o.now());
    let sel = scope;
    if (block.selector) {
      const s = applyTemplate(block.selector, vars);
      sel = s.startsWith(':root') ? $(s.replace(/^:root\s*/, '') || ':root').first() : scope.find(s).first();
      if (!sel.length) {
        if (required) throw new FieldMissing(`Nothing matched “${s}”`);
        return null;
      }
    }
    if (block.remove) {
      sel = sel.clone();
      sel.find(applyTemplate(block.remove, vars)).remove();
    }
    let value: string | null;
    if (block.case) {
      value = null;
      for (const [key, v] of Object.entries(block.case)) {
        if (key === '*' || sel.is(key) || sel.find(key).length) {
          value = applyTemplate(v, vars);
          break;
        }
      }
      if (value === null) {
        if (required) throw new FieldMissing('None of the cases matched');
        return null;
      }
    } else if (block.attribute) {
      value = sel.attr(block.attribute) ?? null;
      if (value === null) {
        if (required) throw new FieldMissing(`No “${block.attribute}” attribute`);
        return null;
      }
    } else {
      value = sel.text();
    }
    return applyFilters(value.trim(), block.filters, vars, this.o.now());
  }

  private parseHtml(res: SiteResponse, vars: Vars): Release[] {
    const search = this.def.search;
    const $ = load(res.body);
    for (const e of search.error ?? []) {
      const hit = $(applyTemplate(e.selector, vars)).first();
      if (hit.length) throw new TorznabError('error', `The site said: ${(e.message ? this.htmlValue($, $.root(), e.message, vars, false) : hit.text()) ?? ''}`.trim().slice(0, 300));
    }
    let rows = $(applyTemplate(search.rows.selector ?? '', vars)).toArray();
    const after = search.rows.after ?? 0;
    const elements: Cheerio<any>[] = [];
    for (let i = 0; i < rows.length; i++) {
      const row = $(rows[i]!).clone();
      // "after": the row's details continue in the next few rows; join them.
      for (let j = 1; j <= after && i + j < rows.length; j++) row.append($(rows[i + j]!).clone().children());
      elements.push(row);
      i += after;
    }
    rows = [];
    const andmatch = (search.rows.filters ?? []).some((f) => f.name === 'andmatch');
    return this.readRows(elements.map((el) => ({ kind: 'html' as const, $, el })), vars, res.url, andmatch);
  }

  private parseJson(res: SiteResponse, vars: Vars, path: SearchPath): Release[] {
    const search = this.def.search;
    const body = res.body.trim();
    const noResults = path.response?.noResultsMessage;
    if (noResults !== undefined && (noResults ? body.includes(noResults) : !body)) return [];
    let doc: unknown;
    try {
      doc = JSON.parse(body);
    } catch {
      throw new TorznabError('error', 'The site answered with something Marquee couldn’t read (not JSON).');
    }
    if (search.rows.count?.selector) {
      const count = Number(jsonGet(doc, applyTemplate(search.rows.count.selector, vars)));
      if (Number.isFinite(count) && count < 1) return [];
    }
    const rowSel = applyTemplate(search.rows.selector ?? '', vars);
    const [pathPart, ...filters] = splitJsonFilters(rowSel);
    const list = pathPart ? jsonGet(doc, pathPart) : doc;
    if (!Array.isArray(list)) {
      if (search.rows.missingAttributeEqualsNoResults || list == null) return [];
      throw new TorznabError('error', 'The site’s answer didn’t have the list of copies where its file says.');
    }
    const rows: Row[] = [];
    for (const item of list) {
      if (!jsonFiltersMatch(item, filters)) continue;
      let sel: unknown = item;
      if (search.rows.attribute) {
        sel = jsonGet(item, search.rows.attribute);
        if (sel == null) continue;
      }
      const many = search.rows.multiple ? (Array.isArray(sel) ? sel : Object.values(sel as object)) : [sel];
      for (const m of many) rows.push({ kind: 'json', obj: m, parent: item });
    }
    return this.readRows(rows, vars, res.url, false);
  }

  private jsonValue(row: Extract<Row, { kind: 'json' }>, block: SelectorBlock, vars: Vars, required: boolean): string | null {
    if (block.text !== undefined) return applyFilters(applyTemplate(block.text, vars), block.filters, vars, this.o.now());
    let value: string | null = null;
    if (block.selector) {
      const s = applyTemplate(block.selector, vars);
      const fromParent = s.startsWith('..');
      const [p, ...filters] = splitJsonFilters(s.replace(/^\.+/, ''));
      const scope = fromParent ? row.parent : row.obj;
      const hit = p ? jsonGet(scope, p) : scope;
      if (hit == null || !jsonFiltersMatch(hit, filters)) {
        if (required) throw new FieldMissing(`Nothing at “${s}”`);
        return null;
      }
      value = Array.isArray(hit) ? hit.join(',') : typeof hit === 'object' ? JSON.stringify(hit) : String(hit);
    }
    if (block.case) {
      const match = Object.entries(block.case).find(([k]) => k === value || k === '*');
      if (!match) {
        if (required) throw new FieldMissing('None of the cases matched');
        return null;
      }
      value = applyTemplate(match[1], vars);
    }
    return applyFilters(value === null ? null : value.trim(), block.filters, vars, this.o.now());
  }

  private readRows(rows: Row[], baseVars: Vars, pageUrl: string, andmatch: boolean): Release[] {
    const out: Release[] = [];
    let firstError: string | null = null;
    const keywords = String(baseVars['.Query.Keywords'] ?? '');
    for (const row of rows) {
      const vars: Vars = { ...baseVars };
      const r: Partial<Release> & { magnet?: string; download?: string; title?: string } = { categories: [] };
      let leechers: number | null = null;
      try {
        for (const [key, block] of Object.entries(this.def.search.fields)) {
          const [name, ...mods] = key.split('|');
          const optional = !!block?.optional || mods.includes('optional') || OPTIONAL.has(name!) || name!.startsWith('_');
          let value = row.kind === 'html' ? this.htmlValue(row.$, row.el, block ?? {}, vars, !optional) : this.jsonValue(row, block ?? {}, vars, !optional);
          if (optional && (value === null || value === '')) {
            const fallback = block?.default !== undefined ? applyTemplate(block.default, vars) : '';
            if (!fallback) {
              vars[`.Result.${name}`] = null;
              continue;
            }
            value = fallback;
          }
          vars[`.Result.${name}`] = this.setField(r, name!, value ?? '', mods, pageUrl, (n) => (leechers = n));
        }
      } catch (err) {
        if (err instanceof FieldMissing) {
          firstError ??= err.message;
          continue;
        }
        throw err;
      }
      // Some sites only give the info-hash; build a magnet from it, as Prowlarr does.
      if (!r.download && !r.magnet && r.infoHash && /^[a-f0-9]{40}$/i.test(r.infoHash) && r.title) r.magnet = magnetFor(r.infoHash, r.title);
      const link = r.download ?? r.magnet;
      if (!r.title || !link) continue;
      if (andmatch && keywords && !matchesAll(r.title, keywords)) continue;
      const hash = r.infoHash ?? /btih:([a-z0-9]{32,40})/i.exec(r.magnet ?? r.download ?? '')?.[1]?.toLowerCase() ?? null;
      const release: Release = {
        title: r.title,
        size: r.size ?? null,
        seeders: r.seeders ?? null,
        leechers,
        grabs: r.grabs ?? null,
        publishedAt: r.publishedAt ?? null,
        downloadUrl: link,
        infoUrl: r.infoUrl ?? null,
        guid: r.download ?? r.magnet ?? r.infoUrl ?? r.title,
        infoHash: hash,
        categories: [...new Set(r.categories)],
        imdbId: r.imdbId ?? null,
        tmdbId: r.tmdbId ?? null,
        tvdbId: r.tvdbId ?? null,
        freeleech: r.freeleech ?? false,
      };
      if (!link.startsWith('magnet:') || this.def.download?.selectors?.length) release.resolveDownload = () => this.resolveDownload(link, vars);
      out.push(release);
    }
    if (!out.length && rows.length && firstError) throw new TorznabError('error', `Marquee couldn’t read the site’s results (${firstError}). The site may have changed; the catalogue usually catches up within a day.`);
    return out;
  }

  /** Puts one field's value on the copy; returns the text later templates see as .Result.<name>. */
  private setField(r: Partial<Release> & { magnet?: string; download?: string }, name: string, value: string, mods: string[], pageUrl: string, setLeechers: (n: number) => void): string {
    switch (name) {
      case 'title':
        r.title = mods.includes('append') ? (r.title ?? '') + value : value;
        return r.title;
      case 'download':
        if (value.startsWith('magnet:')) r.magnet = value;
        else r.download = this.resolve(value, pageUrl);
        return r.magnet ?? r.download ?? '';
      case 'magnet':
        r.magnet = value;
        return value;
      case 'details':
        r.infoUrl = this.resolve(value, pageUrl);
        return r.infoUrl;
      case 'infohash':
        r.infoHash = value.toLowerCase();
        return value;
      case 'size': {
        r.size = parseBytes(value);
        return String(r.size ?? '');
      }
      case 'seeders': {
        const n = parseCount(value);
        r.seeders = n !== null && n < 5_000_000 ? n : 0;
        return String(r.seeders);
      }
      case 'leechers': {
        const n = parseCount(value) ?? 0;
        setLeechers(n < 5_000_000 ? n : 0);
        return String(n);
      }
      case 'grabs':
        r.grabs = parseCount(value);
        return String(r.grabs ?? '');
      case 'date':
        r.publishedAt = fromUnknown(value, this.o.now());
        return r.publishedAt === null ? value : new Date(r.publishedAt).toISOString();
      case 'category':
      case 'categorydesc': {
        const found = value
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean)
          .flatMap((v) => (name === 'category' ? this.cats.toStandard.get(v) : this.cats.byDesc.get(v.toLowerCase())) ?? []);
        r.categories = mods.includes('noappend') ? found : [...(r.categories ?? []), ...found];
        return value;
      }
      case 'imdb':
      case 'imdbid': {
        const digits = /(\d{5,})/.exec(value)?.[1];
        if (digits) r.imdbId = `tt${digits.padStart(7, '0')}`;
        return value;
      }
      case 'tmdbid':
        r.tmdbId = parseCount(value) || null;
        return value;
      case 'tvdbid':
        r.tvdbId = parseCount(value) || null;
        return value;
      case 'downloadvolumefactor':
        r.freeleech = Number(value) === 0;
        return value;
      default:
        return value;
    }
  }

  // ---------------------------------------------------------------- downloading

  /**
   * The real download for a copy: opens the copy's page when the file says
   * the link is there, and returns the cookies and browser name the site
   * expects (sent only to the site itself).
   */
  async resolveDownload(link: string, vars: Vars): Promise<{ url: string; headers: Record<string, string> }> {
    const http = this.o.http;
    let url = link;
    const selectors = this.def.download?.selectors ?? [];
    if (selectors.length && !link.startsWith('magnet:')) {
      const page = await http.request({ url: link, headers: this.headers(this.def.download?.headers, vars) });
      this.checkStatus(page);
      const $ = load(page.body);
      let found: string | null = null;
      for (const s of selectors) {
        const v = this.htmlValue($, $.root(), s, vars, false);
        if (v) {
          found = v.startsWith('magnet:') ? v : this.resolve(v, page.url);
          break;
        }
      }
      if (!found) throw new TorznabError('error', 'Couldn’t find the download link on the copy’s page. The site may have changed.');
      url = found;
    }
    const cookie = Object.entries(http.session.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
    const headers: Record<string, string> = { 'User-Agent': http.session.userAgent ?? '', ...this.headers(this.def.download?.headers, vars) };
    if (!headers['User-Agent']) delete headers['User-Agent'];
    if (cookie) headers.Cookie = cookie;
    return { url, headers };
  }
}

/** Well-known open trackers, so a magnet built from a bare hash finds people faster than through DHT alone. */
const OPEN_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.torrent.eu.org:451/announce',
];

export function magnetFor(hash: string, title: string): string {
  return `magnet:?xt=urn:btih:${hash.toLowerCase()}&dn=${encodeURIComponent(title)}${OPEN_TRACKERS.map((t) => `&tr=${encodeURIComponent(t)}`).join('')}`;
}

class SignedOut extends Error {}
class FieldMissing extends Error {}

function matchesAll(title: string, keywords: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  const t = ` ${norm(title)} `;
  return norm(keywords)
    .split(' ')
    .filter(Boolean)
    .every((w) => t.includes(` ${w} `) || t.includes(w));
}

// ---------------------------------------------------------------- JSON paths

/** "data.movies", "$[0].id", "torrents[0].hash", "a['b c']" → the value there. */
export function jsonGet(doc: unknown, path: string): unknown {
  const parts: (string | number)[] = [];
  const p = path.replace(/^\$\.?/, '');
  for (const m of p.matchAll(/([^.[\]]+)|\[(\d+)\]|\['([^']*)'\]/g)) parts.push(m[2] !== undefined ? Number(m[2]) : (m[3] ?? m[1])!);
  let cur: unknown = doc;
  for (const part of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string | number, unknown>)[part];
  }
  return cur;
}

/** Splits "data.list:has(seeders):not(dead)" into the path and its filters. */
function splitJsonFilters(sel: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const c of sel) {
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ':' && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function jsonFiltersMatch(obj: unknown, filters: string[]): boolean {
  for (const f of filters) {
    const m = /^(has|not|contains)\((.*)\)$/.exec(f);
    if (!m) continue;
    const arg = m[2]!.replace(/^["']|["']$/g, '');
    if (m[1] === 'contains') {
      if (!JSON.stringify(obj).includes(arg)) return false;
    } else {
      const [p, ...inner] = splitJsonFilters(arg);
      const v = p ? jsonGet(obj, p) : obj;
      const has = v != null && jsonFiltersMatch(v, inner);
      if (m[1] === 'has' ? !has : has) return false;
    }
  }
  return true;
}
