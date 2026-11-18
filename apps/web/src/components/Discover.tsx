import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import type { CardState, DiscoverCard, DiscoverRow, DiscoverTitle } from '@marquee/shared';
import { api, ApiFailure, queryClient } from '../api';
import { Poster, tmdbImage } from './Poster';
import { Button, cx } from './ui';

/** Where a card goes: the library page when it's there, else its Discover page. */
export const cardHref = (c: Pick<DiscoverCard, 'kind' | 'tmdbId' | 'libraryId' | 'state'>) =>
  c.libraryId !== null && c.state === 'in_library' ? `/${c.kind === 'movie' ? 'movies' : 'shows'}/${c.libraryId}` : `/discover/${c.kind}/${c.tmdbId}`;

export const STATE_LABEL: Record<CardState, string | null> = {
  in_library: 'In your library',
  downloading: 'Downloading',
  approved: 'Approved',
  pending: 'Requested',
  declined: 'Turned down',
  none: null,
};

const STATE_TONE: Record<CardState, string> = {
  in_library: 'bg-teal/90 text-[#04201d]',
  downloading: 'bg-blue/90 text-[#071a33]',
  approved: 'bg-blue/90 text-[#071a33]',
  pending: 'bg-amber text-amber-ink',
  declined: 'bg-warn/90 text-[#2A1406]',
  none: '',
};

export function StateBadge({ state, className }: { state: CardState; className?: string }) {
  const label = STATE_LABEL[state];
  if (!label) return null;
  return <span className={cx('rounded-md px-2 py-0.5 text-[11px] font-semibold', STATE_TONE[state], className)}>{label}</span>;
}

/** Asks for a title (a whole show for a show). Shows what happened in plain words. */
export function useRequest() {
  const [busy, setBusy] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  async function ask(c: Pick<DiscoverCard, 'kind' | 'tmdbId'>, seasons?: number[]) {
    setBusy(c.tmdbId);
    setMessage(null);
    try {
      await api('/requests', { body: { kind: c.kind, tmdbId: c.tmdbId, ...(seasons ? { seasons } : {}) } });
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['discover'] }), queryClient.invalidateQueries({ queryKey: ['requests'] }), queryClient.invalidateQueries({ queryKey: ['library'] })]);
      return true;
    } catch (e) {
      setMessage(e instanceof ApiFailure ? e.message : 'That didn’t go through. Try again.');
      return false;
    } finally {
      setBusy(null);
    }
  }
  return { ask, busy, message, clear: () => setMessage(null) };
}

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const canHover = () => typeof window !== 'undefined' && window.matchMedia('(hover: hover) and (pointer: fine)').matches;

/** A trailer in YouTube's no-cookie player. */
export function Trailer({ videoKey, autoplay = true, muted = false, className }: { videoKey: string; autoplay?: boolean; muted?: boolean; className?: string }) {
  const params = new URLSearchParams({ rel: '0', modestbranding: '1', playsinline: '1', ...(autoplay ? { autoplay: '1' } : {}), ...(muted ? { mute: '1' } : {}) });
  return (
    <iframe
      title="Trailer"
      src={`https://www.youtube-nocookie.com/embed/${videoKey}?${params}`}
      allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
      allowFullScreen
      referrerPolicy="strict-origin-when-cross-origin"
      className={cx('aspect-video w-full rounded-xl border-0 bg-black', className)}
    />
  );
}

