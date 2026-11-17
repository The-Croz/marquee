import type { PlexPinCheck, PlexPinStart } from '@marquee/shared';
import { api } from './api';

/**
 * Runs Plex's PIN sign-in: opens app.plex.tv in a popup, then polls our server
 * until Plex approves (or the person closes the popup / it times out).
 * `link: true` attaches the Plex account to the signed-in user instead.
 */
export async function plexSignIn(link = false): Promise<PlexPinCheck> {
  // Open the popup synchronously inside the click so browsers don't block it.
  const popup = window.open('', 'plex-auth', 'width=600,height=720');
  try {
    const start = await api<PlexPinStart>('/auth/plex/start', { body: { link } });
    if (popup) popup.location.href = start.authUrl;
    else window.open(start.authUrl, '_blank');

    const deadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      const result = await api<PlexPinCheck>('/auth/plex/check', { body: { flowId: start.flowId } });
      if (result.status !== 'pending') return result;
      if (popup?.closed) {
        // One last check in case they approved and then closed it.
        const last = await api<PlexPinCheck>('/auth/plex/check', { body: { flowId: start.flowId } });
        return last.status === 'pending' ? { status: 'denied', message: 'Plex sign-in was closed before it finished.' } : last;
      }
    }
    return { status: 'expired' };
  } finally {
    popup?.close();
  }
}
