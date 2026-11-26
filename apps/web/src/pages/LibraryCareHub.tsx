import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import type { LeftOutItem, ScanStatusView, UnmatchedItem } from '@marquee/shared';
import { api, ApiFailure, queryClient } from '../api';
import { PageHeader } from '../components/Page';
import { RenameSheet } from '../components/LibraryCare';
import { Button, Notice, cx } from '../components/ui';

/**
 * `/library/care`: every tool for keeping the library tidy, in one place, each with how it's
 * doing. These used to hide in the Library's ⋯ menu; this page gives them room, and the
 * sidebar a way in. Admins only.
 */
export function LibraryCareHubPage() {
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<'movie' | 'tv' | null>(null);
  const scan = useQuery({
    queryKey: ['scan'],
    queryFn: () => api<ScanStatusView>('/library/scan'),
    refetchInterval: (q) => (q.state.data?.running ? 1500 : false),
  });
  const unmatched = useQuery({ queryKey: ['unmatched'], queryFn: () => api<{ items: UnmatchedItem[] }>('/library/unmatched') });
  const leftOut = useQuery({ queryKey: ['left-out'], queryFn: () => api<{ items: LeftOutItem[] }>('/library/left-out') });

  const s = scan.data;
  const need = unmatched.data?.items.length ?? 0;
  const out = leftOut.data?.items.length ?? 0;

  async function startScan() {
    setError(null);
    try {
      await api('/library/scan', { body: {} });
      await queryClient.invalidateQueries({ queryKey: ['scan'] });
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : 'Couldn’t start the scan. Try again in a moment.');
    }
  }

  const scanLine = !s
    ? 'Checking…'
    : s.running
      ? `Scanning · ${s.processed} of ${s.total} folders`
      : s.error
        ? `The last scan failed: ${s.error}`
        : s.finishedAt
          ? `Last scan ${new Date(s.finishedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · ${s.matched} matched`
          : 'Marquee hasn’t read your library folders yet.';

  return (
    <>
      <PageHeader
        title="Library care"
        back={{ to: '/library', label: 'Library' }}
        info="Tools for keeping the library tidy: matching folders Marquee couldn’t place, bringing in files from elsewhere, renaming, and clearing out what’s left over. Nothing here deletes a file without asking first."
      />
      {error && <Notice tone="error">{error}</Notice>}

      <section aria-labelledby="care-now" className="flex flex-col gap-3">
        <h2 id="care-now" className="m-0 text-caption font-semibold tracking-widest text-dim uppercase">
          Keep it up to date
        </h2>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          <Tool
            title="Scan for new files"
            status={scanLine}
            tone={s?.error ? 'warn' : s?.running ? 'busy' : 'quiet'}
            action={
              <Button type="button" className="h-11 px-4 text-sm" disabled={s?.running} onClick={() => void startScan()}>
                {s?.running ? 'Scanning…' : 'Scan now'}
              </Button>
            }
          >
            Reads your library folders and adds anything new. It runs by itself after each import, and never moves or changes a file.
          </Tool>
          <Tool title="Needs a match" to="/library/unmatched" status={need === 0 ? 'Every folder has a match' : `${need} ${need === 1 ? 'folder needs' : 'folders need'} a match`} tone={need > 0 ? 'warn' : 'good'}>
            Folders Marquee couldn’t place. Pick the right movie or show, or leave one out.
          </Tool>
          <Tool title="Left out of scans" to="/library/left-out" status={out === 0 ? 'Nothing is left out' : `${out} ${out === 1 ? 'title' : 'titles'} left out`}>
            Titles you removed and asked scans to skip. Let one back in here.
          </Tool>
        </div>
      </section>

      <section aria-labelledby="care-tidy" className="flex flex-col gap-3">
        <h2 id="care-tidy" className="m-0 text-caption font-semibold tracking-widest text-dim uppercase">
          Tidy up
        </h2>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          <Tool title="Put files in your library" to="/library/import">
            Bring in files from a folder (a disc rip, an old download) and Marquee files them where they belong.
          </Tool>
          <Tool
            title="Rename files to Marquee’s names"
            action={
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="ghost" className="h-11 px-4 text-sm" onClick={() => setRenaming('movie')}>
                  Movies…
                </Button>
                <Button type="button" variant="ghost" className="h-11 px-4 text-sm" onClick={() => setRenaming('tv')}>
                  Shows…
                </Button>
              </div>
            }
          >
            See every change before it happens. Plex and Jellyfin keep up by themselves.
          </Tool>
          <Tool title="Clean up" to="/library/clean-up">
            Two copies of one title, leftover downloads, files Marquee doesn’t know, and the recycle bin.
          </Tool>
          <Tool title="Not watched" to="/library/unwatched">
            Titles nobody has watched, or not in the last year. Only a list: nothing is deleted.
          </Tool>
        </div>
      </section>

      <RenameSheet open={renaming !== null} onClose={() => setRenaming(null)} kind={renaming ?? 'movie'} />
    </>
  );
}

const DOT = { good: 'bg-teal', warn: 'bg-warn', busy: 'bg-blue', quiet: 'bg-dim' } as const;

/** One tool: what it's for, how it's doing, and the way in (a link to its page, or buttons). */
function Tool({ title, to, status, tone = 'quiet', action, children }: { title: string; to?: string; status?: string; tone?: keyof typeof DOT; action?: ReactNode; children: ReactNode }) {
  const body = (
    <>
      <span className="flex items-center gap-2">
        <span className="text-body font-semibold text-text">{title}</span>
        {to && (
          <span aria-hidden="true" className="ml-auto text-dim">
            ›
          </span>
        )}
      </span>
      {status && (
        <span className={cx('flex items-center gap-2 text-sm', tone === 'warn' ? 'text-warn' : tone === 'good' ? 'text-teal' : 'text-soft')}>
          <span aria-hidden="true" className={cx('size-2 flex-none rounded-full', DOT[tone])} />
          {status}
        </span>
      )}
      <span className="text-sm text-muted">{children}</span>
    </>
  );
  const box = 'flex min-h-full flex-col gap-2 rounded-2xl border border-line bg-panel p-5';
  if (to) {
    return (
      <Link to={to} className={cx(box, 'no-underline transition hover:border-line-strong hover:bg-raised')}>
        {body}
      </Link>
    );
  }
  return (
    <div className={box}>
      {body}
      {action && <div className="mt-auto pt-2">{action}</div>}
    </div>
  );
}
