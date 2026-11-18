/** Sending one message through Pushover or ntfy. Errors say what happened in plain words. */

export interface PushMessage {
  title: string;
  body: string;
  /** A full address people can open from the message. */
  link?: string | null;
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
    const res = await this.fetchImpl('https://api.pushover.net/1/messages.json', { method: 'POST', body });
    if (res.ok) return;
    if (res.status === 400) throw new PushError('Pushover turned the token or user key down. Check both in Settings → Notifications.');
    throw new PushError(`Pushover answered ${res.status}. It will try again with the next message.`);
  }

  private async ntfy(c: Record<string, string>, msg: PushMessage) {
    const server = (c.server || 'https://ntfy.sh').replace(/\/+$/, '');
    const headers: Record<string, string> = { Title: msg.title };
    if (msg.link) headers.Click = msg.link;
    if (c.token) headers.Authorization = `Bearer ${c.token}`;
    const res = await this.fetchImpl(`${server}/${encodeURIComponent(c.topic ?? '')}`, { method: 'POST', body: msg.body, headers });
    if (res.ok) return;
    if (res.status === 401 || res.status === 403) throw new PushError('ntfy wouldn’t let Marquee in. Check the access token, or that the topic allows publishing.');
    throw new PushError(`ntfy answered ${res.status}. It will try again with the next message.`);
  }
}
