import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { SolverView } from '@marquee/shared';
import { getSetting, setSetting, type Db } from '../../db/index.js';
import type { SolvedPage, SolverApi } from './http.js';

/**
 * Bot-check solving. Marquee speaks FlareSolverr's protocol (`POST /v1`), so
 * any compatible solver works: the one inside Marquee's image (started only
 * when this is turned on), or another one at an address you give under For
 * experts (Byparr, a FlareSolverr container…). Off by default.
 */

const ENABLED = 'solver.enabled';
const URL_KEY = 'solver.url';
const BUNDLED_PORT = 8191;

export interface SolverSettings {
  enabled: boolean;
  url: string | null;
}

export function readSolver(db: Db): SolverSettings {
  return { enabled: getSetting(db, ENABLED) === '1', url: getSetting(db, URL_KEY) || null };
}

export function saveSolver(db: Db, s: SolverSettings): void {
  setSetting(db, ENABLED, s.enabled ? '1' : '0');
  setSetting(db, URL_KEY, s.url ?? '');
}

export class SolverError extends Error {}

/** Talks to a FlareSolverr-compatible solver. */
export class FlareSolverrClient implements SolverApi {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 60_000,
  ) {}

  private async call(body: Record<string, unknown>): Promise<Record<string, any>> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl.replace(/\/+$/, '')}/v1`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs + 15_000),
      });
    } catch (err) {
      const code = (err as { cause?: { code?: string } }).cause?.code;
      throw new SolverError(`Couldn’t reach the solver at ${this.baseUrl}${code ? ` (${code})` : ''}.`);
    }
    let json: Record<string, any>;
    try {
      json = (await res.json()) as Record<string, any>;
    } catch {
      throw new SolverError(`That address answered, but it isn’t a FlareSolverr-compatible solver.`);
    }
    if (json.status !== 'ok') throw new SolverError(String(json.message ?? `The solver answered ${res.status}.`));
    return json;
  }

  async ping(): Promise<string> {
    const json = await this.call({ cmd: 'sessions.list' });
    return String(json.version ?? '');
  }

  async solve(req: { url: string; method: 'GET' | 'POST'; body?: string; cookies: Record<string, string> }): Promise<SolvedPage> {
    const json = await this.call({
      cmd: req.method === 'POST' ? 'request.post' : 'request.get',
      url: req.url,
      maxTimeout: this.timeoutMs,
      cookies: Object.entries(req.cookies).map(([name, value]) => ({ name, value })),
      ...(req.method === 'POST' ? { postData: req.body ?? '' } : {}),
    });
    const s = json.solution ?? {};
    const cookies: Record<string, string> = {};
    for (const c of (s.cookies ?? []) as { name: string; value: string }[]) cookies[c.name] = c.value;
    return { status: Number(s.status) || 200, url: String(s.url ?? req.url), body: String(s.response ?? ''), cookies, userAgent: s.userAgent ? String(s.userAgent) : null };
  }
}

/**
 * The solver inside Marquee's image. Started the first time it's needed
 * after the switch is on, as Marquee's own user, listening only on
 * 127.0.0.1. `MARQUEE_SOLVER_BIN` points at it; installs without one (like
 * running from source) need an address under For experts instead.
 */
export class BundledSolver {
  private child: ChildProcess | null = null;
  private starting: Promise<string> | null = null;
  state: 'off' | 'starting' | 'ready' | 'failed' = 'off';
  message = '';

  constructor(
    private readonly bin: string | null,
    private readonly dataDir: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get available(): boolean {
    return !!this.bin && fs.existsSync(this.bin);
  }

  get url(): string {
    return `http://127.0.0.1:${BUNDLED_PORT}`;
  }

  /** Starts it if needed and waits until it answers. Returns its address. */
  start(): Promise<string> {
    if (this.state === 'ready' && this.child && this.child.exitCode === null) return Promise.resolve(this.url);
    if (this.starting) return this.starting;
    if (!this.available) return Promise.reject(new SolverError('This install has no solver inside it. Give a solver’s address under For experts.'));
    this.state = 'starting';
    this.message = 'Starting the solver…';
    this.starting = (async () => {
      const home = path.join(this.dataDir, 'solver');
      fs.mkdirSync(home, { recursive: true });
      const child = spawn(this.bin!, [], {
        env: { ...process.env, HOME: home, HOST: '127.0.0.1', PORT: String(BUNDLED_PORT), LOG_LEVEL: 'warning', HEADLESS: 'true', TZ: process.env.TZ ?? 'UTC' },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      this.child = child;
      let lastErr = '';
      child.stderr?.on('data', (d: Buffer) => (lastErr = d.toString().trim().split('\n').at(-1) ?? lastErr));
      child.on('exit', (code) => {
        if (this.child === child) {
          this.child = null;
          if (this.state !== 'off') {
            this.state = 'failed';
            this.message = `The solver stopped (exit ${code})${lastErr ? `: ${lastErr}` : ''}. Marquee starts it again when it’s next needed.`;
          }
        }
      });
      const client = new FlareSolverrClient(this.url, this.fetchImpl);
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        if (!this.child) break;
        try {
          await client.ping();
          this.state = 'ready';
          this.message = 'The solver inside Marquee is running.';
          return this.url;
        } catch {
          /* still starting */
        }
      }
      this.stop();
      this.state = 'failed';
      this.message = `The solver didn’t start${lastErr ? `: ${lastErr}` : ''}.`;
      throw new SolverError(this.message);
    })().finally(() => (this.starting = null));
    return this.starting;
  }

  stop(): void {
    const c = this.child;
    this.child = null;
    this.state = 'off';
    this.message = '';
    c?.kill('SIGTERM');
  }
}

/** Which solver to use right now, or null when solving is off. */
export function solverFor(db: Db, bundled: BundledSolver | null, make: (url: string) => SolverApi): () => Promise<SolverApi | null> {
  return async () => {
    const s = readSolver(db);
    if (!s.enabled) return null;
    if (s.url) return make(s.url);
    if (!bundled) return null;
    return make(await bundled.start());
  };
}

export function solverView(db: Db, bundled: BundledSolver | null): SolverView {
  const s = readSolver(db);
  const inside = !!bundled?.available;
  if (!s.enabled) return { enabled: false, url: s.url, bundled: inside, state: 'off', message: 'Off. Sites behind a bot check show “Blocked by a bot check”.' };
  if (s.url) return { enabled: true, url: s.url, bundled: inside, state: 'ready', message: `Using the solver at ${s.url}.` };
  if (!inside) return { enabled: true, url: null, bundled: false, state: 'missing', message: 'This install has no solver inside it (Marquee’s container image has one). Give a solver’s address under For experts.' };
  const state = bundled!.state === 'off' ? 'ready' : bundled!.state;
  return { enabled: true, url: null, bundled: true, state, message: bundled!.message || 'On. The solver inside Marquee starts the first time a site needs it.' };
}
