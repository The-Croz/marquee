import { RequestsLeft, SomethingWrong } from '../components/Family';
import { ShowEpisodesChoice } from './GettingIn';
import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import type { CastMember, DiscoverPrefs, DiscoverTitle, DownloadView, EpisodeDetailView, HistoryView, MovieDetail, RequestState, RequestView, SeasonView, ShowDetail, TitleRatings, WatchersView, WatchLink } from '@marquee/shared';
import { api, ApiFailure, queryClient, useAuthStatus } from '../api';
import { CopiesPanel } from '../components/Copies';
import { DownloadList, useDownloads } from '../components/Downloads';
import { NeverPickList, copyFacts, useNeverPick } from '../components/History';
import { Row, Trailer, useRequest } from '../components/Discover';
import { WantedToggle } from '../components/Wanted';
import { TitleTools } from '../components/LibraryCare';
import { Poster, formatBytes, posterTransition, tmdbImage } from '../components/Poster';
import { Sheet, useToast } from '../components/Overlay';
import { Button, Notice, Progress, cx } from '../components/ui';
import { useDocTitle } from '../components/Page';
import { ImdbMark, MetacriticMark, TmdbMark, TomatoMark } from '../components/ScoreIcons';

/**
 * One page for a movie or show, whether it's in your library or not.
 * The same facts, scores, cast and "more like this" either way; titles in
 * your library add what's on disk, the seasons, and their history. Finding a
 * copy happens right where it's needed (the movie, a season, an episode),
 * not on a separate tab.
 */

