import { useState } from 'react';
import { useOutletContext } from 'react-router';
import type { AuthStatus, SessionUser } from '@marquee/shared';
import { Button, Card } from '../components/ui';

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
          <li>Under You, turn on <strong>Notifications on this iPhone</strong> to hear when something is ready.</li>
        </ol>
        <p className="m-0 text-sm text-muted">At home you can type your server’s home address instead (like 192.168.1.20:9797). In the app, under For experts, you can save both, and it uses whichever works.</p>
      </Card>
      {admin && (
        <Card className="flex flex-col gap-2">
          <h2 className="m-0 text-lg font-semibold">For the admin</h2>
          <p className="m-0 text-sm text-muted">
            If you sign in to this address through Pangolin, add a rule to the Marquee resource in Pangolin that skips its sign-in for <code className="font-mono text-soft">/api/*</code>. Marquee’s own sign-in still protects everything; the web pages stay behind Pangolin. Without the rule the app says “Pangolin’s sign-in is in the way”.
          </p>
          <p className="m-0 text-sm text-muted">Push notifications need your Apple key: Settings → Notifications → Shared alerts → iPhone app. Each phone that signs in is listed under Settings → Account → Your phones.</p>
        </Card>
      )}
    </div>
  );
}
