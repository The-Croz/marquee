/** Sending one message through Pushover, ntfy or a webhook (a JSON POST). Errors say what happened in plain words. */

import type { NotificationPriority } from '@marquee/shared';
import { GonePushError, PushError } from './pushError.js';
import { ApnsClient, apnsPayload, explain, isGone } from './apns.js';

/** Pushover's levels. 1 is Time Sensitive on an iPhone; 2 (keeps buzzing until you answer) isn't offered. */
const PUSHOVER_PRIORITY: Record<NotificationPriority, string> = { silent: '-2', quiet: '-1', normal: '0', high: '1' };
/** ntfy's levels. 4 is Time Sensitive on an iPhone. */
const NTFY_PRIORITY: Record<NotificationPriority, number> = { silent: 1, quiet: 2, normal: 3, high: 4 };

export interface PushMessage {
  title: string;
  body: string;
  /** A full address people can open from the message. */
  link?: string | null;
  /** A picture address (cover art). Pushover gets the picture itself; ntfy fetches it. */
  image?: string | null;
  /** How it arrives on the phone. Normal when left out. */
  priority?: NotificationPriority;
  /** The event's key ("request_ready"), for webhooks. */
  event?: string;
  /** The facts the message was made from, for webhooks. */
  vars?: Record<string, unknown>;
}

export interface PushConfig {
  kind: 'pushover' | 'ntfy' | 'webhook' | 'apns';
  config: Record<string, string>;
}

export interface PushClient {
  send(channel: PushConfig, msg: PushMessage): Promise<void>;
}

export { PushError, GonePushError };

export class HttpPushClient implements PushClient {
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly apns: ApnsClient | null = null,
  ) {}

  async send({ kind, config }: PushConfig, msg: PushMessage): Promise<void> {
    try {
      if (kind === 'apns') await this.apnsSend(config, msg);
      else if (kind === 'pushover') await this.pushover(config, msg);
      else if (kind === 'webhook') await this.webhook(config, msg);
      else await this.ntfy(config, msg);
    } catch (err) {
      if (err instanceof PushError) throw err;
      throw new PushError(`Couldn’t reach ${kind === 'apns' ? 'Apple' : kind === 'pushover' ? 'Pushover' : kind === 'webhook' ? 'the webhook address' : 'ntfy'}. Check the address and your internet.`);
    }
  }

  private async apnsSend(c: Record<string, string>, msg: PushMessage) {
    if (!this.apns) throw new PushError('iPhone push isn’t set up in this Marquee. An admin adds the Apple key under Settings → iPhone app.');
    const answer = await this.apns.send({ token: c.token ?? '', environment: c.environment === 'sandbox' ? 'sandbox' : 'production', payload: apnsPayload(msg) });
    if (answer.status === 200) return;
    if (isGone(answer)) throw new GonePushError('That iPhone stopped listening, so Marquee stopped sending to it.');
    throw new PushError(explain(answer));
  }

  private async pushover(c: Record<string, string>, msg: PushMessage) {
    const body = new URLSearchParams({ token: c.appToken ?? '', user: c.userKey ?? '', title: msg.title, message: msg.body });
    if (msg.link) body.set('url', msg.link);
    body.set('priority', PUSHOVER_PRIORITY[msg.priority ?? 'normal']);
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

  /**
   * A webhook: one JSON POST per message, for Home Assistant, Discord bridges
   * or scripts. An optional secret is sent as "Authorization: Bearer …".
   */
  private async webhook(c: Record<string, string>, msg: PushMessage) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'User-Agent': 'Marquee' };
    if (c.secret) headers.Authorization = `Bearer ${c.secret}`;
    const payload = { event: msg.event ?? 'test', title: msg.title, body: msg.body, link: msg.link ?? null, image: msg.image ?? null, priority: msg.priority ?? 'normal', vars: msg.vars ?? {}, sentAt: new Date().toISOString() };
    const res = await this.fetchImpl(c.url ?? '', { method: 'POST', body: JSON.stringify(payload), headers, signal: AbortSignal.timeout(10_000) });
    if (res.ok) return;
    throw new PushError(`The webhook answered ${res.status}. It will try again with the next message.`);
  }

  /** ntfy's JSON form, so titles with any characters (and emoji) arrive as written. */
  private async ntfy(c: Record<string, string>, msg: PushMessage) {
    const server = (c.server || 'https://ntfy.sh').replace(/\/+$/, '');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (c.token) headers.Authorization = `Bearer ${c.token}`;
    const payload: Record<string, string | number> = { topic: c.topic ?? '', title: msg.title, message: msg.body, priority: NTFY_PRIORITY[msg.priority ?? 'normal'] };
    if (msg.link) payload.click = msg.link;
    if (msg.image) payload.attach = msg.image;
    const res = await this.fetchImpl(`${server}/`, { method: 'POST', body: JSON.stringify(payload), headers });
    if (res.ok) return;
    if (res.status === 401 || res.status === 403) throw new PushError('ntfy wouldn’t let Marquee in. Check the access token, or that the topic allows publishing.');
    throw new PushError(`ntfy answered ${res.status}. It will try again with the next message.`);
  }
}
