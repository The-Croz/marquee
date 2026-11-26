import { Hono } from 'hono';
import { avatarFor } from '../auth/avatars.js';
import { findUserById } from '../auth/users.js';
import { HttpError, requireUser, type Env } from '../http.js';

/** Everyone's picture, for anyone signed in. */
export const avatarRoutes = new Hono<Env>();

avatarRoutes.get('/:id{[0-9]+}', async (c) => {
  requireUser(c);
  const { db, clients, config, now } = c.get('deps');
  const user = findUserById(db, Number(c.req.param('id')));
  const picture = user && (await avatarFor({ db, clients, now }, user, config.oidc?.issuer ?? null));
  if (!picture) throw new HttpError(404, 'not_found', 'No picture.');
  return c.body(new Uint8Array(picture.body), 200, {
    'Content-Type': picture.type,
    // The address changes when the picture does, so a phone or browser can keep it.
    'Cache-Control': 'private, max-age=86400',
    'X-Content-Type-Options': 'nosniff',
  });
});
