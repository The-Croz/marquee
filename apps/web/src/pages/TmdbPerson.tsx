import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import type { DiscoverPrefs, PersonDetail } from '@marquee/shared';
import { api, ApiFailure } from '../api';
import { TitleCard } from '../components/Discover';
import { tmdbImage } from '../components/Poster';
import { Notice } from '../components/ui';
import { Chips, useDocTitle } from '../components/Page';

const pretty = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

function age(birthday: string, deathday: string | null): number {
  const end = deathday ? new Date(`${deathday}T12:00:00Z`) : new Date();
  const b = new Date(`${birthday}T12:00:00Z`);
  let a = end.getUTCFullYear() - b.getUTCFullYear();
  if (end.getUTCMonth() < b.getUTCMonth() || (end.getUTCMonth() === b.getUTCMonth() && end.getUTCDate() < b.getUTCDate())) a--;
  return a;
}

type Filter = 'all' | 'movie' | 'series';

/** An actor or director, and everything they've been in that you could watch or ask for. */
export function TmdbPersonPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['discover', 'person', id], queryFn: () => api<PersonDetail>(`/discover/person/${id}`) });
  const { data: prefs } = useQuery({ queryKey: ['discover', 'prefs'], queryFn: () => api<DiscoverPrefs>('/discover/prefs') });
  const [filter, setFilter] = useState<Filter>('all');
  const [more, setMore] = useState(false);
  useDocTitle(q.data?.name);
  if (q.error) return <Notice tone="error">{q.error instanceof ApiFailure ? q.error.message : 'Couldn’t load that person.'}</Notice>;
  if (!q.data) return <p className="text-muted">Loading…</p>;
  const p = q.data;
  const photo = tmdbImage(p.profilePath, 'w500');
  const credits = p.credits.filter((c) => filter === 'all' || c.kind === filter);
  const movies = p.credits.filter((c) => c.kind === 'movie').length;
  const shows = p.credits.length - movies;
  const born = p.birthday ? `Born ${pretty(p.birthday)}${p.placeOfBirth ? ` in ${p.placeOfBirth}` : ''}${p.deathday ? '' : ` (age ${age(p.birthday, null)})`}` : null;
  const died = p.deathday && p.birthday ? `Died ${pretty(p.deathday)}, aged ${age(p.birthday, p.deathday)}` : null;
  const owned = p.credits.filter((c) => c.state === 'in_library').length;

  return (
    <>
      <button type="button" onClick={() => navigate(-1)} className="-mt-2 flex min-h-11 items-center self-start text-sm text-muted hover:text-text">
        ← Back
      </button>
      <section className="flex flex-wrap items-end gap-6 sm:gap-8">
        <div className="aspect-[2/3] w-[140px] flex-none overflow-hidden rounded-2xl bg-raised shadow-2xl sm:w-[190px]">{photo && <img src={photo} alt="" onError={(e) => (e.currentTarget.style.visibility = 'hidden')} className="size-full object-cover" />}</div>
        <div className="flex min-w-[260px] flex-1 flex-col gap-3">
          {p.knownFor && <span className="text-sm text-soft">{p.knownFor === 'Acting' ? 'Actor' : p.knownFor}</span>}
          <h1 className="m-0 font-display text-display leading-[0.95] font-normal sm:text-display-lg">{p.name}</h1>
          {(born || died) && <p className="m-0 text-sm text-muted">{[born, died].filter(Boolean).join('. ')}</p>}
          <p className="m-0 text-sm text-soft">
            {movies > 0 && `${movies} ${movies === 1 ? 'movie' : 'movies'}`}
            {movies > 0 && shows > 0 && ' and '}
            {shows > 0 && `${shows} ${shows === 1 ? 'show' : 'shows'}`}
            {owned > 0 && <span className="text-teal-hi"> · {owned} in your library</span>}
          </p>
        </div>
      </section>
      {p.biography && (
        <div className="flex max-w-[720px] flex-col gap-1">
          <p className={more ? 'm-0 leading-relaxed whitespace-pre-line text-soft' : 'm-0 line-clamp-4 leading-relaxed text-soft'}>{p.biography}</p>
          {p.biography.length > 360 && (
            <button type="button" onClick={() => setMore(!more)} className="min-h-11 self-start text-sm font-medium text-amber">
              {more ? 'Show less' : 'Read more'}
            </button>
          )}
        </div>
      )}
      <section aria-labelledby="credits-h" className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="credits-h" className="m-0 text-lg font-semibold">
            Known for
          </h2>
          {movies > 0 && shows > 0 && (
            <Chips<Filter>
              label="Show"
              value={filter}
              onChange={setFilter}
              items={[
                { value: 'all', label: 'Everything', count: p.credits.length },
                { value: 'movie', label: 'Movies', count: movies },
                { value: 'series', label: 'Shows', count: shows },
              ]}
            />
          )}
        </div>
        {credits.length === 0 ? (
          <p className="m-0 text-sm text-muted">
            Nothing to show here. <Link to="/discover">Browse Discover</Link> instead.
          </p>
        ) : (
          <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-x-4 gap-y-6 p-0">
            {credits.map((c) => (
              <li key={`${c.kind}${c.tmdbId}`} className="flex flex-col gap-1">
                <TitleCard card={c} trailers={prefs?.trailers ?? true} className="w-full" />
                {c.role && <span className="line-clamp-2 text-caption text-dim">{c.role}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
