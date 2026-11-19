import { Link } from 'react-router';
import { ApiFailure } from '../api';
import { DownloadList, useDownloads } from '../components/Downloads';
import { Notice } from '../components/ui';
import { PageHeader } from '../components/Page';

/** Downloads: what Marquee sent to qBittorrent, in plain words, with one-tap fixes. */
export function DownloadsPage() {
  const q = useDownloads();
  const v = q.data;
  const current = (d: { state: string; canImport: boolean }) => d.state === 'sent' || d.state === 'downloading' || d.canImport;
  const now = v?.items.filter(current) ?? [];
  const earlier = v?.items.filter((d) => !current(d)).slice(0, 30) ?? [];
  return (
    <>
      <PageHeader
        title="Downloads"
        info={
          <>
            Marquee checks qBittorrent every minute. When a download is stuck too long or turns out to be fake, it tries another copy by itself. Change the times in{' '}
            <Link to="/settings/downloader">Settings → Downloader</Link>.
          </>
        }
      />
      {q.error && <Notice tone="error">{q.error instanceof ApiFailure ? q.error.message : 'Something went wrong.'}</Notice>}
      {v && (
        <>
          <section aria-labelledby="dl-now" className="flex flex-col gap-3">
            <h2 id="dl-now" className="m-0 text-xs font-normal tracking-[.08em] text-dim uppercase">
              On the way · {now.length}
            </h2>
            {now.length === 0 && <p className="m-0 text-muted">Nothing downloading. Find a copy on a movie or show page and press “Download this”.</p>}
            <DownloadList view={{ ...v, items: now }} />
          </section>
          {earlier.length > 0 && (
            <section aria-labelledby="dl-earlier" className="flex flex-col gap-3">
              <h2 id="dl-earlier" className="m-0 pt-2 text-xs font-normal tracking-[.08em] text-dim uppercase">
                Earlier
              </h2>
              <DownloadList view={{ ...v, items: earlier, problem: null }} />
            </section>
          )}
        </>
      )}
    </>
  );
}
