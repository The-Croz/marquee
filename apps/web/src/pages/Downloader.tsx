import { useState, type FormEvent } from 'react';
import { Navigate, useOutletContext } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import type { AuthStatus, DownloaderHealth, DownloaderUpdate, DownloaderView, SessionUser } from '@marquee/shared';
import { api, ApiFailure, queryClient } from '../api';
import { Button, Card, Field, Notice, cx } from '../components/ui';

type Ctx = { status: AuthStatus & { user: SessionUser } };

const errMsg = (e: unknown) => (e instanceof ApiFailure ? e.message : 'Something went wrong.');

function size(bytes: number): string {
  const tb = bytes / 1024 ** 4;
  return tb >= 1 ? `${tb.toFixed(1)} TB` : `${Math.round(bytes / 1024 ** 3)} GB`;
}

/** The health of qBittorrent in plain words, with what to do about it. */
function HealthCard({ h, category }: { h: DownloaderHealth; category: string }) {
  const tone = h.state === 'working' ? 'text-teal-hi' : h.ok ? 'text-amber' : 'text-warn';
  return (
    <div role="status" className="flex flex-col gap-1.5 rounded-xl border border-line px-4 py-3 text-sm">
      <p className={cx('m-0 font-semibold', tone)}>{h.label}</p>
      {h.fix && <p className="m-0 text-soft">{h.fix}</p>}
      {h.detail && <p className="m-0 text-dim">{h.detail}</p>}
      {h.version && (
        <ul className="m-0 mt-1 flex list-none flex-col gap-0.5 p-0 text-muted">
          <li>qBittorrent {h.version}</li>
          {h.savePath && <li>Saves to {h.savePath}</li>}
          {h.freeSpace != null && <li>{size(h.freeSpace)} free there</li>}
          <li>{h.categoryExists ? `The “${category}” category is ready.` : `Marquee will make the “${category}” category with its first download.`}</li>
        </ul>
      )}
    </div>
  );
}

export function DownloaderPage() {
  const { status } = useOutletContext<Ctx>();
  if (status.user.role !== 'admin') return <Navigate to="/settings/account" replace />;
  return <DownloaderAdmin />;
}

function DownloaderAdmin() {
  const { data } = useQuery({ queryKey: ['downloader'], queryFn: () => api<DownloaderView>('/settings/downloader') });
  const health = useQuery({ queryKey: ['downloader', 'health'], queryFn: () => api<DownloaderHealth>('/settings/downloader/health'), enabled: !!data?.url });
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [test, setTest] = useState<DownloaderHealth | null>(null);
  const [busy, setBusy] = useState(false);
  if (!data) return <p className="text-muted">Loading…</p>;

  const val = (id: string) => (document.getElementById(id) as HTMLInputElement | null)?.value.trim() ?? '';

  async function runTest() {
    setBusy(true);
    setTest(null);
    try {
      const body: Record<string, string> = {};
      for (const k of ['url', 'username', 'password', 'category'] as const) if (val(`dl-${k}`)) body[k] = val(`dl-${k}`);
      setTest(await api<DownloaderHealth>('/settings/downloader/test', { body }));
    } catch (e) {
      setMessage({ tone: 'error', text: errMsg(e) });
    } finally {
      setBusy(false);
    }
  }

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    const body: DownloaderUpdate = { url: String(d.get('url') ?? ''), username: String(d.get('username') ?? ''), category: String(d.get('category') ?? '') };
    const password = String(d.get('password') ?? '');
    if (password) body.password = password; // blank means "keep what's saved"
    setMessage(null);
    setTest(null);
    try {
      await api('/settings/downloader', { method: 'PUT', body });
      await queryClient.invalidateQueries({ queryKey: ['downloader'] });
      (e.target as HTMLFormElement).querySelectorAll<HTMLInputElement>('input[type=password]').forEach((i) => (i.value = ''));
      setMessage({ tone: 'success', text: 'Saved.' });
    } catch (err) {
      setMessage({ tone: 'error', text: errMsg(err) });
    }
  }

  async function disconnect() {
    await api('/settings/downloader', { method: 'PUT', body: { url: null, password: null } });
    await queryClient.invalidateQueries({ queryKey: ['downloader'] });
    setTest(null);
    setMessage({ tone: 'success', text: 'qBittorrent disconnected.' });
  }

  const shown = test ?? (data.url ? health.data : null);

  return (
    <form onSubmit={save} className="flex max-w-[760px] flex-col gap-6">
      {message && <Notice tone={message.tone}>{message.text}</Notice>}
      <Card className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="m-0 text-lg font-semibold">qBittorrent</h2>
            <p className="m-0 mt-1 text-sm text-muted">
              Your Downloader: Marquee sends it the copies it picks and follows them until they're in your library. For now Marquee only checks the connection; it doesn't add or change anything in qBittorrent yet.
            </p>
          </div>
          {data.url && (
            <Button type="button" variant="ghost" className="h-10 px-3.5 text-sm" onClick={disconnect}>
              Disconnect
            </Button>
          )}
        </div>
        <Field label="Address" id="dl-url" name="url" defaultValue={data.url ?? ''} placeholder="http://192.168.1.100:8080" hint="The address of qBittorrent's web page. Behind gluetun, use gluetun's address and the port it passes through." />
        <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-4">
          <Field label="Username" id="dl-username" name="username" defaultValue={data.username} autoComplete="off" />
          <Field
            label="Password"
            id="dl-password"
            name="password"
            type="password"
            autoComplete="off"
            placeholder={data.hasPassword ? '••••••••••••' : ''}
            hint={data.hasPassword ? 'Saved. Leave blank to keep it.' : 'qBittorrent → Options → Web UI'}
          />
        </div>
        <details className="rounded-xl border border-line px-4 py-3">
          <summary className="cursor-pointer text-sm font-medium text-soft">For experts</summary>
          <div className="mt-4">
            <Field label="Category" id="dl-category" name="category" defaultValue={data.category} hint="Marquee files its downloads under this qBittorrent category and only follows that category, so Radarr's and Sonarr's downloads are left alone." />
          </div>
        </details>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" variant="ghost" onClick={runTest} disabled={busy}>
            {busy ? 'Testing…' : 'Test connection'}
          </Button>
        </div>
        {shown && <HealthCard h={shown} category={val('dl-category') || data.category} />}
      </Card>
      <div>
        <Button type="submit">Save</Button>
      </div>
    </form>
  );
}