/** One cover with its state. Rest on it (or tab to it) for more, and after a moment a trailer plays. */
export function TitleCard({ card, trailers = true, className }: { card: DiscoverCard; trailers?: boolean; className?: string }) {
  const { ask, busy, message } = useRequest();
  const [wanted, setWanted] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const q = useQuery({
    queryKey: ['discover', 'title', card.kind, card.tmdbId],
    queryFn: () => api<DiscoverTitle>(`/discover/title/${card.kind}/${card.tmdbId}`),
    enabled: wanted && trailers,
    staleTime: 10 * 60_000,
  });
  const key = q.data?.trailerKey;
  const [play, setPlay] = useState(false);
  useEffect(() => () => clearTimeout(timer.current), []);

  const enter = () => {
    if (!trailers || reducedMotion() || !canHover()) return;
    timer.current = setTimeout(() => setWanted(true), 700);
  };
  const leave = () => {
    clearTimeout(timer.current);
    setWanted(false);
    setPlay(false);
  };
  useEffect(() => {
    if (wanted && key) setPlay(true);
  }, [wanted, key]);

  const canAsk = card.state === 'none' || card.state === 'declined';
  return (
    <div
      className={cx('group relative flex w-[160px] flex-none snap-start flex-col gap-2', className)}
      onMouseEnter={enter}
      onMouseLeave={leave}
      onFocus={() => undefined}
    >
      <Link to={cardHref(card)} className="flex flex-col gap-2 text-text no-underline hover:text-text" aria-label={`${card.title}${card.year ? `, ${card.year}` : ''}`}>
        <div className="relative">
          <Poster title={card.title} path={card.posterPath} className="transition duration-200 group-hover:ring-2 group-hover:ring-amber group-focus-within:ring-2 group-focus-within:ring-amber" />
          <StateBadge state={card.state} className="absolute top-2 left-2" />
          {card.badge && card.state === 'none' && <span className="absolute top-2 left-2 rounded-md bg-ink/85 px-2 py-0.5 text-[11px] font-semibold text-amber-hi">{card.badge}</span>}
          {card.score !== null && (
            <span className="absolute right-2 bottom-2 rounded-md bg-ink/85 px-1.5 py-0.5 text-[11px] font-semibold text-soft group-hover:opacity-0 group-focus-within:opacity-0">★ {card.score.toFixed(1)}</span>
          )}
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="truncate text-sm font-semibold">{card.title}</span>
          <span className="text-xs text-muted">{[card.kind === 'movie' ? 'Movie' : 'Show', card.year].filter(Boolean).join(' · ')}</span>
        </div>
      </Link>

      {/* More about it, over the cover, on hover or keyboard focus. */}
      <div
        className={cx(
          'pointer-events-none absolute inset-x-0 top-0 flex aspect-[2/3] flex-col justify-end gap-1.5 overflow-hidden rounded-xl bg-gradient-to-t from-ink via-ink/85 to-transparent p-3 opacity-0 transition duration-200',
          'group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100',
        )}
      >
        {play && key && <Trailer videoKey={key} muted className="pointer-events-auto absolute inset-0 z-0 !aspect-auto h-full rounded-none object-cover" />}
        <div className="relative z-10 flex flex-col gap-1.5">
          <span className="font-display text-[19px] leading-[1.05] text-text">{card.title}</span>
          <span className="text-[11px] text-soft">
            {card.score !== null && `★ ${card.score.toFixed(1)} · `}
            {card.genres.slice(0, 2).join(', ')}
          </span>
          {!play && <p className="m-0 line-clamp-4 text-[11px] leading-snug text-soft">{card.overview}</p>}
          {canAsk ? (
            <button
              type="button"
              onClick={() => ask(card)}
              disabled={busy !== null}
              className="pointer-events-auto flex h-11 items-center justify-center rounded-lg bg-amber px-3 text-[13px] font-semibold text-amber-ink hover:bg-amber-hi disabled:opacity-60"
            >
              {busy === card.tmdbId ? 'Asking…' : 'Request'}
            </button>
          ) : (
            <StateBadge state={card.state} className="self-start" />
          )}
          {message && <span className="text-[11px] text-warn">{message}</span>}
        </div>
      </div>
    </div>
  );
}

/** A named row of covers that scrolls sideways. */
export function Row({ row, trailers }: { row: DiscoverRow; trailers: boolean }) {
  const scroller = useRef<HTMLDivElement>(null);
  const by = (dir: 1 | -1) => scroller.current?.scrollBy({ left: dir * scroller.current.clientWidth * 0.85, behavior: reducedMotion() ? 'auto' : 'smooth' });
  return (
    <section aria-labelledby={`row-${row.id}`} className="flex flex-col gap-3">
      <div className="flex items-end justify-between gap-3">
        <div className="flex flex-col">
          <h2 id={`row-${row.id}`} className="m-0 text-[20px] font-semibold">
            {row.title}
          </h2>
          {row.subtitle && <span className="text-sm text-muted">{row.subtitle}</span>}
        </div>
        <div className="hidden gap-1.5 md:flex">
          {([-1, 1] as const).map((d) => (
            <button
              key={d}
              type="button"
              aria-label={d === -1 ? `Scroll ${row.title} back` : `Scroll ${row.title} forward`}
              onClick={() => by(d)}
              className="flex size-11 items-center justify-center rounded-full border border-line-strong text-soft hover:bg-raised hover:text-text"
            >
              <span aria-hidden="true">{d === -1 ? '‹' : '›'}</span>
            </button>
          ))}
        </div>
      </div>
      <div ref={scroller} className="-mx-5 flex snap-x gap-[18px] overflow-x-auto px-5 pb-2 sm:-mx-10 sm:px-10">
        {row.items.map((c) => (
          <TitleCard key={`${c.kind}${c.tmdbId}`} card={c} trailers={trailers} />
        ))}
      </div>
    </section>
  );
}

