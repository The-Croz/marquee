import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useOutletContext } from 'react-router';
import type { ApnsSettingsView, AuthStatus, SessionUser } from '@marquee/shared';
import { api, ApiFailure, queryClient } from '../api';
import { Button, Card, Field, Notice } from '../components/ui';

type Ctx = { status: AuthStatus & { user: SessionUser } };

/** Settings → iPhone app: how to put Marquee on an iPhone, with this server's address ready to copy. */
export function InstallAppPage() {
  const { status } = useOutletContext<Ctx>();
  const address = window.location.origin;
  const [copied, setCopied] = useState(false);
  const admin = status.user.role === 'admin';

  async function copy() {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="flex max-w-[720px] flex-col gap-6">
      <Card className="flex flex-col gap-3">
        <h2 className="m-0 text-lg font-semibold">Install Marquee on your iPhone</h2>
        <p className="m-0 text-sm text-muted">The Marquee app puts your library, Discover, requests and downloads on your phone, with notifications. It needs an iPhone with iOS 26 or newer.</p>
        <ol className="m-0 flex list-decimal flex-col gap-2 pl-5 text-body text-soft">
          <li>Ask the person who runs this Marquee for the TestFlight invitation (until Marquee is on the App Store), then install it from the TestFlight app.</li>
          <li>Open Marquee. When it asks <strong>Where is Marquee?</strong>, type this address:</li>
        </ol>
        <div className="flex flex-wrap items-center gap-3">
          <code className="rounded-lg border border-line-strong bg-panel px-3 py-2 font-mono text-sm text-text" data-testid="server-address">
            {address}
          </code>
          <Button type="button" variant="ghost" onClick={copy}>
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
        <ol start={3} className="m-0 flex list-decimal flex-col gap-2 pl-5 text-body text-soft">
          <li>Sign in with your username and password, or the same single sign-on or Plex sign-in you use here.</li>
          <li>Under You, turn on <strong>Notifications on this iPhone</strong> to hear when something is ready, and use <strong>What you get</strong> to pick which messages arrive.</li>
        </ol>
        <p className="m-0 text-sm text-muted">At home you can type your server’s home address instead (like 192.168.1.20:9797). In the app, under For experts, you can save both, and it uses whichever works.</p>
      </Card>
      {admin && (
        <Card className="flex flex-col gap-2">
          <h2 className="m-0 text-lg font-semibold">For the admin</h2>
          <p className="m-0 text-sm text-muted">
            If you sign in to this address through Pangolin, add a rule to the Marquee resource in Pangolin that skips its sign-in for <code className="font-mono text-soft">/api/*</code>. Marquee’s own sign-in still protects everything; the web pages stay behind Pangolin. Without the rule the app says “Pangolin’s sign-in is in the way”.
          </p>
          <p className="m-0 text-sm text-muted">Push notifications need your Apple key, below. Each phone that signs in is listed under Settings → Account → Your phones.</p>
        </Card>
      )}
      {admin && <ApplePushKeyCard />}
    </div>
  );
}

const APNS = '/settings/notifications/apns';
const errMsg = (e: unknown) => (e instanceof ApiFailure ? e.message : 'Something went wrong. Try again.');

/** The Apple key that lets Marquee send to the iPhone app. Saved secrets are never shown again. */
function ApplePushKeyCard() {
  const { data } = useQuery({ queryKey: ['apns'], queryFn: () => api<ApnsSettingsView>(APNS) });
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  if (!data) return null;
  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    setBusy(true);
    setMessage(null);
    try {
      await api(APNS, { method: 'PUT', body: { key: String(f.get('key') ?? ''), keyId: f.get('keyId'), teamId: f.get('teamId'), bundleId: f.get('bundleId') } });
      await queryClient.invalidateQueries({ queryKey: ['apns'] });
      (form.elements.namedItem('key') as HTMLTextAreaElement).value = '';
      setMessage({ ok: true, text: 'Saved.' });
    } catch (err) {
      setMessage({ ok: false, text: errMsg(err) });
    } finally {
      setBusy(false);
    }
  }
  async function test() {
    setBusy(true);
    try {
      const r = await api<{ ok: boolean; message: string }>(`${APNS}/test`, { body: {} });
      setMessage({ ok: r.ok, text: r.message });
    } catch (err) {
      setMessage({ ok: false, text: errMsg(err) });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card className="flex flex-col gap-4">
      <div>
        <h2 className="m-0 text-lg font-semibold">iPhone notifications (Apple push key)</h2>
        <p className="m-0 text-sm text-muted">
          Lets Marquee send notifications to the Marquee iPhone app, with cover art and Approve and Turn down buttons, and keep a download’s progress on the Lock Screen (a Live Activity). In your Apple developer account, create a key with Apple Push Notifications turned on, download its .p8 file, and fill this in. Each person then turns notifications on in the app, under You. The key is kept by Marquee and never shown again.
        </p>
      </div>
      <form onSubmit={save} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-label text-muted">
          Apple push key (the text of the .p8 file) {data.keySet && <span className="text-teal-hi">· a key is saved; leave blank to keep it</span>}
          <textarea name="key" rows={4} spellCheck={false} placeholder="-----BEGIN PRIVATE KEY-----" className="rounded-lg border border-line-strong bg-panel px-2.5 py-2 font-mono text-sm text-text" />
        </label>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Key id" name="keyId" defaultValue={data.keyId} placeholder="ABC123DEFG" required />
          <Field label="Team id" name="teamId" defaultValue={data.teamId} placeholder="ABC123DEFG" required />
          <Field label="App id" name="bundleId" defaultValue={data.bundleId} required />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={busy}>
            Save
          </Button>
          <Button type="button" variant="ghost" disabled={busy || !data.ready} onClick={test}>
            Send a test to my iPhone
          </Button>
        </div>
        {message && <Notice tone={message.ok ? 'success' : 'error'}>{message.text}</Notice>}
      </form>
    </Card>
  );
}
