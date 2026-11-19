/** Sending one message through Pushover or ntfy. Errors say what happened in plain words. */

export interface PushMessage {
  title: string;
  body: string;
  /** A full address people can open from the message. */
  link?: string | null;
  /** A picture address (cover art). Pushover gets the picture itself; ntfy fetches it. */
  image?: string | null;
}

export interface PushConfig {
  kind: 'pushover' | 'ntfy';
  config: Record<string, string>;
}

export interface PushClient {
  send(channel: PushConfig, msg: PushMessage): Promise<void>;
}

export class PushError extends Error {}

export class HttpPushClient implements PushClient {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async send({ kind, config }: PushConfig, msg: PushMessage): Promise<void> {
    try {
      if (kind === 'pushover') await this.pushover(config, msg);
      else await this.ntfy(config, msg);
    } catch (err) {
      if (err instanceof PushError) throw err;
      throw new PushError(`Couldn’t reach ${kind === 'pushover' ? 'Pushover' : 'ntfy'}. Check the address and your internet.`);
    }
  }

  private async pushover(c: Record<string, string>, msg: PushMessage) {
    const body = new URLSearchParams({ token: c.appToken ?? '', user: c.userKey ?? '', title: msg.title, message: msg.body });
    if (msg.link) body.set('url', msg.link);
    const pic = msg.image ? await this.picture(msg.image) : null;
    if (pic) {
      body.set('attachment_base64', pic.base64);
      body.set('attachment_type', pic.type);
    }
    const res = await this.fetchImpl('https://api.pushover.net/1/messages.json', { method: 'POST', body });
    if (res.ok) return;
    if (res.status === 400) throw new PushError('Pushover turned the token or user key down. Check both in Settings → Notifications.');
    throw new PushError(`Pushover answered ${res.status}. It will try again with the next message.`);
  }

  /** Fetches a picture for Pushover (which wants the picture itself, up to 2.5 MB). A picture that can't be fetched is left out. */
  private async picture(url: string): Promise<{ base64: string; type: string } | null> {
    try {
      const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(5000) });
      const type = res.headers.get('content-type') ?? '';
      if (!res.ok || !type.startsWith('image/')) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      return buf.length && buf.length <= 2_500_000 ? { base64: buf.toString('base64'), type } : null;
    } catch {
      return null;
    }
  }

  /** ntfy's JSON form, so titles with any characters (and emoji) arrive as written. */
  private async ntfy(c: Record<string, string>, msg: PushMessage) {
    const server = (c.server || 'https://ntfy.sh').replace(/\/+$/, '');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (c.token) headers.Authorization = `Bearer ${c.token}`;
    const payload: Record<string, string> = { topic: c.topic ?? '', title: msg.title, message: msg.body };
    if (msg.link) payload.click = msg.link;
    if (msg.image) payload.attach = msg.image;
    const res = await this.fetchImpl(`${server}/`, { method: 'POST', body: JSON.stringify(payload), headers });
    if (res.ok) return;
    if (res.status === 401 || res.status === 403) throw new PushError('ntfy wouldn’t let Marquee in. Check the access token, or that the topic allows publishing.');
    throw new PushError(`ntfy answered ${res.status}. It will try again with the next message.`);
  }
}