/** The big rotating banner. Pauses while you point at it or focus inside it, and doesn't move at all with reduced motion. */
export function Hero({ items }: { items: DiscoverCard[] }) {
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  const { ask, busy, message } = useRequest();
  const still = reducedMotion();
  useEffect(() => {
    if (paused || still || items.length < 2) return;
    const t = setInterval(() => setI((n) => (n + 1) % items.length), 8000);
    return () => clearInterval(t);
  }, [paused, still, items.length]);
  useEffect(() => setI(0), [items]);
  const c = items[i];
  if (!c) return null;
  const bg = tmdbImage(c.backdropPath, 'w1280');
  const canAsk = c.state === 'none' || c.state === 'declined';
  return (
    <section
      aria-roledescription="carousel"
      aria-label="Featured"
      className="relative overflow-hidden rounded-[22px] bg-raised"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      {items.map((x, n) => {
        const src = tmdbImage(x.backdropPath, 'w1280');
        return src ? <img key={x.tmdbId} src={src} alt="" className={cx('absolute inset-0 size-full object-cover transition-opacity duration-700', n === i ? 'opacity-70' : 'opacity-0')} /> : null;
      })}
      {!bg && <div className="absolute inset-0 bg-raised" />}
      <div className="absolute inset-0 bg-gradient-to-t from-ink via-ink/55 to-transparent" />
      <div className="absolute inset-0 bg-gradient-to-r from-ink/80 via-ink/20 to-transparent" />
      <div aria-live={paused ? 'polite' : 'off'} className="relative flex min-h-[340px] flex-col justify-end gap-3 px-6 pt-24 pb-9 sm:min-h-[420px] sm:px-10 lg:min-h-[460px]">
        <div className="flex flex-wrap items-center gap-2 text-[13px]">
          <span className="rounded-full bg-white/10 px-2.5 py-1 text-soft">{c.kind === 'movie' ? 'Movie' : 'Show'}</span>
          {c.year && <span className="text-soft">{c.year}</span>}
          {c.score !== null && <span className="font-semibold text-amber-hi">★ {c.score.toFixed(1)}</span>}
          {c.genres.length > 0 && <span className="text-soft">{c.genres.join(' · ')}</span>}
          {c.badge && <span className="rounded-full bg-amber/20 px-2.5 py-1 font-semibold text-amber-hi">{c.badge}</span>}
        </div>
        <h2 className="m-0 max-w-[760px] font-display text-[44px] leading-[0.95] font-normal sm:text-[68px]">{c.title}</h2>
        <p className="m-0 line-clamp-3 max-w-[640px] text-[16px] leading-relaxed text-soft">{c.overview}</p>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          {canAsk ? (
            <Button type="button" onClick={() => ask(c)} disabled={busy !== null}>
              {busy === c.tmdbId ? 'Asking…' : 'Request'}
            </Button>
          ) : (
            <StateBadge state={c.state} className="px-3 py-2 text-[13px]" />
          )}
          <Link to={cardHref(c)} className="inline-flex h-11 items-center rounded-xl border border-line-strong px-5 text-[15px] font-medium text-text no-underline hover:bg-white/10 hover:text-text">
            More info
          </Link>
          <Link to={`/discover/${c.kind}/${c.tmdbId}?trailer=1`} className="inline-flex h-11 items-center gap-2 rounded-xl px-3 text-[15px] font-medium text-soft no-underline hover:text-text">
            <span aria-hidden="true">▶</span> Trailer
          </Link>
          {message && <span className="text-sm text-warn">{message}</span>}
        </div>
        {items.length > 1 && (
          <div className="absolute right-6 bottom-9 flex items-center gap-1 sm:right-10" role="group" aria-label="Choose a featured title">
            {items.map((x, n) => (
              <button key={x.tmdbId} type="button" aria-label={`${x.title}${n === i ? ', showing now' : ''}`} aria-current={n === i} onClick={() => setI(n)} className="flex size-11 items-center justify-center">
                <span className={cx('block h-1.5 rounded-full transition-all', n === i ? 'w-6 bg-amber' : 'w-1.5 bg-white/40')} />
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
