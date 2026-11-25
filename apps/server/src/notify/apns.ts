import { createPrivateKey, sign } from 'node:crypto';
import http2 from 'node:http2';
import type { NotificationPriority } from '@marquee/shared';
import { readApns, type ApnsConfig } from './apnsSettings.js';
import type { Db } from '../db/index.js';
import { PushError } from './pushError.js';
import type { PushMessage } from './push.js';

/** How a message arrives, as Apple's interruption level and whether it makes a sound. */
export function levelFor(priority: NotificationPriority | undefined): { level: 'passive' | 'active' | 'time-sensitive'; sound: boolean } {
  switch (priority) {
    case 'silent': return { level: 'passive', sound: false };
    case 'quiet': return { level: 'passive', sound: true };
    case 'high': return { level: 'time-sensitive', sound: true };
    default: return { level: 'active', sound: true };
  }
}

/** The notification category that gets Approve / Turn down buttons. */
export const CATEGORY_REQUEST = 'request_waiting';

export function apnsPayload(msg: PushMessage): Record<string, unknown> {
  const { level, sound } = levelFor(msg.priority);
  const requestId = typeof msg.vars?.requestId === 'number' ? msg.vars.requestId : null;
  return {
    aps: {
      alert: { title: msg.title, body: msg.body },
      'interruption-level': level,
      'mutable-content': 1,
      ...(sound ? { sound: 'default' } : {}),
      ...(msg.event === 'request_pending' && requestId !== null ? { category: CATEGORY_REQUEST } : {}),
    },
    link: msg.link ?? null,
    image: msg.image ?? null,
    ...(requestId !== null ? { requestId } : {}),
  };
}

export interface ApnsRequest {
  token: string;
  environment: 'production' | 'sandbox';
  payload: Record<string, unknown>;
  pushType?: 'alert' | 'liveactivity';
  /** Live Activities send to `<bundle>.push-type.liveactivity`. */
  topicSuffix?: string;
  priority?: 5 | 10;
  expiration?: number;
}

export interface ApnsAnswer {
  status: number;
  reason: string | null;
}

/** Why Apple said no, in plain words (the key itself is never part of any message). */
export function explain(a: ApnsAnswer): string {
  if (a.status === 403) return 'Apple turned the key down. Check the key, key id and team id under Settings → Notifications → iPhone app.';
  if (a.status === 429) return 'Apple asked Marquee to slow down. It will try again with the next message.';
  if (a.reason === 'DeviceTokenNotForTopic' || a.reason === 'BadTopic' || a.reason === 'TopicDisallowed') return 'Apple says this iPhone doesn’t belong to that app id. Check the app id under Settings → Notifications → iPhone app.';
  if (a.reason === 'BadDeviceToken') return 'Apple turned this iPhone’s address down. Turn notifications off and on again in the app. If it keeps happening, the app and Marquee may be using different Apple environments (test or real).';
  return `Apple answered ${a.status}${a.reason ? ` (${a.reason})` : ''}. It will try again with the next message.`;
}

/** Has the phone stopped listening (the app was deleted, or the token is old)? Then stop sending to it. */
/** Only when Apple says the phone has unregistered. Other 400s (a wrong app id, the wrong sandbox/production) are setup problems: the channel stays and says so. */
export const isGone = (a: ApnsAnswer) => a.status === 410 || (a.status === 400 && a.reason === 'Unregistered');

/** Sends one push to Apple over HTTP/2, signed with the admin's key. No new dependency: Node's own http2 and crypto. */
export class ApnsClient {
  private jwt: { value: string; at: number; keyId: string } | null = null;

  constructor(
    private readonly config: () => ApnsConfig | null,
    /** Tests and demo mode point this at a fake Apple. */
    private readonly baseUrl: string | null = process.env.APNS_URL ?? null,
    private readonly now: () => number = Date.now,
  ) {}

  static forDb(db: Db, baseUrl?: string | null, now?: () => number): ApnsClient {
    return new ApnsClient(() => readApns(db), baseUrl ?? process.env.APNS_URL ?? null, now);
  }

  get ready(): boolean {
    return this.config() !== null;
  }

  topic(suffix = ''): string {
    return (this.config()?.bundleId ?? '') + suffix;
  }

  private token(c: ApnsConfig): string {
    const t = this.now();
    if (this.jwt && this.jwt.keyId === c.keyId && t - this.jwt.at < 50 * 60 * 1000) return this.jwt.value;
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const head = `${b64({ alg: 'ES256', kid: c.keyId })}.${b64({ iss: c.teamId, iat: Math.floor(t / 1000) })}`;
    const sig = sign('sha256', Buffer.from(head), { key: createPrivateKey(c.key), dsaEncoding: 'ieee-p1363' }).toString('base64url');
    this.jwt = { value: `${head}.${sig}`, at: t, keyId: c.keyId };
    return this.jwt.value;
  }

  async send(r: ApnsRequest): Promise<ApnsAnswer> {
    const c = this.config();
    if (!c) throw new PushError('iPhone push isn’t set up. An admin adds the Apple key under Settings → Notifications → iPhone app.');
    const origin = this.baseUrl ?? (r.environment === 'sandbox' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com');
    let bearer: string;
    try {
      bearer = this.token(c);
    } catch {
      throw new PushError('Marquee couldn’t use the saved Apple key. Paste the .p8 key again under Settings → Notifications → iPhone app.');
    }
    const session = http2.connect(origin);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<ApnsAnswer>((resolve, reject) => {
        timer = setTimeout(() => {
          session.destroy();
          reject(new PushError('Couldn’t reach Apple. Check your internet.'));
        }, 10_000);
        session.on('error', () => {
          reject(new PushError('Couldn’t reach Apple. Check your internet.'));
        });
        const req = session.request({
          ':method': 'POST',
          ':path': `/3/device/${r.token}`,
          authorization: `bearer ${bearer}`,
          'apns-topic': c.bundleId + (r.topicSuffix ?? ''),
          'apns-push-type': r.pushType ?? 'alert',
          'apns-priority': String(r.priority ?? 10),
          ...(r.expiration !== undefined ? { 'apns-expiration': String(r.expiration) } : {}),
          'content-type': 'application/json',
        });
        let status = 0;
        let body = '';
        req.on('response', (h) => (status = Number(h[':status'])));
        req.on('data', (d: Buffer) => (body += d.toString()));
        req.on('end', () => {
          let reason: string | null = null;
          try {
            reason = (JSON.parse(body) as { reason?: string }).reason ?? null;
          } catch {
            /* no body on success */
          }
          resolve({ status, reason });
        });
        req.on('error', () => {
          reject(new PushError('Couldn’t reach Apple. Check your internet.'));
        });
        req.end(JSON.stringify(r.payload));
      });
    } finally {
      clearTimeout(timer);
      session.destroy();
    }
  }
}
