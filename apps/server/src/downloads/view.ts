import { eq } from 'drizzle-orm';
import type { DownloadStatus, DownloadView } from '@marquee/shared';
import type { Db } from '../db/index.js';
import { movies, series, type Download } from '../db/schema.js';
import { readDownloader } from './service.js';

/**
 * A download as screens see it: qBittorrent's state turned into plain words,
 * with what it means and what Marquee will do next. qBittorrent's own state
 * words ("stalledDL") never reach the screen.
 */

const HOUR = 3_600_000;

/** qBittorrent states where the clock for "stuck" doesn't run: waiting, paused, or busy checking. */
export const RESTING = new Set(['queuedDL', 'pausedDL', 'stoppedDL', 'checkingDL', 'checkingResumeData', 'moving', 'allocating']);
/** qBittorrent states that mean the whole copy is here. */
export const FINISHED = new Set(['uploading', 'stalledUP', 'queuedUP', 'forcedUP', 'pausedUP', 'stoppedUP', 'checkingUP']);

export function speed(bytesPerSecond: number): string {
  const mb = bytesPerSecond / 1024 ** 2;
  return mb >= 1 ? `${mb.toFixed(1)} MB/s` : `${Math.max(1, Math.round(bytesPerSecond / 1024))} KB/s`;
}

export function duration(seconds: number): string {
  if (seconds < 90) return 'a minute';
  const min = Math.round(seconds / 60);
  if (min < 90) return `${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} hours`;
  return `${Math.round(h / 24)} days`;
}

const hours = (ms: number) => {
  const h = Math.floor(ms / HOUR);
  return h === 1 ? '1 hour' : `${h} hours`;
};

export function downloadStatus(d: Download, settings: { stuckHours: number; giveUpHours: number; tryAnother: boolean }, now: number): DownloadStatus {
  const s = (label: string, tone: DownloadStatus['tone'], detail: string | null = null, nextTryAt: number | null = null): DownloadStatus => ({ label, tone, detail, nextTryAt });
  if (d.state === 'removed') return s('Removed', 'quiet', d.message);
  if (d.state === 'failed') return s('Replaced', 'quiet', d.message);
  if (d.state === 'done') {
    if (d.adopted) return s('Finished downloading', 'done', 'qBittorrent has the whole copy. The app that sent it puts it in your library.');
    if (d.importedAt) {
      return d.importCopied
        ? s('In your library · copied', 'warn', 'The download folder and the library are on different disks, so this is a copy and takes twice the space. Put both under one share (like /data) so Marquee can hardlink instead.')
        : s('In your library', 'done', 'Hardlinked, so it takes no extra space. qBittorrent keeps sharing the download.');
    }
    if (d.importError) return s('Couldn’t put it in your library', 'bad', `${d.importError} Marquee tries again every 15 minutes, or press Try again.`);
    return s('Finished · putting it in your library', 'busy', null);
  }
  const q = d.qbitState;
  if (!q) return s('Sent · waiting for qBittorrent', 'busy', 'Marquee checks on it every minute.');
  if (q === 'gone') return s('Gone from qBittorrent', 'bad', 'It was removed in qBittorrent. Press Try another copy to get a different one, or Remove to forget it.');
  if (q === 'error' || q === 'missingFiles') return s('Problem in qBittorrent', 'bad', 'qBittorrent reported an error with this download, often a full disk or a missing folder. Fix that, then press Resume.');
  if (q === 'pausedDL' || q === 'stoppedDL') return s('Paused', 'quiet', 'Press Resume to carry on.');
  if (q === 'queuedDL') return s('Waiting its turn', 'quiet', 'qBittorrent is busy with other downloads and starts this one when there’s room.');
  if (q.startsWith('checking')) return s('Checking files', 'busy', 'qBittorrent is checking what it already has.');
  if (q === 'moving') return s('Moving files', 'busy', null);

  const stillFor = now - (d.lastProgressAt ?? d.addedAt);
  const giveUpAt = (d.lastProgressAt ?? d.addedAt) + settings.giveUpHours * HOUR;
  const next = settings.tryAnother && d.adopted === false ? giveUpAt : null;
  const whatNext = next
    ? 'Marquee tries another copy by itself if nothing changes.'
    : d.adopted
      ? 'Another app sent this one, so Marquee leaves it alone.'
      : 'Press Try another copy, or wait.';
  if (stillFor >= settings.stuckHours * HOUR) {
    const nobody = (d.seeds ?? 0) === 0;
    return s(nobody ? 'Stuck · nobody is sharing it' : `Stuck · no progress for ${hours(stillFor)}`, 'warn', `${nobody ? `No progress for ${hours(stillFor)}. ` : ''}${whatNext}`, next);
  }
  if (q === 'metaDL' || q === 'forcedMetaDL') return s('Getting ready', 'busy', 'qBittorrent is finding people sharing it and fetching the file list.');
  if (q === 'stalledDL') {
    return (d.seeds ?? 0) === 0
      ? s('Waiting · nobody is sharing it right now', 'warn', `Copies with nobody sharing them often come back. ${whatNext}`, next)
      : s('Waiting for people sharing it', 'busy', 'Connected, but nothing is arriving at the moment.');
  }
  const rate = d.speed ? speed(d.speed) : null;
  const left = d.eta && d.eta < 8640000 ? `about ${duration(d.eta)} left` : null;
  return s(['Downloading', rate, left].filter(Boolean).join(' · '), 'good', `${Math.floor(d.progress * 100)}% done.`);
}

export function describeDownload(db: Db, d: Download, now: number): DownloadView {
  let titleName = d.title;
  let titleLink: string | null = null;
  if (d.movieId) {
    const m = db.select({ title: movies.title, year: movies.year }).from(movies).where(eq(movies.id, d.movieId)).get();
    if (m) titleName = m.year ? `${m.title} (${m.year})` : m.title;
    titleLink = `/movies/${d.movieId}`;
  } else if (d.seriesId) {
    const sh = db.select({ title: series.title }).from(series).where(eq(series.id, d.seriesId)).get();
    const eps = d.episodes ? (JSON.parse(d.episodes) as number[]) : null;
    const pad = (n: number) => String(n).padStart(2, '0');
    const which = d.season === null ? '' : eps?.length ? ` · S${pad(d.season)}E${eps.map(pad).join('-E')}` : ` · Season ${d.season}`;
    titleName = `${sh?.title ?? 'A show'}${which}`;
    titleLink = `/shows/${d.seriesId}`;
  }
  return {
    id: d.id,
    kind: d.kind,
    movieId: d.movieId,
    seriesId: d.seriesId,
    season: d.season,
    episodes: d.episodes ? (JSON.parse(d.episodes) as number[]) : null,
    title: d.title,
    infoHash: d.infoHash,
    sourceName: d.sourceName,
    quality: d.quality,
    score: d.score,
    size: d.size,
    addedAt: d.addedAt,
    state: d.state,
    adopted: d.adopted,
    progress: d.progress,
    message: d.message,
    titleName,
    titleLink,
    status: downloadStatus(d, readDownloader(db), now),
    canControl: !d.adopted && (d.state === 'sent' || d.state === 'downloading'),
    canImport: !d.adopted && d.state === 'done' && !d.importedAt,
    importedPaths: d.importedPaths ? (JSON.parse(d.importedPaths) as string[]) : null,
  };
}