const pretty = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const money = (n: number) => (n >= 1e9 ? `$${(n / 1e9).toFixed(2)} billion` : `$${Math.round(n / 1e6)} million`);
const hm = (min: number) => (min >= 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min} min`);
const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const RELEASE_LABEL: Record<string, string> = { Premiere: 'Premiere', Limited: 'Limited release', Theatrical: 'In cinemas', Digital: 'To stream or buy', Physical: 'On disc', TV: 'On TV' };
const ACTIVE = (d: DownloadView) => d.state === 'sent' || d.state === 'downloading' || d.canImport;

/** Everything TMDB knows about it, plus where it stands for you. Checks often while a search or download is under way. */
function useTitleInfo(kind: 'movie' | 'series', tmdbId: number | undefined) {
  return useQuery({
    queryKey: ['discover', 'title', kind, String(tmdbId)],
    queryFn: () => api<DiscoverTitle>(`/discover/title/${kind}/${tmdbId}`),
    enabled: tmdbId !== undefined,
    retry: false,
    refetchInterval: (q) => {
      const st = q.state.data?.request?.state;
      return st === 'searching' ? 3_000 : st === 'downloading' || st === 'looking' ? 15_000 : false;
    },
  });
}

// ---------------- Routes ----------------

export function MovieDetailPage() {
  const { id } = useParams();
  const lib = useQuery({ queryKey: ['library', 'movie', id], queryFn: () => api<MovieDetail>(`/movies/${id}`) });
  const info = useTitleInfo('movie', lib.data?.tmdbId);
  if (lib.error) return <Notice tone="error">That movie isn’t in your library.</Notice>;
  if (!lib.data) return <p className="text-muted">Loading…</p>;
  return <TitlePage kind="movie" movie={lib.data} info={info.data} />;
}

export function ShowDetailPage() {
  const { id } = useParams();
  const lib = useQuery({ queryKey: ['library', 'show', id], queryFn: () => api<ShowDetail>(`/shows/${id}`) });
  const info = useTitleInfo('series', lib.data?.tmdbId);
  if (lib.error) return <Notice tone="error">That show isn’t in your library.</Notice>;
  if (!lib.data) return <p className="text-muted">Loading…</p>;
  return <TitlePage kind="series" show={lib.data} info={info.data} />;
}

/** A title that may not be in your library. Once it is (or a request for it is approved), its library page takes over. */
export function DiscoverTitlePage() {
  const { kind, id } = useParams();
  const { search } = useLocation();
  const k = kind === 'movie' || kind === 'series' ? kind : null;
  const info = useTitleInfo(k ?? 'movie', k ? Number(id) : undefined);
  if (!k) return <Navigate to="/discover" replace />;
  if (info.error) return <Notice tone="error">{info.error instanceof ApiFailure ? info.error.message : 'Couldn’t load that title.'}</Notice>;
  if (!info.data) return <p className="text-muted">Loading…</p>;
  const libId = info.data.card.libraryId;
  if (libId !== null) return <Navigate to={`/${k === 'movie' ? 'movies' : 'shows'}/${libId}${search}`} replace />;
  return <TitlePage kind={k} info={info.data} />;
}

// ---------------- The page ----------------

function TitlePage({ kind, movie, show, info }: { kind: 'movie' | 'series'; movie?: MovieDetail; show?: ShowDetail; info?: DiscoverTitle }) {
  const role = useAuthStatus().data?.user?.role;
  const admin = role === 'admin';
  const [params] = useSearchParams();
  const [trailer, setTrailer] = useState(params.get('trailer') === '1');
  // "Find a better copy" from a problem report opens the search straight away (?find=1).
  const [finding, setFinding] = useState<{ season?: number; episode?: number } | null>(params.get('find') === '1' && admin ? {} : null);
  const { data: prefs } = useQuery({ queryKey: ['discover', 'prefs'], queryFn: () => api<DiscoverPrefs>('/discover/prefs') });
  // "Something wrong?" opens from the More menu (admins) or a small link (everyone else).
  const [reporting, setReporting] = useState(false);
  const lib = movie ?? show;
  const libId = lib?.id;
  const downloads = useDownloads(admin && libId ? (kind === 'movie' ? { movieId: libId } : { seriesId: libId }) : undefined);
  const dl = admin && libId ? (downloads.data?.items ?? []) : [];
  const active = dl.filter(ACTIVE);

  const c = info?.card;
  const title = lib?.title ?? c?.title ?? '';
  useDocTitle(title);
  const year = lib?.year ?? c?.year ?? null;
  const href = lib ? `/${kind === 'movie' ? 'movies' : 'shows'}/${lib.id}` : `/discover/${kind}/${c?.tmdbId}`;
  const runtime = movie?.runtime ?? info?.runtime ?? null;
  const facts = [
    year && String(year),
    runtime ? (kind === 'movie' ? hm(runtime) : `${runtime} min episodes`) : null,
    (lib?.genres.length ? lib.genres : (info?.genres ?? [])).slice(0, 3).join(', ') || null,
    show?.network ?? info?.details.networks[0] ?? null,
  ].filter((x): x is string => !!x);
  const cert = lib?.certification ?? info?.certification ?? null;
  const bg = tmdbImage(lib?.backdropPath ?? c?.backdropPath, 'w1280');
  const color = lib?.posterColor ?? null;

  return (
    <>

      {trailer && info?.trailerKey && (
        <section aria-label="Trailer" className="flex flex-col gap-2">
          <Trailer videoKey={info.trailerKey} className="max-h-[70vh] shadow-2xl" />
          <button type="button" onClick={() => setTrailer(false)} className="min-h-11 self-start text-sm font-medium text-muted hover:text-text">
            Close the trailer
          </button>
        </section>
      )}

      <section className={cx('relative isolate overflow-hidden rounded-2xl bg-raised', trailer && info?.trailerKey && 'hidden')} style={{ '--tint': color ?? 'var(--color-amber)' } as React.CSSProperties}>
        {bg ? (
          <img onError={(e) => (e.currentTarget.style.visibility = 'hidden')} src={bg} alt="" className="absolute inset-0 -z-10 size-full object-cover opacity-60" />
        ) : (
          <div aria-hidden="true" className="absolute inset-0 -z-10 bg-[radial-gradient(80%_110%_at_80%_0%,color-mix(in_oklab,var(--tint)_34%,transparent)_0%,color-mix(in_oklab,var(--tint)_12%,var(--color-ink))_50%,var(--color-ink)_100%)]" />
        )}
        <div aria-hidden="true" className="absolute inset-0 -z-10 bg-gradient-to-t from-ink via-ink/70 to-ink/20" />
        <div aria-hidden="true" className="absolute inset-0 -z-10 bg-gradient-to-r from-ink/70 via-transparent to-transparent" />
        {/* Back sits over the banner's top corner, so the banner starts at the top of the page. */}
        <Link
          to={lib ? (kind === 'movie' ? '/library/movies' : '/library/shows') : '/discover'}
          viewTransition
          className="absolute top-3 left-3 z-10 inline-flex min-h-11 items-center gap-1 rounded-full bg-ink/55 px-3.5 text-sm font-medium text-text no-underline backdrop-blur hover:bg-ink/80 hover:text-text sm:top-4 sm:left-4"
        >
          ← {lib ? (kind === 'movie' ? 'Movies' : 'Shows') : 'Discover'}
        </Link>
        <div className="relative flex flex-wrap items-end gap-6 px-5 pt-16 pb-7 sm:pt-24 sm:gap-8 sm:px-10 sm:pb-9">
          <Poster title={title} path={lib?.posterPath ?? c?.posterPath} color={color} transition={lib ? posterTransition(href) : undefined} size="w500" className="w-[112px] flex-none shadow-2xl sm:w-[190px]" />
          <div className="flex min-w-[260px] flex-1 flex-col gap-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-soft">
              {cert && <span className="rounded border border-white/35 px-1.5 py-px text-caption font-semibold tracking-wide text-text">{cert}</span>}
              {/* A no-break space keeps each slash on the line before it when the facts wrap. */}
              <span>{facts.join('\u00a0· ')}</span>
            </div>
            <h1 className="m-0 font-display text-display leading-[0.95] font-normal text-balance sm:text-display-lg">{title}</h1>
            {info?.tagline && <p className="m-0 text-body text-soft italic">{info.tagline}</p>}
            {info && <Scores r={info.ratings} />}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <StatusLine kind={kind} movie={movie} show={show} info={info} active={active[0]} />
              {admin && lib && <WantedToggle compact offLabel="Not wanted" path={`/${kind === 'movie' ? 'movies' : 'shows'}/${lib.id}/wanted`} wanted={lib.monitored} label={`Wanted: Marquee looks for ${lib.title} by itself`} />}
            </div>
            <Actions kind={kind} info={info} lib={lib} admin={admin} onTrailer={() => setTrailer(true)} onFind={() => setFinding({})} onReport={() => setReporting(true)} />
            {info && info.watchOn.length > 0 && <WatchOn list={info.watchOn} />}
          </div>
        </div>
      </section>

      {info?.request && info.request.state !== 'ready' && info.request.state !== 'declined' && <RequestProgress r={info.request} />}
      {lib && <SomethingWrong kind={kind} id={lib.id} seasons={show?.seasons} open={reporting} onClose={() => setReporting(false)} />}

      {(lib?.overview ?? c?.overview) && <p className="m-0 max-w-[720px] text-heading leading-relaxed text-soft">{lib?.overview ?? c?.overview}</p>}

      {admin && active.length > 0 && downloads.data && (
        <section aria-labelledby="on-way" className="flex flex-col gap-3">
          <h2 id="on-way" className="m-0 text-lg font-semibold">
            On its way
          </h2>
          <DownloadList view={{ ...downloads.data, items: active }} showTitle={kind === 'series'} />
        </section>
      )}

      {show && <Seasons show={show} admin={admin} onFind={(season, episode) => setFinding({ season, ...(episode !== undefined ? { episode } : {}) })} />}

      {info && info.cast.length > 0 && <Cast cast={info.cast} />}
      {info && <Details info={info} kind={kind} />}
      {admin && lib && <History kind={kind} lib={lib} />}
      {admin && lib && <NeverPick kind={kind} lib={lib} />}
      {info?.similar && <Row row={info.similar} trailers={prefs?.trailers ?? true} />}
      {lib?.path && (
        <div className="flex flex-col gap-0.5 text-xs break-all text-dim">
          <p className="m-0">Folder on disk: {lib.path}</p>
          {movie?.files.map((f) => (
            <p key={f.id} className="m-0">
              File: {f.path}
            </p>
          ))}
        </div>
      )}

      {admin && lib && (
        <Sheet open={finding !== null} onClose={() => setFinding(null)} title={finding?.episode !== undefined ? `Find a copy of episode ${finding.episode}` : finding?.season !== undefined ? `Find copies of season ${finding.season}` : `Find a copy of ${title}`} size="full">
          {finding && (
            <CopiesPanel
              bare
              autoSearch
              kind={kind === 'movie' ? 'movie' : 'tv'}
              titleId={lib.id}
              profile={lib.profile}
              byHand={lib.profileByHand}
              {...(show ? { seasons: show.seasons.map((x) => ({ season: x.season, episodes: x.episodes.map((e) => e.episode) })) } : {})}
              {...(finding.season !== undefined ? { start: { season: finding.season, ...(finding.episode !== undefined ? { episode: finding.episode } : {}) } } : {})}
              />
          )}
        </Sheet>
      )}
    </>
  );
}

// ---------------- Hero parts ----------------

/** TMDB, IMDb, Rotten Tomatoes and Metacritic, each with its own label. */
function Scores({ r }: { r: TitleRatings }) {
  const items: { label: string; value: string; title: string; mark: React.ReactNode; href?: string; tone?: string }[] = [];
  if (r.tmdb) items.push({ label: 'TMDB', mark: <TmdbMark />, value: r.tmdb.score.toFixed(1), title: `TMDB: ${r.tmdb.score.toFixed(1)} out of 10 from ${r.tmdb.votes.toLocaleString()} votes` });
  if (r.imdb) items.push({ label: 'IMDb', mark: <ImdbMark />, value: r.imdb.score.toFixed(1), title: `IMDb: ${r.imdb.score.toFixed(1)} out of 10 from ${r.imdb.votes.toLocaleString()} votes`, ...(r.imdbId ? { href: `https://www.imdb.com/title/${r.imdbId}/` } : {}) });
  if (r.rottenTomatoes !== null)
    items.push({ label: 'Rotten Tomatoes', mark: <TomatoMark score={r.rottenTomatoes} />, value: `${r.rottenTomatoes}%`, title: `Rotten Tomatoes critics: ${r.rottenTomatoes}% (${r.rottenTomatoes >= 60 ? 'fresh' : 'rotten'})` });
  if (r.metacritic !== null) items.push({ label: 'Metacritic', mark: <MetacriticMark score={r.metacritic} />, value: String(r.metacritic), title: `Metacritic: ${r.metacritic} out of 100` });
  if (!items.length) return null;
  return (
    <ul aria-label="Scores" className="m-0 flex list-none flex-wrap gap-2 p-0">
      {items.map((i) => {
        const body = (
          <>
            {i.mark}
            <span className={cx('text-body font-bold tabular-nums', i.tone ?? 'text-text')}>{i.value}</span>
          </>
        );
        return (
          <li key={i.label} title={i.title}>
            {i.href ? (
              <a href={i.href} target="_blank" rel="noreferrer" aria-label={i.title} className="flex min-h-11 items-center gap-1.5 rounded-lg bg-ink/60 px-3 no-underline backdrop-blur hover:bg-ink/80">
                {body}
              </a>
            ) : (
              <span aria-label={i.title} className="flex min-h-11 items-center gap-1.5 rounded-lg bg-ink/60 px-3 backdrop-blur">
                {body}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** One plain sentence: where this title stands right now. */
function StatusLine({ kind, movie, show, info, active }: { kind: 'movie' | 'series'; movie?: MovieDetail; show?: ShowDetail; info?: DiscoverTitle; active?: DownloadView }) {
  let tone: 'good' | 'busy' | 'wait' | 'quiet' = 'quiet';
  let text: string | null = null;
  let progress: number | null = null;
  const d = info?.details;
  if (active) {
    tone = 'busy';
    text = active.status.label;
    progress = active.progress > 0 ? Math.round(active.progress * 100) : null;
  } else if (movie && movie.files[0]) {
    tone = 'good';
    // What "Your copy" used to say, in one line: quality, how it was made, and size.
    const size = formatBytes(movie.files.reduce((n, f) => n + f.sizeBytes, 0));
    if (movie.files.length > 1) text = `In your library · ${movie.files.length} copies (${[...new Set(movie.files.map((f) => f.quality.label))].join(', ')}) · ${size}`;
    else {
      const q = movie.files[0].quality;
      text = ['In your library', q.label, [q.source, q.hdr, q.codec].filter(Boolean).join(', ') || null, q.group ? `by ${q.group}` : null, size].filter(Boolean).join(' · ');
    }
  } else if (show) {
    const real = show.seasons.filter((s) => s.season !== 0);
    const have = real.reduce((n, s) => n + s.have, 0);
    const aired = real.reduce((n, s) => n + s.aired, 0);
    tone = aired > 0 && have >= aired ? 'good' : have > 0 ? 'wait' : 'quiet';
    text = aired === 0 ? 'No episodes out yet' : have >= aired ? `All ${aired} episodes in your library` : `${have} of ${aired} episodes in your library`;
    if (d?.nextAirDate) text += ` · next episode ${pretty(d.nextAirDate)}`;
    else if (show.status === 'Ended') text += ' · the show has ended';
  } else if (info?.request && info.request.state !== 'declined') {
    // The request's progress strip below says it; don't say it twice.
    return null;
  } else if (kind === 'movie' && d && d.stage !== 'out') {
    tone = 'wait';
    const home = d.homeRelease ? `${d.homeRelease.known ? '' : 'around '}${pretty(d.homeRelease.date)}` : null;
    const cinema = d.releases.find((r) => r.kind === 'Theatrical')?.date ?? d.releaseDate;
    text = d.stage === 'cinemas' ? `In cinemas now${home ? ` · to stream or buy ${home}` : ''}` : `In cinemas ${cinema ? pretty(cinema) : 'later'}${home ? ` · to stream or buy ${home}` : ''}`;
  } else if (movie) {
    tone = movie.monitored ? 'wait' : 'quiet';
    text = movie.monitored ? 'Not on disk yet · Marquee is looking for it' : 'Not on disk';
  } else if (info?.card.state === 'declined' && info.request) {
    tone = 'wait';
    text = info.request.stateText;
  }
  if (!text) return null;
  const dot = { good: 'bg-teal', busy: 'bg-blue', wait: 'bg-amber', quiet: 'bg-line-strong' }[tone];
  return (
    <div role="status" className="flex max-w-[560px] flex-col gap-2">
      <p className="m-0 flex items-start gap-2.5 text-body text-text">
        <span aria-hidden="true" className={cx('mt-2 size-2 flex-none rounded-full', dot, tone === 'busy' && 'animate-pulse motion-reduce:animate-none')} />
        {text}
      </p>
      {progress !== null && <Progress value={progress} className="h-1.5 max-w-[420px]" />}
    </div>
  );
}

/** "Watch in Plex" / "Watch in Jellyfin": opens the title in each server that has it. Nothing shows until one does. */
function WatchButtons({ kind, id }: { kind: 'movie' | 'series'; id: number }) {
  const { data } = useQuery({
    queryKey: ['watch-links', kind, id],
    queryFn: () => api<{ links: WatchLink[] }>(`/${kind === 'movie' ? 'movies' : 'shows'}/${id}/watch`),
    staleTime: 5 * 60_000,
    retry: false,
  });
  return (
    <>
      {data?.links.map((l) => (
        <a
          key={l.server}
          href={l.url}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex h-12 items-center gap-2 rounded-full border border-white/30 px-5 text-body font-semibold text-text no-underline hover:bg-white/10 hover:text-text"
        >
          Watch in {l.server}
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      ))}
    </>
  );
}

/** Trailer, asking for it, finding a copy, watching, and More, in one row. */
function Actions({ kind, info, lib, admin, onTrailer, onFind, onReport }: { kind: 'movie' | 'series'; info?: DiscoverTitle; lib?: MovieDetail | ShowDetail; admin: boolean; onTrailer: () => void; onFind: () => void; onReport: () => void }) {
  const navigate = useNavigate();
  const { ask, busy, message } = useRequest();
  const [picking, setPicking] = useState(false);
  // Admins manage a title already in the library with Wanted and Find, not requests.
  const canAsk = !!info?.canRequest && !(lib && admin);
  async function request(seasons?: number[]) {
    if (!info) return;
    const r = await ask(info.card, seasons);
    setPicking(false);
    // An approved request has a library page: go there, where it shows what happens next.
    if (r?.href && !lib) navigate(r.href, { replace: true });
  }
  return (
    <div className="flex flex-col gap-2 pt-1">
      <div className="flex flex-wrap items-center gap-3">
        {canAsk && (
          <Button type="button" disabled={busy !== null} onClick={() => (kind === 'series' && info!.seasons.length > 1 ? setPicking(true) : request())} className="h-12 rounded-full px-6">
            {busy !== null ? 'Asking…' : lib ? 'Ask for the rest' : 'Request'}
          </Button>
        )}
        {info?.trailerKey && (
          <button type="button" onClick={onTrailer} className="inline-flex h-12 items-center gap-2 rounded-full bg-white px-6 text-body font-semibold text-ink hover:bg-amber">
            <span aria-hidden="true">▶</span> Trailer
          </button>
        )}
        {admin && lib && kind === 'movie' && (
          <button type="button" onClick={onFind} className="inline-flex h-12 items-center rounded-full border border-white/30 px-5 text-body font-semibold text-text hover:bg-white/10">
            {(lib as MovieDetail).files.length ? 'Find a better copy' : 'Find a copy'}
          </button>
        )}
        {lib && <WatchButtons kind={kind} id={lib.id} />}
        {admin && lib && <TitleTools kind={kind} id={lib.id} title={lib.year ? `${lib.title} (${lib.year})` : lib.title} onReport={onReport} />}
        {!admin && lib && (
          <button type="button" onClick={onReport} className="inline-flex min-h-12 items-center px-2 text-sm font-medium text-soft hover:text-text">
            Something wrong?
          </button>
        )}
      </div>
      {info?.collection && (
        <Link to={`/collections/${info.collection.tmdbId}`} className="self-start text-sm font-semibold">
          Part of {info.collection.name} →
        </Link>
      )}
      {canAsk && !admin && <RequestsLeft />}
      {info?.note && !info.canRequest && !lib && info.card.state === 'none' && <p className="m-0 text-sm text-soft">{info.note}</p>}
      {message && <Notice tone="error">{message}</Notice>}
      {info && kind === 'series' && (
        <Sheet open={picking} onClose={() => setPicking(false)} title={`Ask for ${info.card.title}`}>
          <SeasonPicker info={info} busy={busy !== null} onAsk={request} />
        </Sheet>
      )}
    </div>
  );
}

function SeasonPicker({ info, busy, onAsk }: { info: DiscoverTitle; busy: boolean; onAsk: (seasons?: number[]) => void }) {
  const open = info.seasons.filter((s) => s.state === 'none');
  const [picked, setPicked] = useState<Set<number>>(new Set(open.map((s) => s.season)));
  const toggle = (n: number) => setPicked((p) => new Set(p.has(n) ? [...p].filter((x) => x !== n) : [...p, n]));
  const all = picked.size === open.length;
  const STATE: Record<string, string> = { in_library: 'In your library', approved: 'Asked for', pending: 'Asked for', downloading: 'Downloading' };
  return (
    <div className="flex flex-col gap-4 p-5 sm:p-6">
      <fieldset className="m-0 flex flex-col border-0 p-0">
        <legend className="mb-2 text-sm text-muted">Which seasons?</legend>
        {info.seasons.map((s) => (
          <label key={s.season} className={cx('flex min-h-12 items-center gap-3 border-t border-line text-body', s.state !== 'none' && 'opacity-60')}>
            <input type="checkbox" className="size-5 accent-amber" disabled={s.state !== 'none'} checked={s.state !== 'none' || picked.has(s.season)} onChange={() => toggle(s.season)} />
            <span className="flex-1">
              Season {s.season} <span className="text-dim">· {s.episodeCount} episodes</span>
            </span>
            {STATE[s.state] && <span className="text-xs text-muted">{STATE[s.state]}</span>}
          </label>
        ))}
      </fieldset>
      <Button type="button" disabled={busy || picked.size === 0} onClick={() => onAsk(all ? undefined : [...picked].sort((a, b) => a - b))}>
        {busy ? 'Asking…' : all ? (open.length === info.seasons.length ? 'Request the whole show' : 'Request every season left') : `Request ${picked.size === 1 ? 'this season' : `these ${picked.size} seasons`}`}
      </Button>
      <p className="m-0 text-xs text-dim">An admin approves requests from members and kids. Admins’ go straight through.</p>
    </div>
  );
}

function WatchOn({ list }: { list: DiscoverTitle['watchOn'] }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm text-soft">
      <span>Streaming on</span>
      {list.slice(0, 6).map((p) =>
        p.logoPath ? (
          <img onError={(e) => (e.currentTarget.style.visibility = 'hidden')} key={p.name} src={tmdbImage(p.logoPath, 'w185')!} alt={p.name} title={p.name} className="size-8 rounded-lg" />
        ) : (
          <span key={p.name} className="rounded-lg bg-white/10 px-2 py-1 text-text">{p.name}</span>
        ),
      )}
    </div>
  );
}

// ---------------- Request progress ----------------

const STEP_OF: Record<RequestState, number> = { pending: 0, unreleased: 1, searching: 1, looking: 1, downloading: 2, ready: 3, declined: 0 };

/** Asked → approved and looking → downloading → ready, with the plain sentence for where it is now. */
function RequestProgress({ r }: { r: RequestView }) {
  const at = STEP_OF[r.state];
  const finding = r.state === 'unreleased' ? 'Waiting for it to come out' : r.state === 'searching' ? 'Searching now' : r.state === 'looking' ? 'Still looking' : 'Found a copy';
  const steps = [r.state === 'pending' ? 'Waiting for an OK' : 'Approved', at >= 2 ? 'Found a copy' : finding, 'Downloading', 'Ready to watch'];
  return (
    <section aria-label="Your request" className="flex flex-col gap-3 rounded-2xl border border-line bg-panel px-5 py-4">
      <ol className="m-0 grid list-none grid-cols-4 gap-2 p-0">
        {steps.map((s, i) => (
          <li key={i} aria-current={i === at ? 'step' : undefined} className="flex flex-col gap-1.5">
            <span className={cx('h-1 rounded-full', i < at ? 'bg-teal' : i === at ? 'bg-blue' : 'bg-line-strong', i === at && r.state !== 'pending' && 'animate-pulse motion-reduce:animate-none')} />
            <span className={cx('text-caption leading-snug', i <= at ? 'font-semibold text-text' : 'text-dim')}>{s}</span>
          </li>
        ))}
      </ol>
      <p className="m-0 text-sm text-soft">
        {r.stateText}
        {r.requestedBy && <span className="text-dim"> · asked by {r.requestedBy.name}</span>}
      </p>
    </section>
  );
}

// ---------------- Show: seasons and episodes ----------------

function Seasons({ show, admin, onFind }: { show: ShowDetail; admin: boolean; onFind: (season: number, episode?: number) => void }) {
  // The latest season with something missing opens first; otherwise none.
  const firstGap = [...show.seasons].reverse().find((s) => s.season !== 0 && s.aired > s.have);
  const [open, setOpen] = useState<Set<number>>(new Set(firstGap ? [firstGap.season] : []));
  const toggle = (n: number) => setOpen((prev) => new Set(prev.has(n) ? [...prev].filter((x) => x !== n) : [...prev, n]));
  const ordered = [...show.seasons.filter((s) => s.season !== 0), ...show.seasons.filter((s) => s.season === 0)];
  return (
    <section aria-labelledby="seasons-h" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 id="seasons-h" className="m-0 text-lg font-semibold">
          Seasons
        </h2>
        {admin && <ShowEpisodesChoice showId={show.id} />}
      </div>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {ordered.map((s) => (
          <SeasonRow key={s.season} s={s} show={show} admin={admin} open={open.has(s.season)} onToggle={() => toggle(s.season)} onFind={onFind} />
        ))}
      </ul>
    </section>
  );
}

function SeasonRow({ s, show, admin, open, onToggle, onFind }: { s: SeasonView; show: ShowDetail; admin: boolean; open: boolean; onToggle: () => void; onFind: (season: number, episode?: number) => void }) {
  const [up, setUp] = useState<number | null>(null);
  const label = s.season === 0 ? 'Specials' : `Season ${s.season}`;
  const done = s.aired > 0 && s.have >= s.aired;
  const pct = s.aired ? Math.round((s.have / s.aired) * 100) : 0;
  const id = `season-${s.season}`;
  return (
    <li className="overflow-hidden rounded-2xl border border-line bg-panel">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2 sm:px-5">
        <button type="button" onClick={onToggle} aria-expanded={open} aria-controls={id} className="flex min-h-12 min-w-[200px] flex-1 items-center gap-4 text-left text-text">
          <span aria-hidden="true" className={cx('text-muted transition-transform motion-reduce:transition-none', open && 'rotate-90')}>
            ›
          </span>
          <span className="flex flex-1 flex-col gap-1.5">
            <span className="flex items-baseline justify-between gap-3">
              <span className="text-heading font-semibold">{label}</span>
              <span className={cx('text-sm tabular-nums', done ? 'text-teal-hi' : s.have === 0 ? 'text-dim' : 'text-amber-hi')}>{s.aired === 0 ? 'Not out yet' : `${s.have} of ${s.aired}`}</span>
            </span>
            {s.aired > 0 && <Progress value={pct} color={done ? 'bg-teal' : 'bg-amber'} className="h-1" />}
          </span>
        </button>
        {admin && (
          <span className="flex items-center gap-1">
            {show.monitored && <WantedToggle compact path={`/shows/${show.id}/seasons/${s.season}/wanted`} wanted={s.episodes.length > 0 && s.episodes.every((e) => e.wanted)} label={`${label}: wanted`} />}
            {!done && s.aired > 0 && (
              <button type="button" onClick={() => onFind(s.season)} className="inline-flex min-h-11 items-center rounded-full border border-line-strong px-4 text-sm font-medium text-text hover:bg-raised">
                Find copies
              </button>
            )}
          </span>
        )}
      </div>
      {open && (
        <ol id={id} className="m-0 list-none border-t border-line p-0">
          {s.episodes.map((e) => (
            <li key={e.episode} className="flex items-center gap-x-3 border-b border-line px-4 py-2 last:border-b-0 sm:gap-x-4 sm:px-5">
              <span className="w-6 flex-none text-sm font-semibold text-muted tabular-nums sm:w-8">{e.episode}</span>
              <span className="flex min-w-0 flex-1 flex-col">
                {admin ? (
                  <button type="button" onClick={() => setUp(e.episode)} className="min-h-11 text-left text-body text-text underline-offset-4 hover:underline" aria-label={`Episode ${e.episode}: ${e.title ?? 'details'}. Open its file and downloads`}>
                    {e.title ?? `Episode ${e.episode}`}
                  </button>
                ) : (
                  <span className="text-body">{e.title ?? `Episode ${e.episode}`}</span>
                )}
                <span className="text-xs text-dim">
                  {e.airDate ? pretty(e.airDate) : 'No date yet'}
                  {/* On phones the state sits under the name, so the name keeps the width. */}
                  <span className={cx('font-semibold sm:hidden', e.file ? 'text-soft' : e.aired ? 'text-warn' : 'text-dim')}> · {episodeState(e)}</span>
                </span>
              </span>
              <span className={cx('text-xs font-semibold max-sm:hidden', e.file ? 'text-soft' : e.aired ? 'text-warn' : 'text-dim')}>{episodeState(e)}</span>
              {admin && show.monitored && <WantedToggle compact path={`/shows/${show.id}/seasons/${s.season}/episodes/${e.episode}/wanted`} wanted={e.wanted} label={`Episode ${e.episode}: wanted`} />}
              {admin && e.aired && (
                <button type="button" onClick={() => onFind(s.season, e.episode)} aria-label={`Find a copy of episode ${e.episode}`} className="inline-flex min-h-11 items-center rounded-full px-3 text-sm font-medium text-amber hover:bg-raised">
                  {e.file ? 'Replace' : 'Find'}
                </button>
              )}
            </li>
          ))}
        </ol>
      )}
      {admin && up !== null && <EpisodeSheet show={show} season={s.season} episode={up} onClose={() => setUp(null)} />}
    </li>
  );
}

/**
 * One episode up close: its file, the downloads in qBittorrent that hold it,
 * and Remove: the file goes to the recycle bin, and if you tick them, the
 * downloads leave qBittorrent with their files.
 */
function EpisodeSheet({ show, season, episode, onClose }: { show: ShowDetail; season: number; episode: number; onClose: () => void }) {
  const toast = useToast();
  const base = `/shows/${show.id}/seasons/${season}/episodes/${episode}`;
  const q = useQuery({ queryKey: ['episode', show.id, season, episode], queryFn: () => api<EpisodeDetailView>(base) });
  const [removing, setRemoving] = useState(false);
  const [stopWanting, setStopWanting] = useState(true);
  const [torrents, setTorrents] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const d = q.data;
  const code = `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
  async function remove() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ message: string; problems: string[] }>(`${base}/remove`, { body: { stopWanting, torrents: [...torrents] } });
      toast({ message: r.message });
      if (r.problems.length) toast({ message: r.problems.join(' '), tone: 'error' });
      // The show page, the Library and the recycle bin all change.
      await queryClient.invalidateQueries({ queryKey: ['library'] });
      await queryClient.invalidateQueries({ queryKey: ['cleanup'] });
      onClose();
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : 'That didn’t work. Try again.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet open onClose={onClose} title={`${code} · ${d?.title ?? `Episode ${episode}`}`}>
      <div className="flex flex-col gap-4 pt-1 pb-2">
        {q.isLoading && <p className="m-0 text-muted">Looking…</p>}
        {q.error && <Notice tone="error">{q.error instanceof ApiFailure ? q.error.message : 'Couldn’t load it.'}</Notice>}
        {d && (
          <>
            <p className="m-0 text-sm text-muted">
              {d.airDate ? `Out ${pretty(d.airDate)}` : 'No date yet'} · {d.wanted ? 'Wanted' : 'Not Wanted'}
            </p>
            {d.overview && <p className="m-0 text-sm text-soft">{d.overview}</p>}
            <section className="flex flex-col gap-2">
              <h3 className="m-0 text-label font-semibold text-muted">In your library</h3>
              {!d.files.length && <p className="m-0 text-sm text-dim">No file.</p>}
              {d.files.map((f) => (
                <div key={f.id} className="flex flex-col gap-0.5 rounded-xl border border-line px-3 py-2">
                  <span className="text-sm text-text">
                    {[f.quality.label, f.quality.source, f.quality.codec, f.quality.group].filter(Boolean).join(' · ')} · {formatBytes(f.sizeBytes)}
                  </span>
                  <span className="font-mono text-xs break-all text-dim">{f.path}</span>
                  <span className="text-caption text-muted">
                    Arrived {new Date(f.addedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                    {f.shared ? ' · shared with a download in qBittorrent' : ''}
                    {f.otherEpisodes.length ? ` · also holds episode ${f.otherEpisodes.join(', ')}` : ''}
                  </span>
                </div>
              ))}
            </section>
            <section className="flex flex-col gap-2">
              <h3 className="m-0 text-label font-semibold text-muted">In qBittorrent</h3>
              {!d.torrents.length && <p className="m-0 text-sm text-dim">No download holds it.</p>}
              {d.torrents.map((t) => (
                <div key={t.hash} className="flex flex-col gap-0.5 rounded-xl border border-line px-3 py-2">
                  <span className="text-sm break-all text-text">{t.name}</span>
                  <span className="text-caption text-muted">
                    {t.followed ? 'Marquee follows it' : 'Another app sent it (found by the shared file)'}
                    {t.wholeSeason ? ' · holds more than this episode' : ''}
                    {t.inDownloader ? '' : ' · not in qBittorrent any more'}
                  </span>
                </div>
              ))}
              {d.downloaderNote && <p className="m-0 text-caption text-warn">{d.downloaderNote}</p>}
            </section>
            {!removing ? (
              <div className="flex flex-wrap gap-3">
                <Button variant="danger" onClick={() => setRemoving(true)} disabled={!d.files.length && !d.torrents.length}>
                  Remove…
                </Button>
                <Button variant="ghost" onClick={onClose}>
                  Close
                </Button>
              </div>
            ) : (
              <div className="flex flex-col gap-3 rounded-xl border border-warn/40 bg-warn/5 p-3">
                <p className="m-0 text-sm text-soft">
                  {d.files.length ? `Its file goes to the recycle bin (Library → Clean up), where you can put it back or delete it for good. Plex and Jellyfin stop showing it.` : 'It has no file in the library.'}
                </p>
                <label className="flex min-h-11 items-center gap-3 text-sm text-text">
                  <input type="checkbox" checked={stopWanting} onChange={(e) => setStopWanting(e.target.checked)} className="size-5 accent-amber" />
                  Stop looking for it, so it isn’t downloaded again
                </label>
                {d.torrents.filter((t) => t.inDownloader).map((t) => (
                  <label key={t.hash} className="flex min-h-11 items-start gap-3 text-sm text-text">
                    <input
                      type="checkbox"
                      checked={torrents.has(t.hash)}
                      onChange={() => setTorrents((x) => new Set(x.has(t.hash) ? [...x].filter((h) => h !== t.hash) : [...x, t.hash]))}
                      className="mt-0.5 size-5 flex-none accent-amber"
                    />
                    <span className="flex flex-col">
                      <span>Also remove it from qBittorrent, with its files</span>
                      <span className="text-caption break-all text-muted">
                        {t.name}
                        {t.wholeSeason ? ' · it holds more than this episode: they stop sharing too (their library files stay)' : ''}
                      </span>
                    </span>
                  </label>
                ))}
                {error && <Notice tone="error">{error}</Notice>}
                <div className="flex flex-wrap gap-3">
                  <Button variant="danger" disabled={busy} onClick={() => void remove()}>
                    {busy ? 'Removing…' : `Remove ${code}`}
                  </Button>
                  <Button variant="ghost" onClick={() => setRemoving(false)}>
                    Keep it
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </Sheet>
  );
}

const episodeState = (e: SeasonView['episodes'][number]) => (e.file ? `${e.file.quality.label} · ${formatBytes(e.file.sizeBytes)}` : e.aired ? 'Missing' : 'Not out yet');

// ---------------- Cast ----------------

function Cast({ cast }: { cast: CastMember[] }) {
  return (
    <section aria-labelledby="cast-h" className="flex flex-col gap-3">
      <h2 id="cast-h" className="m-0 text-lg font-semibold">
        Cast
      </h2>
      <ul className="-mx-4 m-0 flex list-none snap-x scroll-px-4 sm:scroll-px-10 gap-4 overflow-x-auto px-4 pb-2 sm:-mx-10 sm:px-10">
        {cast.map((p) => {
          const img = tmdbImage(p.profilePath, 'w185');
          const body = (
            <>
              <span className="block aspect-[2/3] w-full overflow-hidden rounded-xl bg-raised">
                {img ? (
                  <img src={img} alt="" loading="lazy" onError={(e) => (e.currentTarget.style.visibility = 'hidden')} className="size-full object-cover transition duration-200 group-hover:scale-[1.03] motion-reduce:transition-none" />
                ) : (
                  <span aria-hidden="true" className="flex size-full items-center justify-center font-display text-3xl text-dim">
                    {p.name
                      .split(' ')
                      .map((w) => w[0])
                      .slice(0, 2)
                      .join('')}
                  </span>
                )}
              </span>
              <span className="mt-2 block text-label leading-tight font-semibold text-text">{p.name}</span>
              {p.character && <span className="block text-caption leading-snug text-dim">{p.character}</span>}
            </>
          );
          return (
            <li key={`${p.id}${p.name}`} className="w-[112px] flex-none snap-start">
              {p.id ? (
                <Link to={`/discover/person/${p.id}`} className="group block no-underline">
                  {body}
                </Link>
              ) : (
                body
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ---------------- Details ----------------

function Details({ info, kind }: { info: DiscoverTitle; kind: 'movie' | 'series' }) {
  const d = info.details;
  const rows: [string, string | null][] = [
    [kind === 'movie' ? 'Directed by' : 'Created by', d.directors.join(', ') || null],
    ['Written by', d.writers.join(', ') || null],
    [kind === 'movie' ? 'Studios' : 'Made by', d.studios.slice(0, 3).join(', ') || null],
    ['Seasons', d.seasonCount ? `${d.seasonCount} ${d.seasonCount === 1 ? 'season' : 'seasons'}${d.episodeCount ? `, ${d.episodeCount} episodes` : ''}` : null],
    ['First aired', kind === 'series' && d.releaseDate ? pretty(d.releaseDate) : null],
    ['Last aired', d.lastAirDate ? pretty(d.lastAirDate) : null],
    ['Status', kind === 'series' ? d.status : null],
    ['Language', d.language],
    ['Original title', d.originalTitle],
    ['Made in', d.countries.join(', ') || null],
    ['Budget', d.budget ? money(d.budget) : null],
    ['Box office', d.revenue ? money(d.revenue) : null],
  ];
  const shown = rows.filter(([, v]) => v);
  return (
    <section aria-labelledby="details-h" className="flex flex-col gap-4">
      <h2 id="details-h" className="m-0 text-lg font-semibold">
        Details
      </h2>
      {kind === 'movie' && d.releases.length > 0 && (
        <ol aria-label="Release dates" className="m-0 flex list-none flex-wrap gap-2 p-0">
          {d.releases.map((r) => {
            const past = r.date <= new Date().toISOString().slice(0, 10);
            return (
              <li key={r.kind} className={cx('flex min-w-[140px] flex-col rounded-xl border px-4 py-2.5', past ? 'border-line bg-panel' : 'border-amber/40 bg-amber/6')}>
                <span className="text-xs text-dim">{RELEASE_LABEL[r.kind] ?? r.kind}</span>
                <span className={cx('text-body font-semibold', past ? 'text-soft' : 'text-amber-hi')}>{pretty(r.date)}</span>
              </li>
            );
          })}
          {d.homeRelease && !d.homeRelease.known && d.stage !== 'out' && (
            <li className="flex min-w-[140px] flex-col rounded-xl border border-dashed border-line-strong px-4 py-2.5">
              <span className="text-xs text-dim">To stream or buy (a guess)</span>
              <span className="text-body font-semibold text-soft">Around {pretty(d.homeRelease.date)}</span>
            </li>
          )}
        </ol>
      )}
      <dl className="m-0 grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-x-8 gap-y-3">
        {shown.map(([label, value]) => (
          <div key={label} className="flex flex-col">
            <dt className="text-xs text-dim">{label}</dt>
            <dd className="m-0 text-body text-soft">{value}</dd>
          </div>
        ))}
      </dl>
      {d.homepage && (
        <a href={d.homepage} target="_blank" rel="noreferrer" className="flex min-h-11 items-center self-start text-sm font-semibold">
          Official site
        </a>
      )}
    </section>
  );
}

// ---------------- History ----------------

interface Moment {
  at: number;
  text: string;
  detail: string | null;
  tone: 'good' | 'bad' | 'quiet' | 'watch';
}

/** Downloads (from the History), plays and when it arrived, newest first, in one short timeline. */
function History({ kind, lib }: { kind: 'movie' | 'series'; lib: MovieDetail | ShowDetail }) {
  const [all, setAll] = useState(false);
  const filter = kind === 'movie' ? `movieId=${lib.id}` : `seriesId=${lib.id}`;
  const watchers = useQuery({ queryKey: ['watchers', kind === 'movie' ? 'movie' : 'tv', lib.id], queryFn: () => api<WatchersView>(`/activity/watchers?kind=${kind === 'movie' ? 'movie' : 'tv'}&id=${lib.id}`) });
  const history = useQuery({ queryKey: ['history', `title-${filter}`], queryFn: () => api<HistoryView>(`/history?${filter}&limit=50`), refetchInterval: 30_000 });
  const tone = { good: 'good', bad: 'bad', quiet: 'quiet', busy: 'quiet' } as const;
  const moments: Moment[] = [
    ...(history.data?.items ?? []).map((h): Moment => {
      const what = kind === 'series' ? h.titleName.split(' · ').slice(1).join(' · ') || null : null;
      return {
        at: h.at,
        text: `${h.label}${what ? ` · ${what}` : ''}`,
        detail: (h.event === 'sent' ? copyFacts(h) : h.detail) ?? null,
        tone: tone[h.tone],
      };
    }),
    ...(watchers.data?.watchers ?? []).map(
      (w): Moment => ({
        at: w.last,
        text: `${w.user} watched it`,
        detail: w.episodes !== null ? `${w.episodes} ${w.episodes === 1 ? 'episode' : 'episodes'} so far` : w.plays > 1 ? `${w.plays} times` : null,
        tone: 'watch',
      }),
    ),
    { at: lib.addedAt, text: 'Added to your library', detail: null, tone: 'quiet' as const },
  ].sort((a, b) => b.at - a.at);
  const shown = all ? moments : moments.slice(0, 4);
  const dot = { good: 'bg-teal', bad: 'bg-warn', quiet: 'bg-line-strong', watch: 'bg-blue' };
  return (
    <section aria-labelledby="history-h" className="flex flex-col gap-3">
      <h2 id="history-h" className="m-0 text-lg font-semibold">
        History
      </h2>
      <ol className="m-0 flex list-none flex-col border-l border-line p-0 pl-5">
        {shown.map((m, i) => (
          <li key={i} className="relative flex flex-wrap items-baseline gap-x-3 py-2">
            <span aria-hidden="true" className={cx('absolute top-[15px] -left-[24.5px] size-2 rounded-full ring-4 ring-ink', dot[m.tone])} />
            <span className="text-body text-soft">{m.text}</span>
            {m.detail && <span className="text-sm text-dim">{m.detail}</span>}
            <time className="ml-auto text-sm text-dim tabular-nums">{day(m.at)}</time>
          </li>
        ))}
      </ol>
      {moments.length > 4 && (
        <button type="button" onClick={() => setAll(!all)} className="min-h-11 self-start text-sm font-medium text-amber">
          {all ? 'Show less' : `Show all ${moments.length}`}
        </button>
      )}
      {kind === 'movie' && (history.data?.items.length ?? 0) === 0 && (watchers.data?.watchers.length ?? 0) === 0 && <p className="m-0 text-sm text-dim">Nothing else has happened to it yet.</p>}
      {(history.data?.items.length ?? 0) > 0 && (
        <Link to={`/downloads/history?${filter}`} className="flex min-h-11 items-center self-start text-sm">
          Every download of it, in the History
        </Link>
      )}
    </section>
  );
}

/** Copies turned down for this title, which searches skip, with Remove from list. Only shown when there are some. */
function NeverPick({ kind, lib }: { kind: 'movie' | 'series'; lib: MovieDetail | ShowDetail }) {
  const q = useNeverPick(kind === 'movie' ? { movieId: lib.id } : { seriesId: lib.id });
  const items = q.data?.items ?? [];
  if (!items.length) return null;
  return (
    <section aria-labelledby="never-h" className="flex flex-col gap-2">
      <h2 id="never-h" className="m-0 text-lg font-semibold">
        Never pick
      </h2>
      <p className="m-0 max-w-[640px] text-sm text-muted">
        {items.length === 1 ? 'A copy' : `${items.length} copies`} Marquee turned down for this {kind === 'movie' ? 'movie' : 'show'}. Searches skip {items.length === 1 ? 'it' : 'them'}; Remove from list lets Marquee pick {items.length === 1 ? 'it' : 'one'} again.
      </p>
      <NeverPickList items={items} showTitle={false} />
    </section>
  );
}
