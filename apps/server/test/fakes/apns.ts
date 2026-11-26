import { generateKeyPairSync, verify } from 'node:crypto';
import http2 from 'node:http2';
import type { AddressInfo } from 'node:net';

export interface ApplePush {
  token: string;
  headers: Record<string, string>;
  payload: any;
  /** The JWT checked out: signed by our key, with the key id and team id we gave. */
  jwtOk: boolean;
  jwtKeyId: string;
  jwtTeamId: string;
}

/** A fake Apple push service: a local HTTP/2 server that checks the signed token and records every push. */
export class FakeApple {
  pushes: ApplePush[] = [];
  /** Answers for particular tokens, e.g. 410 for a phone that deleted the app. */
  answers = new Map<string, { status: number; reason: string }>();
  readonly keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  readonly privateKeyPem = this.keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  url = '';
  /** Called for every push (demo mode logs them). */
  onPush: ((p: ApplePush) => void) | null = null;
  private server = http2.createServer();

  async start(): Promise<this> {
    this.server.on('stream', (stream: http2.ServerHttp2Stream, headers) => {
      let body = '';
      stream.on('data', (d: Buffer) => (body += d.toString()));
      stream.on('end', () => {
        const token = String(headers[':path']).replace('/3/device/', '');
        const auth = String(headers.authorization ?? '').replace(/^bearer /, '');
        const [h, p, sig] = auth.split('.');
        let jwtOk = false;
        let jwtKeyId = '';
        let jwtTeamId = '';
        try {
          jwtKeyId = JSON.parse(Buffer.from(h!, 'base64url').toString()).kid;
          jwtTeamId = JSON.parse(Buffer.from(p!, 'base64url').toString()).iss;
          jwtOk = verify('sha256', Buffer.from(`${h}.${p}`), { key: this.keys.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig!, 'base64url'));
        } catch {
          /* not ok */
        }
        const flat: Record<string, string> = {};
        for (const [k, v] of Object.entries(headers)) flat[k] = String(v);
        const push = { token, headers: flat, payload: JSON.parse(body || '{}'), jwtOk, jwtKeyId, jwtTeamId };
        this.pushes.push(push);
        this.onPush?.(push);
        const answer = this.answers.get(token);
        if (!jwtOk) {
          stream.respond({ ':status': 403 });
          stream.end(JSON.stringify({ reason: 'InvalidProviderToken' }));
        } else if (answer) {
          stream.respond({ ':status': answer.status });
          stream.end(JSON.stringify({ reason: answer.reason }));
        } else {
          stream.respond({ ':status': 200 });
          stream.end();
        }
      });
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}
