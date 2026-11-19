import { cx } from './ui';

/**
 * Marquee's signature: a short row of theatre bulbs. Lit means something is
 * happening (playing, arriving); a chase means it's live. Decorative only.
 */
export function Bulbs({ count = 4, lit = count, chase = false, className }: { count?: number; lit?: number; chase?: boolean; className?: string }) {
  return (
    <span aria-hidden="true" className={cx('inline-flex items-center gap-[5px]', chase && 'bulbs-chase', className)}>
      {Array.from({ length: count }, (_, i) => (
        <i key={i} className={cx('block size-1.5 rounded-full', i < lit ? 'bulb-on bg-amber' : 'bg-line-strong')} style={chase ? { animationDelay: `${i * 0.3}s` } : undefined} />
      ))}
    </span>
  );
}
