import { describe, expect, it } from 'vitest';
import { render, unknownNames } from '../src/notify/template.js';
import { HttpPushClient } from '../src/notify/push.js';
import { announceVersion } from '../src/notify/updated.js';
import { EVENTS } from '../src/notify/events.js';
import { notificationChannels, notifications } from '../src/db/schema.js';
import { makeApp, setupAdmin } from './helpers.js';

describe('notification wording', () => {
  it('fills in names, shows parts only when they have a value, and leaves unknown names empty', () => {
    expect(render('{{title}}{{#year}} ({{year}}){{/year}}', { title: 'Up', year: 2009 })).toBe('Up (2009)');
    expect(render('{{title}}{{#year}} ({{year}}){{/year}}', { title: 'Up', year: null })).toBe('Up');
    expect(render('Turned down{{#reason}}: {{reason}}{{/reason}}{{^reason}}.{{/reason}}', { reason: '' })).toBe('Turned down.');
    expect(render('{{ user }} {{nope}}!', { user: 'Ana' })).toBe('Ana !');
    expect(render('{{#a}}A{{#b}}B{{/b}}{{/a}}', { a: 1, b: 'x' })).toBe('AB');
    expect(render('{{#converting}}converting{{/converting}}', { converting: true })).toBe('converting');
    expect(render('{{#converting}}converting{{/converting}}', { converting: false })).toBe('');
    expect(unknownNames('{{title}} {{#reason}}{{/reason}} {{oops}}', ['title', 'reason'])).toEqual(['oops']);
  });

  it('every event’s own wording only uses names it has, and has an example for each', () => {
    const common = ['link', 'time', 'event'];
    for (const e of EVENTS) {
      const names = [...e.vars.map((v) => v.key), ...common];
      expect(unknownNames(`${e.title} ${e.body} ${e.image}`, names), e.key).toEqual([]);
      for (const v of e.vars) expect(v.label, `${e.key}.${v.key}`).toBeTruthy();
    }
  });
});

describe('sending', () => {
  const recorder = (images: Record<string, Response> = {}) => {
    const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
    const f = (async (url: string, init: RequestInit = {}) => {
      if (images[url]) return images[url];
      calls.push({ url, body: init.body, headers: (init.headers ?? {}) as Record<string, string> });
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    return { calls, f };
  };

  it('ntfy gets JSON, so any title arrives as written, with the link and picture', async () => {
    const { calls, f } = recorder();
    await new HttpPushClient(f).send({ kind: 'ntfy', config: { server: 'https://ntfy.example/', topic: 'family', token: 'tok' } }, { title: '🎬 Ready: Amélie', body: 'In the library.', link: 'https://m/x', image: 'https://img/p.jpg' });
    expect(calls[0]!.url).toBe('https://ntfy.example/');
    expect(calls[0]!.headers).toMatchObject({ Authorization: 'Bearer tok', 'Content-Type': 'application/json' });
    expect(JSON.parse(calls[0]!.body as string)).toEqual({ topic: 'family', title: '🎬 Ready: Amélie', message: 'In the library.', click: 'https://m/x', attach: 'https://img/p.jpg' });
  });

  it('Pushover gets the picture itself, and a picture that can’t be fetched is just left out', async () => {
    const png = new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } });
    const { calls, f } = recorder({ 'https://img/ok.png': png, 'https://img/bad.png': new Response('no', { status: 404 }) });
    const client = new HttpPushClient(f);
    await client.send({ kind: 'pushover', config: { appToken: 'a', userKey: 'u' } }, { title: 'T', body: 'B', image: 'https://img/ok.png' });
    await client.send({ kind: 'pushover', config: { appToken: 'a', userKey: 'u' } }, { title: 'T', body: 'B', image: 'https://img/bad.png' });
    const first = calls[0]!.body as URLSearchParams;
    expect(first.get('attachment_base64')).toBe(Buffer.from([1, 2, 3]).toString('base64'));
    expect(first.get('attachment_type')).toBe('image/png');
    expect((calls[1]!.body as URLSearchParams).get('attachment_base64')).toBeNull();
  });
});

describe('Marquee updated', () => {
  it('tells admins once when the version changes, never on the first start or for dev builds', async () => {
    const pushed: string[] = [];
    const t = makeApp();
    await setupAdmin(t.app);
    t.db.insert(notificationChannels).values({ kind: 'ntfy', name: 'Phone', config: '{"topic":"t"}', events: '["marquee_updated"]', createdAt: 1 }).run();
    const deps = { db: t.db, push: { send: async (_c: unknown, m: { title: string; body: string }) => void pushed.push(`${m.title}: ${m.body}`) }, now: () => 1 };
    expect(await announceVersion(deps, '1.0.0')).toBe(false);
    expect(await announceVersion(deps, '1.0.0')).toBe(false);
    expect(await announceVersion(deps, '1.1.0')).toBe(true);
    expect(await announceVersion(deps, 'dev')).toBe(false);
    expect(pushed).toEqual(['Marquee updated: Now on 1.1.0 (was 1.0.0).']);
    expect(t.db.select().from(notifications).all().map((n) => n.event)).toEqual(['marquee_updated']);
  });
});
