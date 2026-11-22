import type { JobView } from '@marquee/shared';
import { getSetting, setSetting, type Db } from '../db/index.js';
import { scrub } from './logs.js';

/**
 * Every background job Marquee runs, in one list: what it does, when it last
 * ran and how that went, when it runs next, and a Run now button. Jobs run
 * one at a time each (a job that's still running is never started twice).
 * The last run is kept in settings, so it survives a restart.
 */

export interface JobSpec {
  id: string;
  label: string;
  /** One plain sentence: what it does. */
  description: string;
  /** How often it runs by itself; null runs only when someone presses Run now. */
  everyMs: number | null;
  /** How long after Marquee starts before the first run. Defaults to `everyMs`. */
  firstAfterMs?: number;
  /** A plain reason it's off right now (it then doesn't run by itself), or null when it's on. */
  off?: () => string | null;
  /** Does the work once. Returns a short summary for "Last run" (or nothing: "Done"). */
  run: () => Promise<string | null | void>;
}

interface LastRun {
  startedAt: number;
  finishedAt: number | null;
  ok: boolean | null;
  message: string | null;
}

const KEY = (id: string) => `job.${id}`;

export class JobError extends Error {}

export class Jobs {
  private specs = new Map<string, JobSpec>();
  private running = new Map<string, Promise<LastRun>>();
  /** When each job last started in this run of Marquee (drives "next run"). */
  private startedHere = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private readonly bootAt: number;

  constructor(
    private db: Db,
    private now: () => number,
  ) {
    this.bootAt = now();
  }

  add(spec: JobSpec): this {
    this.specs.set(spec.id, spec);
    return this;
  }

  has(id: string): boolean {
    return this.specs.has(id);
  }

  /** Checks every few seconds for jobs that are due. */
  start(everyMs = 15_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), everyMs);
    this.timer.unref();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Starts every job that's due and waits for them. */
  async tick(): Promise<void> {
    const due = [...this.specs.values()].filter((s) => {
      if (this.running.has(s.id) || s.everyMs === null) return false;
      if (s.off?.()) return false;
      const next = this.nextAt(s);
      return next !== null && next <= this.now();
    });
    await Promise.all(due.map((s) => this.run(s.id).catch(() => {})));
  }

  /** Runs a job now. A job that's already running is joined, not started again. */
  run(id: string): Promise<LastRun> {
    const spec = this.specs.get(id);
    if (!spec) throw new JobError('There’s no job with that name.');
    const already = this.running.get(id);
    if (already) return already;
    const startedAt = this.now();
    this.startedHere.set(id, startedAt);
    this.save(id, { startedAt, finishedAt: null, ok: null, message: null });
    const p = (async (): Promise<LastRun> => {
      let last: LastRun;
      try {
        const message = (await spec.run()) || null;
        last = { startedAt, finishedAt: this.now(), ok: true, message };
      } catch (err) {
        const message = scrub((err as Error).message || 'Something went wrong.');
        console.error(`[${id}] failed: ${message}`);
        last = { startedAt, finishedAt: this.now(), ok: false, message };
      } finally {
        this.running.delete(id);
      }
      this.save(id, last);
      return last;
    })();
    this.running.set(id, p);
    return p;
  }

  isRunning(id: string): boolean {
    return this.running.has(id);
  }

  /** Why a job is off, or null. */
  offReason(id: string): string | null {
    return this.specs.get(id)?.off?.() ?? null;
  }

  list(): JobView[] {
    return [...this.specs.values()].map((s) => {
      const last = this.last(s.id);
      const running = this.running.has(s.id);
      const off = s.off?.() ?? null;
      const tone: JobView['tone'] = running ? 'busy' : off ? 'off' : last?.ok === false ? 'problem' : 'ok';
      return {
        id: s.id,
        label: s.label,
        description: s.description,
        every: every(s.everyMs),
        tone,
        running,
        off,
        lastStartedAt: last?.startedAt ?? null,
        lastFinishedAt: last?.finishedAt ?? null,
        lastOk: last?.ok ?? null,
        lastMessage: last?.message ?? (last && last.ok === null && !running ? 'Marquee stopped before it finished.' : null),
        nextAt: off ? null : this.nextAt(s),
      };
    });
  }

  private nextAt(s: JobSpec): number | null {
    if (s.everyMs === null) return null;
    const here = this.startedHere.get(s.id);
    return here !== undefined ? here + s.everyMs : this.bootAt + (s.firstAfterMs ?? s.everyMs);
  }

  private last(id: string): LastRun | null {
    try {
      return JSON.parse(getSetting(this.db, KEY(id)) || 'null') as LastRun | null;
    } catch {
      return null;
    }
  }

  private save(id: string, last: LastRun): void {
    setSetting(this.db, KEY(id), JSON.stringify(last));
  }
}

/** "Every 5 minutes", "Every 6 hours", "Every day", "Only when you ask". */
export function every(ms: number | null): string {
  if (ms === null) return 'Only when you ask';
  if (ms < 60_000) return `Every ${Math.round(ms / 1000)} seconds`;
  const min = Math.round(ms / 60_000);
  if (min === 1) return 'Every minute';
  if (min < 60) return `Every ${min} minutes`;
  const h = Math.round(min / 60);
  if (h === 1) return 'Every hour';
  if (h < 24) return `Every ${h} hours`;
  const d = Math.round(h / 24);
  return d === 1 ? 'Every day' : `Every ${d} days`;
}
