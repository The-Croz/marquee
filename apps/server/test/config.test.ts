import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('has safe defaults: password sign-in only', () => {
    const c = loadConfig({});
    expect(c.port).toBe(9797);
    expect(c.oidc).toBeNull();
    expect(c.plex).toEqual({ enabled: false, serverId: null, autoCreate: false });
    expect(c.tmdbApiKey).toBeNull();
  });

  it('reads the Unraid template variables', () => {
    const c = loadConfig({
      MARQUEE_BASE_URL: 'https://marquee.example.com/',
      OIDC_ISSUER: 'https://id.example.com',
      OIDC_CLIENT_ID: 'marquee',
      OIDC_CLIENT_SECRET: 's3cret',
      OIDC_NAME: 'Pocket ID',
      OIDC_AUTO_CREATE: 'false',
      PLEX_LOGIN: 'true',
      PLEX_SERVER_ID: 'abc123',
      PLEX_AUTO_CREATE: 'true',
      TMDB_API_KEY: '  key  ',
    });
    expect(c.baseUrl).toBe('https://marquee.example.com');
    expect(c.oidc).toMatchObject({ name: 'Pocket ID', autoCreate: false, clientSecret: 's3cret' });
    expect(c.plex).toEqual({ enabled: true, serverId: 'abc123', autoCreate: true });
    expect(c.tmdbApiKey).toBe('key');
  });

  it('ignores Plex auto-create without a server id, and blank optional values', () => {
    const c = loadConfig({ PLEX_LOGIN: 'yes', PLEX_AUTO_CREATE: 'true', OIDC_ISSUER: '', OIDC_CLIENT_ID: 'x' });
    expect(c.plex.autoCreate).toBe(false);
    expect(c.oidc).toBeNull();
  });
});
