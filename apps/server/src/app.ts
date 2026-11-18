import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { ZodError } from 'zod';
import type { ApiError } from '@marquee/shared';
import { getSessionUser } from './auth/sessions.js';
import { HttpError, sessionToken, type Deps, type Env } from './http.js';
import { authRoutes } from './routes/auth.js';
import { accountRoutes } from './routes/account.js';
import { userRoutes } from './routes/users.js';
import { homeRoutes } from './routes/home.js';
import { servicesRoutes } from './routes/services.js';
import { sourcesRoutes } from './routes/sources.js';
import { libraryRoutes, movieRoutes, showRoutes } from './routes/library.js';
import { profileRoutes } from './routes/profiles.js';
import { movieCopyRoutes, showCopyRoutes } from './routes/copies.js';
import { compareRoutes } from './routes/compare.js';
import { downloaderRoutes } from './routes/downloader.js';
import { downloadRoutes } from './routes/downloads.js';
import { cutoverRoutes } from './routes/cutover.js';
import { calendarRoutes } from './routes/calendar.js';
import { discoverRoutes } from './routes/discover.js';
import { requestRoutes } from './routes/requests.js';
import { channelRoutes, notificationRoutes } from './routes/notifications.js';
import { CopyCache } from './downloads/cache.js';
import { seedProfiles } from './releases/profiles.js';
import { seedChoices } from './releases/choose.js';

import { VERSION } from './version.js';

export function createApp(given: Omit<Deps, 'copies'> & { copies?: CopyCache }) {
  const deps: Deps = { ...given, copies: given.copies ?? new CopyCache(given.now) };
  const app = new Hono<Env>();
  seedProfiles(deps.db, deps.now());
  seedChoices(deps.db);

  app.use(
    '*',
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
      },
      crossOriginOpenerPolicy: false, // the Plex sign-in popup needs to talk back
    }),
  );

  app.use('/api/*', async (c, next) => {
    c.set('deps', deps);
    // CSRF guard: writes with a body must be JSON. Browsers can't send a
    // cross-site JSON request (or any DELETE/PUT/PATCH) without a CORS
    // preflight, which we never allow, so a plain HTML form can't reach us.
    if (['POST', 'PUT', 'PATCH'].includes(c.req.method)) {
      const type = c.req.header('content-type') ?? '';
      if (!type.startsWith('application/json')) {
        return c.json<ApiError>({ error: 'bad_request', message: 'Send JSON with Content-Type: application/json.' }, 415);
      }
    }
    c.set('user', getSessionUser(deps.db, sessionToken(c), deps.now()));
    await next();
  });

  app.get('/api/health', (c) => c.json({ ok: true, version: VERSION }));
  app.route('/api/auth', authRoutes);
  app.route('/api/me', accountRoutes);
  app.route('/api/users', userRoutes);
  app.route('/api/home', homeRoutes);
  app.route('/api/settings/services', servicesRoutes);
  app.route('/api/settings/sources', sourcesRoutes);
  app.route('/api/settings/profiles', profileRoutes);
  app.route('/api/settings/downloader', downloaderRoutes);
  app.route('/api/downloads', downloadRoutes);
  app.route('/api/cutover', cutoverRoutes);
  app.route('/api/calendar', calendarRoutes);
  app.route('/api/discover', discoverRoutes);
  app.route('/api/requests', requestRoutes);
  app.route('/api/notifications', notificationRoutes);
  app.route('/api/settings/notifications', channelRoutes);
  app.route('/api/compare', compareRoutes);
  app.route('/api/library', libraryRoutes);
  app.route('/api/movies', movieRoutes);
  app.route('/api/shows', showRoutes);
  app.route('/api/movies', movieCopyRoutes);
  app.route('/api/shows', showCopyRoutes);
  app.all('/api/*', (c) => c.json<ApiError>({ error: 'not_found', message: 'No such endpoint.' }, 404));

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json<ApiError>({ error: err.code, message: err.message }, err.status);
    if (err instanceof ZodError) {
      return c.json<ApiError>({ error: 'invalid_input', message: err.issues[0]?.message ?? 'Invalid input.' }, 400);
    }
    if (err instanceof SyntaxError) return c.json<ApiError>({ error: 'invalid_json', message: 'Request body is not valid JSON.' }, 400);
    console.error('[http] unhandled error', err);
    return c.json<ApiError>({ error: 'internal', message: 'Something went wrong on the server.' }, 500);
  });

  if (deps.config.webDir) mountWeb(app, deps.config.webDir);
  return app;
}

/** Serves the built web app and falls back to index.html for client-side routes. */
function mountWeb(app: Hono<Env>, webDir: string) {
  const indexHtml = fs.readFileSync(path.join(webDir, 'index.html'));
  const types: Record<string, string> = {
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.json': 'application/json',
    '.webmanifest': 'application/manifest+json',
  };
  app.get('*', (c) => {
    const rel = decodeURIComponent(new URL(c.req.url).pathname);
    const file = path.normalize(path.join(webDir, rel));
    if (file.startsWith(webDir + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      const immutable = rel.startsWith('/assets/');
      return c.body(fs.readFileSync(file), 200, {
        'Content-Type': types[path.extname(file)] ?? 'application/octet-stream',
        'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      });
    }
    return c.body(indexHtml, 200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  });
}
