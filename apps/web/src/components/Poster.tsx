import { useState } from 'react';
import { cx } from './ui';

const TMDB_IMG = 'https://image.tmdb.org/t/p';

export function tmdbImage(path: string | null | undefined, size: 'w185' | 'w342' | 'w500' | 'w780' | 'w1280' = 'w342'): string | null {
  return path ? `${TMDB_IMG}/${size}${path}` : null;
}

/** Stable muted color per title, for posters that are missing. */
function colorFor(title: string): string {
  const palette = ['#3A2412', '#22364A', '#5A2A22', '#2E4A3A', '#3C3A34', '#4A2A4A', '#1F3A5A', '#4A1F1A'];
  let h = 0;
  for (const ch of title) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return palette[h % palette.length]!;
}

/** `color` is the poster's own main colour when Marquee has picked it; it shows while the image loads. */
export function Poster({
  title,
  path,
  color,
  className,
  size = 'w342',
}: {
  title: string;
  path: string | null | undefined;
  color?: string | null;
  className?: string;
  size?: 'w185' | 'w342' | 'w500';
}) {
  const [failed, setFailed] = useState(false);
  const src = tmdbImage(path, size);
  return (
    <div className={cx('relative aspect-[2/3] overflow-hidden rounded-xl', className)} style={{ background: color ? `color-mix(in oklab, ${color} 55%, var(--color-ink))` : colorFor(title) }}>
      {/* The title sits underneath, so it shows while the image loads or if it fails. */}
      <div className="absolute inset-0 flex items-end p-3">
        <span className="font-display text-xl leading-[1.05] text-cream">{title}</span>
      </div>
      {src && !failed && <img src={src} alt="" loading="lazy" onError={() => setFailed(true)} className="absolute inset-0 size-full object-cover" />}
    </div>
  );
}

export function formatBytes(n: number): string {
  if (n <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v >= 100 || i < 3 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}
