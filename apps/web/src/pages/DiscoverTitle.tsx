import { useState } from 'react';
import { Link, Navigate, useParams, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import type { DiscoverPrefs, DiscoverTitle } from '@marquee/shared';
import { api, ApiFailure } from '../api';
import { Row, STATE_LABEL, StateBadge, Trailer, useRequest } from '../components/Discover';
import { Poster, tmdbImage } from '../components/Poster';
import { Button, Card, Notice, cx } from '../components/ui';

const pretty = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const money = (n: number) => (n >= 1e9 ? `$${(n / 1e9).toFixed(2)} billion` : `$${Math.round(n / 1e6)} million`);
const RELEASE_LABEL: Record<string, string> = { Premiere: 'Premiere', Limited: 'Limited release', Theatrical: 'In cinemas', Digital: 'Digital', Physical: 'On disc', TV: 'On TV' };

/** The facts other apps show: dates, ratings, who made it, what it cost. */
function DetailsCard({ t, kind }: { t: DiscoverTitle; kind: 'movie' | 'series' }) {
  const d = t.details;
  const rows: [string, string | null][] = [
    [kind === 'movie' ? 'Release date' : 'First aired', d.releaseDate ? pretty(d.releaseDate) : null],
    ['Age rating', t.certification],
    ['TMDB score', d.score !== null ? `${d.score.toFixed(1)} out of 10 · ${d.votes.toLocaleString()} votes` : null],
    ['Runtime', t.runtime ? (kind === 'movie' ? (t.runtime >= 60 ? `${Math.floor(t.runtime / 60)} h ${t.runtime % 60} min` : `${t.runtime} min`) : `${t.runtime} min an episode`) : null],
    ['Status', d.status],
    ['Seasons', d.seasonCount ? `${d.seasonCount} ${d.seasonCount === 1 ? 'season' : 'seasons'}${d.episodeCount ? `, ${d.episodeCount} episodes` : ''}` : null],
    ['Last aired', d.lastAirDate ? pretty(d.lastAirDate) : null],
    ['Next episode', d.nextAirDate ? pretty(d.nextAirDate) : null],
    [kind === 'movie' ? 'Directed by' : 'Created by', d.directors.join(', ') || null],
    ['Written by', d.writers.join(', ') || null],
    ['Studios', d.studios.join(', ') || null],
    ['Networks', d.networks.join(', ') || null],
    ['Language', d.language],
    ['Original title', d.originalTitle],
    ['Made in', d.countries.join(', ') || null],
    ['Budget', d.budget ? money(d.budget) : null],
    ['Box office', d.revenue ? money(d.revenue) : null],
    ['Where to watch', t.providers.join(', ') || null],
  ];
  const shown = rows.filter(([, v]) => v);
  return (
    <Card className="flex flex-col gap-4">
      <h2 className="m-0 text-lg font-semibold">Details</h2>
      {d.releases.length > 0 && (
        <div className="flex flex-wrap gap-3">
          {d.releases.map((r) => (
            <div key={r.kind} className="flex min-w-[150px] flex-col rounded-xl border border-line bg-ink/50 px-4 py-2.5">
              <span className="text-xs text-dim">{RELEASE_LABEL[r.kind] ?? r.kind}</span>
              <span className="text-[15px] font-semibold">{pretty(r.date)}</span>
            </div>
          ))}
        </div>
      )}
      <dl className="m-0 grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-x-8 gap-y-3">
        {shown.map(([label, value]) => (
          <div key={label} className="flex flex-col">
            <dt className="text-xs text-dim">{label}</dt>
            <dd className="m-0 text-[15px] text-soft">{value}</dd>
          </div>
        ))}
      </dl>
      {d.homepage && (
        <a href={d.homepage} target="_blank" rel="noreferrer" className="flex min-h-11 items-center self-start text-sm font-semibold">
          Official site →
        </a>
      )}
    </Card>
  );
}

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
  const d = t.details;
  const bg = tmdbImage(c.backdropPath, 'w1280');
  const open = t.seasons.filter((s) => s.state === 'none');
  const toggle = (n: number) => setPicked((p) => new Set(p.has(n) ? [...p].filter((x) => x !== n) : [...p, n]));
  const requested = t.request && t.request.state !== 'declined';

  return (
    <>
      <Link to="/discover" className="text-sm no-underline">
        ← Discover
      </Link>
      {showTrailer && t.trailerKey && (
        <section aria-label="Trailer" className="flex flex-col gap-2">
          <Trailer videoKey={t.trailerKey} className="max-h-[70vh] shadow-2xl" />
          <button type="button" onClick={() => setShowTrailer(false)} className="min-h-11 self-start text-sm font-medium text-muted hover:text-text">
            Close the trailer
          </button>
        </section>
      )}
      <section className={cx('relative overflow-hidden rounded-[22px] bg-raised', showTrailer && t.trailerKey && 'hidden')}>
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
              {!d.released && d.releaseDate && <span className="rounded-full bg-amber/20 px-2.5 py-1 font-semibold text-amber-hi">Not out yet · {pretty(d.releaseDate)}</span>}
              {d.score !== null && <span className="rounded-full bg-white/8 px-2.5 py-1 font-semibold text-amber-hi">★ {d.score.toFixed(1)}</span>}
              {t.certification && <span className="rounded-full border border-white/25 px-2.5 py-1 text-soft">{t.certification}</span>}
              {t.providers.length > 0 && <span className="rounded-full bg-white/8 px-2.5 py-1 text-soft">On {t.providers.join(', ')}</span>}
            </div>
            <div className="flex flex-wrap items-center gap-3 pt-1">
              {t.trailerKey && (
                <button type="button" onClick={() => setShowTrailer(true)} className="inline-flex h-12 items-center gap-2 rounded-full bg-white px-6 text-[15px] font-semibold text-ink hover:bg-amber">
                  <span aria-hidden="true">▶</span> Play trailer
                </button>
              )}
              {c.libraryId !== null && c.state === 'in_library' && (
                <Link to={`/${k === 'movie' ? 'movies' : 'shows'}/${c.libraryId}`} className="inline-flex h-12 items-center rounded-full border border-white/30 px-6 text-[15px] font-semibold text-text no-underline hover:bg-white/10 hover:text-text">
                  Open in your library
                </Link>
              )}
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

      <DetailsCard t={t} kind={k} />

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
