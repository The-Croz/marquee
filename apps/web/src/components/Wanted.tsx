import { useState } from 'react';
import { api, ApiFailure, queryClient } from '../api';
import { Button, cx } from './ui';

/** Tells every screen that shows library data to reload. */
export const refreshLibrary = () => Promise.all([queryClient.invalidateQueries({ queryKey: ['library'] }), queryClient.invalidateQueries({ queryKey: ['cutover'] })]);

/**
 * Wanted / not wanted for a movie or a whole show. Marquee only looks for
 * titles marked Wanted, and nothing starts out that way.
 */
export function WantedSwitch({ kind, id, wanted }: { kind: 'movie' | 'series'; id: number; wanted: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function set(next: boolean) {
    setBusy(true);
    setError(null);
    try {
      await api(`/${kind === 'movie' ? 'movies' : 'shows'}/${id}/wanted`, { method: 'PUT', body: { wanted: next } });
      await refreshLibrary();
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : 'That didn’t save. Try again.');
    } finally {
      setBusy(false);
    }
  }
  const noun = kind === 'movie' ? 'movie' : 'show';
  return (
    <div className={cx('flex flex-wrap items-center gap-x-5 gap-y-2 rounded-2xl border px-5 py-4', wanted ? 'border-amber/60 bg-amber/8' : 'border-line bg-panel')}>
      <div className="flex min-w-[240px] flex-1 flex-col gap-0.5">
        <span className="text-body font-semibold">{wanted ? 'Wanted' : 'Not wanted'}</span>
        <span className="text-sm text-muted">
          {wanted
            ? kind === 'movie'
              ? 'Marquee looks for this movie and downloads the best copy for its profile.'
              : 'Marquee looks for this show’s episodes as they come out and finds ones you’re missing. Leave out seasons or episodes below.'
            : `Marquee won’t look for this ${noun} by itself. You can still find copies and download one by hand.`}
        </span>
        {error && <span className="text-sm text-warn">{error}</span>}
      </div>
      <Button type="button" variant={wanted ? 'ghost' : 'primary'} disabled={busy} onClick={() => set(!wanted)}>
        {wanted ? 'Stop looking for it' : 'Look for it'}
      </Button>
    </div>
  );
}

/** A small checkbox for one season or episode. */
export function WantedCheck({ label, checked, path, disabled }: { label: string; checked: boolean; path: string; disabled?: boolean }) {
  const [busy, setBusy] = useState(false);
  return (
    <label className={cx('flex min-h-11 items-center gap-2 text-xs text-muted', disabled && 'opacity-50')}>
      <input
        type="checkbox"
        className="size-5 accent-amber"
        checked={checked}
        disabled={busy || disabled}
        aria-label={label}
        onChange={async (e) => {
          setBusy(true);
          try {
            await api(path, { method: 'PUT', body: { wanted: e.target.checked } });
            await refreshLibrary();
          } finally {
            setBusy(false);
          }
        }}
      />
      Wanted
    </label>
  );
}

/**
 * A small Wanted switch for a title's header, a season or an episode.
 * On: Marquee looks for it by itself. Off: only when you search by hand.
 */
export function WantedToggle({ path, wanted, label, compact, disabled, offLabel = 'Skip' }: { path: string; wanted: boolean; label: string; compact?: boolean; disabled?: boolean; offLabel?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState(wanted);
  if (!busy && shown !== wanted) setShown(wanted);
  async function flip() {
    const next = !shown;
    setBusy(true);
    setShown(next);
    setError(null);
    try {
      await api(path, { method: 'PUT', body: { wanted: next } });
      await refreshLibrary();
    } catch (e) {
      setShown(!next);
      setError(e instanceof ApiFailure ? e.message : 'That didn’t save. Try again.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <span className="inline-flex flex-col">
      <button
        type="button"
        role="switch"
        aria-checked={shown}
        aria-label={label}
        disabled={busy || disabled}
        onClick={flip}
        title={shown ? 'Marquee looks for it by itself. Tap to stop.' : 'Marquee won’t look for it by itself. Tap to start.'}
        className={cx(
          'inline-flex min-h-11 items-center gap-2 rounded-full font-medium whitespace-nowrap disabled:opacity-50',
          compact ? 'px-1.5 text-xs' : 'border px-4 text-sm',
          !compact && (shown ? 'border-amber/50 bg-amber/12 text-amber-hi' : 'border-line-strong text-soft hover:text-text'),
          compact && (shown ? 'text-amber-hi' : 'text-dim hover:text-text'),
        )}
      >
        <span aria-hidden="true" className={cx('relative inline-block h-[18px] w-8 flex-none rounded-full transition-colors', shown ? 'bg-amber' : 'bg-line-strong')}>
          <span className={cx('absolute top-[3px] size-3 rounded-full bg-ink transition-[left]', shown ? 'left-[17px]' : 'left-[3px]')} />
        </span>
        {compact ? (shown ? 'Wanted' : offLabel) : shown ? 'Wanted' : 'Not wanted'}
      </button>
      {error && <span className="text-xs text-warn">{error}</span>}
    </span>
  );
}
