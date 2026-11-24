import { CalendarLink } from '../components/Family';
import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import type { CalendarItem, CalendarView } from '@marquee/shared';
import { ApiFailure, api } from '../api';
import { Poster } from '../components/Poster';
import { Button, Notice, cx } from '../components/ui';
import { Chips, PageHeader } from '../components/Page';

/**
 * The calendar: episodes of the shows in your library and Wanted movies
 * coming out (in cinemas, to stream or buy, on disc), day by day, each saying
 * whether it's here, on the way, missing or still to come.
 */

const DAY = 86_400_000;
const SPAN = 21;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const STATE: Record<CalendarItem['state'], { label: string; tone: string }> = {
  have: { label: 'In your library', tone: 'text-teal-hi' },
  downloading: { label: 'Downloading', tone: 'text-amber-hi' },
  missing: { label: 'Not here yet', tone: 'text-warn' },
  coming: { label: 'Coming', tone: 'text-soft' },
  not_watched: { label: 'Not wanted', tone: 'text-dim' },
};

function dayLabel(day: string, today: string): string {
  const diff = Math.round((Date.parse(day) - Date.parse(today)) / DAY);
  const date = new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' });
  return diff === 0 ? `Today · ${date}` : diff === 1 ? `Tomorrow · ${date}` : diff === -1 ? `Yesterday · ${date}` : date;
}

export function CalendarPage() {
  // Start a few days back, so episodes that just aired (and whether they arrived) show too.
  const [from, setFrom] = useState(() => iso(Date.now() - 3 * DAY));
  const q = useQuery({ queryKey: ['calendar', from], queryFn: () => api<CalendarView>(`/calendar?from=${from}&days=${SPAN}`) });
  const v = q.data;
  const shift = (days: number) => setFrom(iso(Date.parse(from) + days * DAY));

  const [only, setOnly] = useState<'all' | 'episode' | 'movie'>('all');
  const days = new Map<string, CalendarItem[]>();
  for (const i of v?.items ?? []) if (only === 'all' || i.kind === only) days.set(i.airDate, [...(days.get(i.airDate) ?? []), i]);

  return (
    <>
      <PageHeader title="Calendar" back={{ to: "/", label: "Home" }} info="New episodes of the shows in your library and the Wanted movies coming out, by day. Dates come from TMDB and are checked twice a day." />
      <Chips
        label="Show"
        value={only}
        onChange={setOnly}
        items={[
          { value: 'all', label: 'Everything' },
          { value: 'episode', label: 'Shows' },
          { value: 'movie', label: 'Movies' },
        ]}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="ghost" className="h-11 px-3.5 text-sm" onClick={() => shift(-14)}>
          ← Earlier
        </Button>
        <Button type="button" variant="ghost" className="h-11 px-3.5 text-sm" onClick={() => setFrom(iso(Date.now() - 3 * DAY))}>
          This week
        </Button>
        <Button type="button" variant="ghost" className="h-11 px-3.5 text-sm" onClick={() => shift(14)}>
          Later →
        </Button>
      </div>
      {q.error && <Notice tone="error">{q.error instanceof ApiFailure ? q.error.message : 'Something went wrong.'}</Notice>}
      {!v && !q.error && <p className="text-muted">Loading…</p>}
      {v && days.size === 0 && (
        <p className="m-0 text-muted">
          Nothing comes out between these dates. Shows in your library appear here once TMDB lists their next episodes, and Wanted movies once TMDB has their dates; add titles from <Link to="/library">Library</Link>.
        </p>
      )}
      {[...days].map(([day, items]) => (
        <section key={day} aria-labelledby={`d-${day}`} className="flex flex-col gap-2">
          <h2 id={`d-${day}`} className={cx('m-0 text-xs font-semibold tracking-[.08em] uppercase', day === v!.today ? 'text-amber' : 'text-dim')}>
            {dayLabel(day, v!.today)}
          </h2>
          <ul className="m-0 flex list-none flex-col p-0">
            {items.map((i) => (
              <li key={i.kind === 'movie' ? `m${i.movieId}:${i.title}` : `${i.seriesId}:${i.season}:${i.episode}`} className="flex items-center gap-4 border-t border-line py-3">
                <Poster title={i.show} path={i.posterPath} size="w185" className="w-12 flex-none rounded-md [&_span]:hidden" />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <Link to={i.kind === 'movie' ? `/movies/${i.movieId}` : `/shows/${i.seriesId}`} className="flex min-h-11 items-center self-start text-body font-semibold">
                    {i.show}
                  </Link>
                  <span className="text-sm text-soft">
                    {i.kind === 'movie' ? (
                      <>
                        <span className="mr-1.5 rounded bg-raised px-1.5 py-0.5 text-caption font-semibold tracking-wide text-muted uppercase">Movie</span>
                        {i.title}
                      </>
                    ) : (
                      <>
                        {i.season === 0 ? 'Special' : `S${i.season} E${i.episode}`}
                        {i.title ? ` · ${i.title}` : ''}
                      </>
                    )}
                  </span>
                  {/* On phones the state goes under the name, so neither is squeezed. */}
                  <span className="text-label sm:hidden">
                    <span className={cx('font-medium', STATE[i.state].tone)}>{STATE[i.state].label}</span>
                    {i.note !== STATE[i.state].label && <span className="text-muted"> · {i.note}</span>}
                  </span>
                </div>
                <div className="flex max-w-[45%] flex-col items-end gap-0.5 text-right max-sm:hidden">
                  <span className={cx('text-sm font-medium', STATE[i.state].tone)}>{STATE[i.state].label}</span>
                  {i.note !== STATE[i.state].label && <span className="text-label text-muted">{i.note}</span>}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
      <CalendarLink />
    </>
  );
}
