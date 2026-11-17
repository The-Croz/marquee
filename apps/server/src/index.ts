import path from 'node:path';
import { serve } from '@hono/node-server';
import { loadConfig } from './config.js';
import { openDb } from './db/index.js';
import { createApp } from './app.js';
import { OidcProvider } from './auth/oidc.js';
import { PlexClient, plexClientId } from './auth/plex.js';
import { RateLimiter } from './auth/rateLimit.js';
import { purgeExpiredSessions } from './auth/sessions.js';

const config = loadConfig();
const db = openDb(path.join(config.dataDir, 'marquee.sqlite'));
const clientId = plexClientId(db);

const app = createApp({
  db,
  config,
  oidc: config.oidc ? new OidcProvider(config.oidc) : null,
  plex: () => new PlexClient(clientId),
  loginLimiter: new RateLimiter(10, 15 * 60 * 1000),
  now: Date.now,
});

purgeExpiredSessions(db);
setInterval(() => purgeExpiredSessions(db), 6 * 60 * 60 * 1000).unref();

const server = serve({ fetch: app.fetch, port: config.port, hostname: '0.0.0.0' }, (info) => {
  console.log(`Marquee listening on http://0.0.0.0:${info.port}`);
  console.log(`  data: ${config.dataDir}`);
  console.log(`  sign-in: password${config.oidc ? `, ${config.oidc.name} (OIDC)` : ''}${config.plex.enabled ? ', Plex' : ''}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close();
    db.$client.close();
    process.exit(0);
  });
}
