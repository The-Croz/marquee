import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import type { MediaFileView, MovieDetail, SeasonView, ShowDetail } from '@marquee/shared';
import { api, useAuthStatus } from '../api';
import { CopiesPanel } from '../components/Copies';
import { TitleDownloads } from '../components/Downloads';
import { Watchers } from '../components/Watchers';
import { WantedCheck, WantedSwitch } from '../components/Wanted';
import { Poster, formatBytes, tmdbImage } from '../components/Poster';
import { Card, Notice, cx } from '../components/ui';
import { useDocTitle } from '../components/Page';

function Hero({
  title,
  year,
  backdrop,
  poster,
  meta,
  chips,
  back,
}: {
  title: string;
  year: number | null;
  backdrop: string | null;
  poster: string | null;
  meta: string;
  chips: { text: string; tone?: 'amber' | 'blue' | 'warn' }[];
  back: { to: string; label: string };
}) {
  const bg = tmdbImage(backdrop, 'w1280');
  useDocTitle(title);
  return (
    <>
      <Link to={back.to} className="text-sm no-underline">
        ← {back.label}
      </Link>
      <section className="relative overflow-hidden rounded-2xl bg-raised">
        {bg && <img src={bg} alt="" className="absolute inset-0 size-full object-cover opacity-60" />}
        <div className="absolute inset-0 bg-gradient-to-t from-ink via-ink/60 to-ink/20" />
        <div className="relative flex flex-wrap items-end gap-8 px-6 pt-32 pb-8 sm:px-10">
          <Poster title={title} path={poster} size="w500" className="w-[150px] flex-none shadow-2xl sm:w-[190px]" />
          <div className="flex min-w-[260px] flex-1 flex-col gap-3">
            <div className="text-sm text-soft">{meta}</div>
            <h1 className="m-0 font-display text-display leading-[0.95] font-normal sm:text-display-lg">
              {title} {year && <span className="text-[0.55em] text-soft">({year})</span>}
            </h1>
            <div className="flex flex-wrap gap-2 text-label">
              {chips.map((c) => (
                <span
                  key={c.text}
                  className={cx(
                    'rounded-full px-2.5 py-1',
                    c.tone === 'amber' && 'bg-amber/16 font-semibold text-amber-hi',
                    c.tone === 'blue' && 'bg-blue/18 font-semibold text-blue-hi',
                    c.tone === 'warn' && 'bg-warn/15 font-semibold text-warn',
                    !c.tone && 'bg-white/8 text-soft',
                  )}
                >
                  {c.text}
                </span>
              ))}
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

function FileRow({ f }: { f: MediaFileView }) {
  const q = f.quality;
  const details = [q.source, q.hdr, q.codec, q.group && `by ${q.group}`].filter(Boolean).join(' · ');
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line py-3">
      <span className="rounded-md bg-raised px-2 py-1 text-xs font-semibold text-soft">{q.label}</span>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-mono text-label text-soft" title={f.path}>
          {f.path}
        </span>
        {details && <span className="text-xs text-dim">{details}</span>}
      </div>
      <span className="text-sm text-muted">{formatBytes(f.sizeBytes)}</span>
    </div>
  );
}

export function MovieDetailPage() {
  const { id } = useParams();
  const { data: m, error } = useQuery({ queryKey: ['library', 'movie', id], queryFn: () => api<MovieDetail>(`/movies/${id}`) });
  const isAdmin = useAuthStatus().data?.user?.role === 'admin';
  if (error) return <Notice tone="error">That movie isn't in your library.</Notice>;
  if (!m) return <p className="text-muted">Loading…</p>;
  const best = m.files[0];
  return (
    <>
      <Hero
        title={m.title}
        year={m.year}
        backdrop={m.backdropPath}
        poster={m.posterPath}
        back={{ to: '/library/movies', label: 'Movies' }}
        meta={[m.certification, m.runtime && `${Math.floor(m.runtime / 60)} h ${m.runtime % 60} m`, m.genres.slice(0, 3).join(', ')].filter(Boolean).join(' · ')}
        chips={[
          best ? { text: `On disk · ${best.quality.label}`, tone: 'amber' } : { text: 'Missing', tone: 'warn' },
          ...(best ? [{ text: formatBytes(m.files.reduce((n, f) => n + f.sizeBytes, 0)) }] : []),
        ]}
      />
      {m.overview && <p className="m-0 max-w-[760px] text-heading leading-relaxed text-soft">{m.overview}</p>}
      {isAdmin && <WantedSwitch kind="movie" id={m.id} wanted={m.monitored} />}
      <Card className="flex flex-col">
        <h2 className="m-0 mb-2 text-lg font-semibold">Files</h2>
        {m.files.length === 0 ? (
          <p className="m-0 text-sm text-muted">Nothing on disk yet.</p>
        ) : (
          m.files.map((f) => <FileRow key={f.id} f={f} />)
        )}
        {m.path && <p className="m-0 mt-3 text-xs text-dim">Folder: {m.path}</p>}
      </Card>
      {isAdmin && <TitleDownloads movieId={m.id} />}
      {isAdmin && <Watchers kind="movie" id={m.id} />}
      {isAdmin && <CopiesPanel kind="movie" titleId={m.id} profile={m.profile} byHand={m.profileByHand} />}
    </>
  );
}

function SeasonBlock({ s, open, onToggle, showId, editable, showWanted }: { s: SeasonView; open: boolean; onToggle: () => void; showId: number; editable: boolean; showWanted: boolean }) {
  const label = s.season === 0 ? 'Specials' : `Season ${s.season}`;
  const done = s.aired > 0 && s.have >= s.aired;
  return (
    <Card className="flex flex-col p-0">
      <button type="button" onClick={onToggle} aria-expanded={open} className="flex min-h-14 items-center gap-4 px-6 py-4 text-left text-text">
        <span className="flex-1 text-heading font-semibold">{label}</span>
        <span className={cx('text-sm', done ? 'text-teal-hi' : s.have === 0 ? 'text-dim' : 'text-amber-hi')}>
          {s.aired === 0 ? 'Not aired yet' : `${s.have} of ${s.aired} episodes`}
        </span>
        <span aria-hidden="true" className="text-muted">
          {open ? '−' : '+'}
        </span>
      </button>
      {editable && showWanted && open && (
        <div className="flex items-center gap-3 px-6 pb-2">
          <WantedCheck label={`${label}: wanted`} checked={s.episodes.every((e) => e.wanted)} path={`/shows/${showId}/seasons/${s.season}/wanted`} />
          <span className="text-xs text-dim">Untick a season or an episode to leave it out.</span>
        </div>
      )}
      {open && (
        <div className="flex flex-col px-6 pb-4">
          {s.episodes.map((e) => (
            <div key={e.episode} className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line py-2.5">
              <span className="w-10 text-sm font-semibold text-muted">{e.episode}</span>
              <span className="min-w-[160px] flex-1 text-body">{e.title ?? `Episode ${e.episode}`}</span>
              <span className="text-xs text-dim">{e.airDate ?? 'No date'}</span>
              {editable && showWanted && <WantedCheck label={`Episode ${e.episode}: wanted`} checked={e.wanted} path={`/shows/${showId}/seasons/${s.season}/episodes/${e.episode}/wanted`} />}
              <span
                className={cx(
                  'w-[120px] text-right text-xs font-semibold',
                  e.file ? 'text-soft' : e.aired ? 'text-warn' : 'text-dim',
                )}
              >
                {e.file ? `${e.file.quality.label} · ${formatBytes(e.file.sizeBytes)}` : e.aired ? 'Missing' : 'Not aired'}
              </span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

export function ShowDetailPage() {
  const { id } = useParams();
  const { data: s, error } = useQuery({ queryKey: ['library', 'show', id], queryFn: () => api<ShowDetail>(`/shows/${id}`) });
  const isAdmin = useAuthStatus().data?.user?.role === 'admin';
  const [open, setOpen] = useState<Set<number>>(new Set());
  if (error) return <Notice tone="error">That show isn't in your library.</Notice>;
  if (!s) return <p className="text-muted">Loading…</p>;
  const have = s.seasons.filter((x) => x.season !== 0).reduce((n, x) => n + x.have, 0);
  const aired = s.seasons.filter((x) => x.season !== 0).reduce((n, x) => n + x.aired, 0);
  const toggle = (n: number) => setOpen((prev) => new Set(prev.has(n) ? [...prev].filter((x) => x !== n) : [...prev, n]));
  return (
    <>
      <Hero
        title={s.title}
        year={s.year}
        backdrop={s.backdropPath}
        poster={s.posterPath}
        back={{ to: '/library/shows', label: 'Shows' }}
        meta={[s.certification, s.network, s.status === 'Ended' ? 'Ended' : s.status === 'Returning Series' ? 'Still airing' : s.status].filter(Boolean).join(' · ')}
        chips={[
          aired === 0 ? { text: 'Not aired yet' } : have >= aired ? { text: `All ${aired} episodes`, tone: 'amber' } : { text: `${have} of ${aired} episodes`, tone: 'warn' },
          ...(s.sizeBytes ? [{ text: formatBytes(s.sizeBytes) }] : []),
        ]}
      />
      {s.overview && <p className="m-0 max-w-[760px] text-heading leading-relaxed text-soft">{s.overview}</p>}
      {isAdmin && <WantedSwitch kind="series" id={s.id} wanted={s.monitored} />}
      <div className="flex flex-col gap-3">
        {s.seasons.map((x) => (
          <SeasonBlock key={x.season} s={x} open={open.has(x.season)} onToggle={() => toggle(x.season)} showId={s.id} editable={isAdmin} showWanted={s.monitored} />
        ))}
      </div>
      {s.path && <p className="m-0 text-xs text-dim">Folder: {s.path}</p>}
      {isAdmin && <TitleDownloads seriesId={s.id} />}
      {isAdmin && <Watchers kind="tv" id={s.id} />}
      {isAdmin && <CopiesPanel kind="tv" titleId={s.id} profile={s.profile} byHand={s.profileByHand} seasons={s.seasons.map((x) => ({ season: x.season, episodes: x.episodes.map((e) => e.episode) }))} />}
    </>
  );
}
