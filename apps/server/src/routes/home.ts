import { Hono } from 'hono';
import type { HomeData } from '@marquee/shared';
import { requireUser, type Env } from '../http.js';

/**
 * Home screen data. Until the library (M1), downloads (M3), requests (M5) and
 * stats (M6) exist, this returns the sample data from the design mockups so the
 * UI can be built and reviewed. `sample: true` tells the web app to say so.
 */
export const homeRoutes = new Hono<Env>();

homeRoutes.get('/', (c) => {
  const user = requireUser(c);
  const isAdmin = user.role === 'admin';
  const isKid = user.role === 'kid';

  const data: HomeData = {
    sample: true,
    nowDownloading: isKid
      ? null
      : {
          title: 'Dune: Part Two',
          requestedBy: 'Partner',
          quality: '4K HDR',
          profile: 'Cinema · efficient',
          size: '21.4 GB',
          percent: 62,
          speed: '48 MB/s',
          eta: 'About 8 min left',
        },
    stats: [
      { label: 'Watching now', value: '2', note: 'Plex 1 · Jellyfin 1' },
      { label: 'Added this week', value: '11', note: '3 movies · 8 episodes' },
      ...(isAdmin ? [{ label: 'Waiting for your OK', value: '2', note: 'From the Kids profile' }] : []),
      { label: 'Free space', value: '18.4 TB', note: 'of 60 TB' },
    ],
    approvals: isAdmin
      ? [
          { id: 1, title: 'Paw Patrol: The Mighty Movie', who: 'Kids · asked 2 hours ago', plan: 'Will use Kids & Cartoons · 720p', color: '#1F4E8C' },
          { id: 2, title: 'Bluey — Season 3', who: 'Kids · asked yesterday', plan: 'Kids & Cartoons · 720p · 3 episodes missing', color: '#3B8FB8' },
        ]
      : [],
    watching: isKid
      ? []
      : [
          { title: 'The Bear · S3 E4', who: 'Josh · Living Room TV · Plex', mode: 'Direct play · 4K', percent: 64 },
          { title: 'Bluey · S2 E19', who: 'Kids · iPad · Jellyfin', mode: 'Converting · 720p', percent: 30 },
        ],
    recent: (isKid
      ? [
          { title: 'Bluey', sub: 'S3 E41 · 720p', color: '#3B8FB8' },
          { title: 'Inside Out 2', sub: 'Movie · 4K HDR', color: '#7A3B6E' },
        ]
      : [
          { title: 'Dune: Part Two', sub: 'Movie · 4K HDR', color: '#6B3E1E' },
          { title: 'Severance', sub: 'S2 E7 · 4K HDR', color: '#22364A' },
          { title: 'The Bear', sub: 'S3 E5 · 1080p', color: '#5A2A22' },
          { title: 'Bluey', sub: 'S3 E41 · 720p', color: '#3B8FB8' },
          { title: 'Andor', sub: 'S2 E3 · 4K HDR', color: '#3C3A34' },
          { title: 'Inside Out 2', sub: 'Movie · 4K HDR', color: '#7A3B6E' },
          { title: 'Shōgun', sub: 'S1 E10 · 4K HDR', color: '#4A1F1A' },
        ]),
    upcoming: isKid
      ? [{ day: 'Sun', title: 'Bluey · new episodes', note: 'Kids & Cartoons · 720p' }]
      : [
          { day: 'Tue', title: 'Severance · next episode', note: 'Will grab 4K HDR automatically' },
          { day: 'Thu', title: 'The Bear · next episode', note: 'No 4K expected · 1080p' },
          { day: 'Fri', title: 'Andor · next episode', note: 'Will grab 4K HDR automatically' },
          { day: 'Sun', title: 'Bluey · new episodes', note: 'Kids & Cartoons · 720p' },
        ],
  };
  return c.json(data);
});
