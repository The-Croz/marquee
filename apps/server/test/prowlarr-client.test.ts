import { describe, expect, it } from 'vitest';
import { ProwlarrClient } from '../src/sources/prowlarr.js';

const failing = (err: Error) => (async () => {
  throw err;
}) as unknown as typeof fetch;

describe('Prowlarr client errors', () => {
  it('says plainly when Prowlarr is too slow or unreachable, and what to check', async () => {
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    await expect(new ProwlarrClient('http://p:9696', 'k', failing(timeout)).ping()).rejects.toThrow(/didn't answer within 30 seconds\. Check the address, and that Marquee's container can reach it\./);
    const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    await expect(new ProwlarrClient('http://p:9696', 'k', failing(refused)).ping()).rejects.toThrow("Couldn't reach Prowlarr at http://p:9696 (ECONNREFUSED). Check the address");
  });

  it('reads Prowlarr 3’s site list', async () => {
    const body = [{ id: 1, name: 'YTS', enable: true, protocol: 'torrent', privacy: 'public', priority: 25, capabilities: { categories: [{ id: 2000, subCategories: [{ id: 2040 }] }] } }];
    const ok = (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
    expect(await new ProwlarrClient('http://p:9696', 'k', ok).sites()).toEqual([{ id: 1, name: 'YTS', enabled: true, protocol: 'torrent', privacy: 'public', priority: 25, categories: [2000, 2040] }]);
  });
});
