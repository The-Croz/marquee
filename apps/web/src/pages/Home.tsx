import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import type { HomeData } from '@marquee/shared';
import { api } from '../api';
import { Button, Card, Notice, Progress } from '../components/ui';

export function HomePage() {
  const { data, error, isLoading } = useQuery({ queryKey: ['home'], queryFn: () => api<HomeData>('/home') });

  if (isLoading) return <p className="text-muted">Loading…</p>;
  if (error || !data) return <Notice tone="error">Couldn't load the home screen.</Notice>;

  return (
    <>
      <div className="flex flex-wrap items-center gap-4">
        <label htmlFor="q" className="sr-only">
          Search
        </label>
        <input
          id="q"
          type="search"
          placeholder="Search movies and shows, or paste an IMDb / Letterboxd link"
          className="h-12 flex-[1_1_360px] rounded-xl border border-line bg-panel px-[18px] text-[15px] text-text placeholder:text-dim focus:border-amber focus:outline-none"
        />
      </div>

      {data.sample && <Notice>You're looking at sample data. Real numbers show up here as each milestone lands.</Notice>}

      {data.nowDownloading && (
        <section aria-label="Now downloading" className="relative flex min-h-[340px] overflow-hidden rounded-[20px] bg-[#3A2412]">
          <div className="absolute inset-0 bg-gradient-to-r from-ink/95 via-ink/70 to-ink/10" />
          <div className="relative flex max-w-[640px] flex-col justify-end gap-4 px-6 py-10 sm:px-12">
            <div className="text-[13px] font-semibold tracking-[1.4px] text-amber uppercase">Downloading now · requested by {data.nowDownloading.requestedBy}</div>
            <h1 className="m-0 font-display text-[56px] leading-[0.95] font-normal sm:text-[72px]">{data.nowDownloading.title}</h1>
            <div className="flex flex-wrap gap-2 text-[13px]">
              <span className="rounded-full bg-amber/16 px-2.5 py-1 font-semibold text-amber-hi">{data.nowDownloading.quality}</span>
              <span className="rounded-full bg-white/8 px-2.5 py-1 text-soft">{data.nowDownloading.profile}</span>
              <span className="rounded-full bg-white/8 px-2.5 py-1 text-soft">{data.nowDownloading.size}</span>
            </div>
            <div className="flex max-w-[480px] flex-col gap-2">
              <Progress value={data.nowDownloading.percent} />
              <div className="flex justify-between gap-4 text-[13px] text-soft">
                <span>
                  {data.nowDownloading.percent}% · {data.nowDownloading.speed}
                </span>
                <span>{data.nowDownloading.eta}, then straight to Plex and Jellyfin</span>
              </div>
            </div>
            <div className="flex gap-3 pt-1.5">
              <Link to="/movies" className="inline-flex h-11 items-center rounded-xl bg-amber px-5 text-[15px] font-semibold text-amber-ink no-underline hover:bg-amber-hi hover:text-amber-ink">
                Open title
              </Link>
              <Button variant="ghost" className="border-white/20 hover:bg-white/10">
                Pause
              </Button>
            </div>
          </div>
        </section>
      )}

      <section aria-label="At a glance" className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-3 sm:gap-4">
        {data.stats.map((s) => (
          <div key={s.label} className="flex flex-col gap-1.5 rounded-2xl border border-line bg-panel px-[22px] py-5">
            <div className="text-[13px] text-muted">{s.label}</div>
            <div className="text-3xl font-semibold tracking-tight">{s.value}</div>
            <div className="text-[13px] text-dim">{s.note}</div>
          </div>
        ))}
      </section>

      {(data.approvals.length > 0 || data.watching.length > 0) && (
        <div className="flex flex-wrap gap-6">
          {data.approvals.length > 0 && (
            <Card aria-labelledby="okh" className="flex min-w-0 flex-[1_1_420px] flex-col gap-4">
              <div className="flex items-baseline justify-between">
                <h2 id="okh" className="m-0 text-lg font-semibold">
                  Needs your OK
                </h2>
                <Link to="/requests" className="text-sm">
                  All requests
                </Link>
              </div>
              {data.approvals.map((r) => (
                <div key={r.id} className="flex flex-wrap items-center gap-3.5 border-t border-line py-3">
                  <div className="h-[68px] w-[46px] flex-none rounded-md" style={{ background: r.color }} />
                  <div className="flex min-w-[160px] flex-1 flex-col gap-1">
                    <div className="text-[15px] font-semibold">{r.title}</div>
                    <div className="text-[13px] text-muted">{r.who}</div>
                    <div className="text-xs text-dim">{r.plan}</div>
                  </div>
                  <Button className="h-10 px-4 text-sm">Approve</Button>
                  <Button variant="ghost" className="h-10 px-3.5 text-sm">
                    Decline
                  </Button>
                </div>
              ))}
            </Card>
          )}
          {data.watching.length > 0 && (
            <Card aria-labelledby="wnh" className="flex min-w-0 flex-[1_1_420px] flex-col gap-4">
              <div className="flex items-baseline justify-between">
                <h2 id="wnh" className="m-0 text-lg font-semibold">
                  Watching now
                </h2>
                <Link to="/activity" className="text-sm">
                  History &amp; stats
                </Link>
              </div>
              {data.watching.map((w) => (
                <div key={w.title} className="flex flex-col gap-2.5 border-t border-line py-3.5">
                  <div className="flex items-baseline justify-between gap-3">
                    <div className="text-[15px] font-semibold">{w.title}</div>
                    <span className="rounded-full bg-raised px-2.5 py-1 text-xs whitespace-nowrap text-soft">{w.mode}</span>
                  </div>
                  <div className="text-[13px] text-muted">{w.who}</div>
                  <Progress value={w.percent} color="bg-amber" className="h-1" />
                </div>
              ))}
            </Card>
          )}
        </div>
      )}

      <section aria-labelledby="rah" className="flex flex-col gap-4">
        <div className="flex items-baseline justify-between">
          <h2 id="rah" className="m-0 text-xl font-semibold">
            Recently added
          </h2>
          <Link to="/movies" className="text-sm">
            See library
          </Link>
        </div>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-[18px]">
          {data.recent.map((p) => (
            <Link key={p.title} to="/movies" className="flex flex-col gap-2 text-text no-underline hover:text-text">
              <div className="box-border flex aspect-[2/3] items-end rounded-xl p-3.5" style={{ background: p.color }}>
                <span className="font-display text-[22px] leading-[1.05] text-[#F7F3EA]">{p.title}</span>
              </div>
              <span className="text-[13px] text-muted">{p.sub}</span>
            </Link>
          ))}
        </div>
      </section>

      <Card aria-labelledby="cuh" className="flex flex-col gap-1">
        <h2 id="cuh" className="m-0 mb-3 text-lg font-semibold">
          Coming up this week
        </h2>
        {data.upcoming.map((u) => (
          <div key={u.day + u.title} className="flex flex-wrap items-center gap-4 border-t border-line py-3">
            <div className="w-14 text-[13px] font-semibold tracking-wider text-amber uppercase">{u.day}</div>
            <div className="flex-[1_1_200px] text-[15px]">{u.title}</div>
            <div className="text-[13px] text-muted">{u.note}</div>
          </div>
        ))}
      </Card>
    </>
  );
}
