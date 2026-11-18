import { useState } from 'react';
import { Link, Navigate, useParams, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import type { DiscoverPrefs, DiscoverTitle } from '@marquee/shared';
import { api, ApiFailure } from '../api';
import { Row, STATE_LABEL, StateBadge, Trailer, cardHref, useRequest } from '../components/Discover';
import { Poster, tmdbImage } from '../components/Poster';
import { Button, Card, Notice, cx } from '../components/ui';

/** A movie or show that may not be in your library yet: all about it, its trailer, and asking for it. */
export function DiscoverTitlePage() {
  const { kind, id } = useParams();
  const [params] = useSearchParams();
  const k = kind === 'movie' || kind === 'series' ? kind : null;
  const { data: t, error } = useQuery({
    queryKey: ['discover', 'title', k, id],
    queryFn: () => api<DiscoverTitle>(`/discover/title/${k}/${id}`),
    enabled: !!k,
  });
  const { ask, busy, message } = useRequest();
  const { data: prefs } = useQuery({ queryKey: ['discover', 'prefs'], queryFn: () => api<DiscoverPrefs>('/discover/prefs') });
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [showTrailer, setShowTrailer] = useState(params.get('trailer') === '1');
  if (!k) return <Navigate to="/discover" replace />;
  if (error) return <Notice tone="error">{error instanceof ApiFailure ? error.message : 'Couldn’t load that title.'}</Notice>;
  if (!t) return <p className="text-muted">Loading…</p>;

  const c = t.card;
  // Already in the library with files? Go to its own page.
  if (c.state === 'in_library' && c.libraryId !== null && c.kind === 'movie') return <Navigate to={cardHref(c)} replace />;
  const bg = tmdbImage(c.backdropPath, 'w1280');
  const open = t.seasons.filter((s) => s.state === 'none');
  const toggle = (n: number) => setPicked((p) => new Set(p.has(n) ? [...p].filter((x) => x !== n) : [...p, n]));
  const requested = t.request && t.request.state !== 'declined';

  return (
    <>
      <Link to="/discover" className="text-sm no-underline">
        ← Discover
      </Link>
      <section className="relative overflow-hidden rounded-[22px] bg-raised">
        {bg && <img src={bg} alt="" className="absolute inset-0 size-full object-cover opacity-60" />}
        <div className="absolute inset-0 bg-gradient-to-t from-ink via-ink/60 to-ink/20" />
        <div className="relative flex flex-wrap items-end gap-8 px-6 pt-32 pb-8 sm:px-10">
          <Poster title={c.title} path={c.posterPath} size="w500" className="w-[150px] flex-none shadow-2xl sm:w-[190px]" />
          <div className="flex min-w-[260px] flex-1 flex-col gap-3">
            <div className="text-sm text-soft">
              {[t.certification, t.runtime && (t.runtime >= 60 ? `${Math.floor(t.runtime / 60)} h ${t.runtime % 60} m` : `${t.runtime} m`), t.genres.slice(0, 3).join(', ')].filter(Boolean).join(' · ')}
            </div>
            <h1 className="m-0 font-display text-[52px] leading-[0.95] font-normal sm:text-[72px]">
              {c.title} {c.year && <span className="text-[0.55em] text-soft">({c.year})</span>}
            </h1>
            {t.tagline && <p className="m-0 text-[15px] text-soft italic">{t.tagline}</p>}
            <div className="flex flex-wrap items-center gap-2 text-[13px]">
              <StateBadge state={c.state} className="px-2.5 py-1" />
              {t.providers.length > 0 && <span className="rounded-full bg-white/8 px-2.5 py-1 text-soft">On {t.providers.join(', ')}</span>}
            </div>
          </div>
        </div>
      </section>

      {c.overview && <p className="m-0 max-w-[760px] text-[17px] leading-relaxed text-soft">{c.overview}</p>}

      <Card className="flex flex-col gap-4">
        <h2 className="m-0 text-lg font-semibold">{k === 'movie' ? 'Ask for this movie' : 'Ask for this show'}</h2>
        {t.request && (
          <p className={cx('m-0 text-sm', t.request.state === 'declined' ? 'text-warn' : 'text-soft')}>
            Your request: <strong>{t.request.stateText}</strong>{' '}
            {t.request.href && (
              <Link to={t.request.href} className="font-semibold">
                Open it →
              </Link>
            )}
          </p>
        )}
        {t.note && <p className="m-0 text-sm text-soft">{t.note}</p>}
        {k === 'series' && t.seasons.length > 0 && (
          <fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
            <legend className="mb-1 text-sm text-muted">Seasons</legend>
            {t.seasons.map((s) => (
              <label key={s.season} className={cx('flex min-h-11 items-center gap-3 text-[15px]', s.state !== 'none' && 'opacity-70')}>
                <input type="checkbox" className="size-5 accent-amber" disabled={s.state !== 'none'} checked={s.state !== 'none' || picked.has(s.season)} onChange={() => toggle(s.season)} />
                <span className="flex-1">
                  Season {s.season} <span className="text-dim">· {s.episodeCount} {s.episodeCount === 1 ? 'episode' : 'episodes'}</span>
                </span>
                {STATE_LABEL[s.state] && <span className="text-xs text-muted">{STATE_LABEL[s.state]}</span>}
              </label>
            ))}
          </fieldset>
        )}
        {t.canRequest && (
          <div className="flex flex-wrap items-center gap-3">
            {k === 'movie' ? (
              <Button type="button" disabled={busy !== null} onClick={() => ask(c)}>
                {busy ? 'Asking…' : requested ? 'Asked' : 'Request'}
              </Button>
            ) : (
              <>
                <Button type="button" disabled={busy !== null || picked.size === 0} onClick={() => ask(c, [...picked])}>
                  {busy ? 'Asking…' : picked.size ? `Request ${picked.size === 1 ? 'this season' : `these ${picked.size} seasons`}` : 'Pick seasons to request'}
                </Button>
                <Button type="button" variant="ghost" disabled={busy !== null} onClick={() => ask(c)}>
                  {open.length === t.seasons.length ? 'Request the whole show' : 'Request every season left'}
                </Button>
              </>
            )}
            <span className="text-sm text-muted">An admin approves requests from members and kid profiles. Admins’ go straight through.</span>
          </div>
        )}
        {message && <Notice tone="error">{message}</Notice>}
      </Card>

      {t.trailerKey && (
        <section aria-labelledby="trailer" className="flex max-w-[860px] flex-col gap-3">
          <h2 id="trailer" className="m-0 text-lg font-semibold">
            Trailer
          </h2>
          {showTrailer ? (
            <Trailer videoKey={t.trailerKey} />
          ) : (
            <Button type="button" variant="ghost" className="self-start" onClick={() => setShowTrailer(true)}>
              <span aria-hidden="true">▶</span> Play the trailer
            </Button>
          )}
        </section>
      )}

      {t.cast.length > 0 && (
        <section aria-labelledby="cast" className="flex flex-col gap-2">
          <h2 id="cast" className="m-0 text-lg font-semibold">
            Cast
          </h2>
          <ul className="m-0 flex list-none flex-wrap gap-x-6 gap-y-1 p-0 text-sm text-soft">
            {t.cast.map((p) => (
              <li key={p.name}>
                {p.name} {p.character && <span className="text-dim">as {p.character}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {t.similar && <Row row={t.similar} trailers={prefs?.trailers ?? true} />}
    </>
  );
}
