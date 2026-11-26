import type { NotificationEventInfo, NotificationPriority, NotificationVar } from '@marquee/shared';

/**
 * Everything Marquee can tell people about. Each event says who it is for
 * (admins, or the person who asked for the title), which bits of
 * information it carries (its variables), and Marquee's own wording, which
 * an admin can change in Settings → Notifications → Wording.
 */

const v = (key: string, label: string, example: string): NotificationVar => ({ key, label, example });

const poster = v('poster', 'Cover art address', 'https://image.tmdb.org/t/p/w500/8b8R8l88Qje9dn9OE8PY05Nxl1X.jpg');
const titleVar = (example = 'Dune: Part Two') => v('title', 'Movie or show', example);
const year = v('year', 'Year', '2024');

const stream = [
  v('user', 'Who', 'Ana'),
  titleVar('Severance'),
  v('subtitle', 'Episode', 'S01E02 · Half Loop'),
  v('show', 'Show (episodes only)', 'Severance'),
  v('season', 'Season number', '1'),
  v('episode', 'Episode number', '2'),
  year,
  v('device', 'Device', 'Living room TV'),
  v('app', 'App', 'Plex for Roku'),
  v('quality', 'Picture size', '1080p'),
  v('converting', 'Being converted (yes or blank)', ''),
  v('reason', 'Why it’s being converted', 'The subtitles are drawn onto the picture (this device can’t show them itself).'),
  v('server', 'Plex or Jellyfin', 'Plex'),
  poster,
];
const streamBody = '{{#subtitle}}{{subtitle}} {{/subtitle}}on {{device}}{{#converting}} (the server is converting it){{/converting}}.';

const download = [titleVar(), v('release', 'Copy name', 'Dune.Part.Two.2024.2160p.WEB-DL.DV.HDR.H.265-FLUX'), poster];

const LIST: Omit<NotificationEventInfo, 'priority'>[] = [
  // Requests
  {
    key: 'request_pending', group: 'Requests', audience: 'admins', label: 'Someone asked for something', description: 'A request is waiting for you to approve or turn down.',
    vars: [v('user', 'Who asked', 'Jessie'), titleVar(), year, v('kind', 'Movie or show', 'movie'), v('seasons', 'Seasons asked for', 'All'), poster],
    title: 'New request', body: '{{user}} asked for {{title}}{{#year}} ({{year}}){{/year}}.', image: '{{poster}}',
  },
  {
    key: 'request_approved', group: 'Requests', audience: 'requester', label: 'Your request was approved', description: 'An admin said yes. Marquee is looking for it.',
    vars: [titleVar(), year, v('by', 'Who approved it', 'Josh'), poster],
    title: 'Request approved', body: '{{title}} was approved. Marquee is looking for it.', image: '{{poster}}',
  },
  {
    key: 'request_declined', group: 'Requests', audience: 'requester', label: 'Your request was turned down', description: 'An admin said no, and says why.',
    vars: [titleVar(), year, v('reason', 'Why', 'We already have it on Netflix'), v('by', 'Who turned it down', 'Josh'), poster],
    title: 'Request turned down', body: '{{title}} was turned down{{#reason}}: {{reason}}{{/reason}}{{^reason}}.{{/reason}}', image: '{{poster}}',
  },
  {
    key: 'request_ready', group: 'Requests', audience: 'requester', label: 'Ready to watch', description: 'What you asked for is in the library.',
    vars: [titleVar(), year, poster],
    title: 'Ready to watch', body: '{{title}} is in the library.', image: '{{poster}}',
  },
  {
    key: 'new_episode', group: 'Requests', audience: 'requester', label: 'New episode of a show you asked for', description: 'A new episode of a show you requested is in the library.',
    vars: [v('show', 'Show', 'Severance'), v('episodes', 'Which episodes', 'S02E03'), v('season', 'Season', '2'), poster],
    title: 'New episode of {{show}}', body: '{{episodes}} is ready to watch.', image: '{{poster}}',
  },

  // Downloads and the library
  {
    key: 'download_finished', group: 'Downloads', audience: 'admins', label: 'A download finished', description: 'The downloader has the whole copy.',
    vars: download, title: 'Download finished', body: '{{release}}', image: '{{poster}}',
  },
  {
    key: 'download_problem', group: 'Downloads', audience: 'admins', label: 'A download is stuck or failed', description: 'Nobody is sharing it so Marquee tried another copy, it looked fake, or it couldn’t be put in the library.',
    vars: [v('problem', 'What happened', 'Tried another copy'), ...download, v('reason', 'Why', 'No progress for 6 hours.')],
    title: '{{problem}}', body: '{{release}}: {{reason}}', image: '',
  },
  {
    key: 'imported', group: 'Downloads', audience: 'admins', label: 'Added to the library', description: 'A finished download went into the library.',
    vars: [...download, v('files', 'File names', 'Dune Part Two (2024).mkv')],
    title: 'Added to the library', body: '{{files}}', image: '{{poster}}',
  },
  {
    key: 'upgraded', group: 'Downloads', audience: 'admins', label: 'Swapped in a better copy', description: 'A better copy replaced one already in the library. The old file is kept in a hidden folder.',
    vars: [...download, v('files', 'File names', 'Dune Part Two (2024).mkv')],
    title: 'Upgraded: {{title}}', body: 'Swapped in a better copy: {{files}}.', image: '{{poster}}',
  },
  {
    key: 'episode_aired', group: 'Downloads', audience: 'admins', label: 'A wanted episode came out', description: 'An episode of a show you want aired today. Marquee is looking for it.',
    vars: [v('summary', 'Short summary', 'New episode: Severance S02E03'), v('episodes', 'Which episodes', 'Severance S02E03'), v('count', 'How many', '1')],
    title: '{{summary}}', body: '{{episodes}}. Marquee is looking for them.', image: '',
  },

  // Problems
  {
    key: 'source_problem', group: 'Problems', audience: 'admins', label: 'A Source stopped working', description: 'A Source has failed several times in a row. Says what to do about it.',
    vars: [v('source', 'Source', 'IPTorrents'), v('problem', 'What’s wrong', 'Turned down the key'), v('fix', 'What to do', 'Check the key in Settings → Sources.')],
    title: '{{source}} stopped working', body: '{{problem}}.{{#fix}} {{fix}}{{/fix}}', image: '',
  },
  {
    key: 'downloader_problem', group: 'Problems', audience: 'admins', label: 'The downloader stopped working', description: 'Marquee can’t reach qBittorrent, it has no internet, or most downloads can’t find anyone to download from.',
    vars: [v('problem', 'What’s wrong', 'Can’t reach qBittorrent'), v('fix', 'What to do', 'Check it is running.')],
    title: 'qBittorrent stopped working', body: '{{problem}}.{{#fix}} {{fix}}{{/fix}}', image: '',
  },
  {
    key: 'media_server_problem', group: 'Problems', audience: 'admins', label: 'Plex or Jellyfin stopped answering', description: 'Marquee can’t reach a media server, so watching and library scans won’t work.',
    vars: [v('server', 'Plex or Jellyfin', 'Plex'), v('error', 'What went wrong', 'Plex didn’t answer.')],
    title: '{{server}} stopped answering', body: '{{error}} Marquee tries again by itself.', image: '',
  },

  {
    key: 'disk_low', group: 'Problems', audience: 'admins', label: 'A disk is nearly full', description: 'A downloads or library folder has less free than the minimum, so Marquee holds off on new downloads or copies.',
    vars: [v('folder', 'Which folder', 'Downloads'), v('path', 'Where', '/data/torrents'), v('free', 'Free space', '12.4 GB'), v('minimum', 'Minimum kept free', '20 GB')],
    title: '{{folder}} disk is nearly full', body: '{{free}} free on {{path}}; Marquee keeps {{minimum}} spare, so it’s waiting. Free up some space and it carries on by itself.', image: '',
  },

  // Watching
  { key: 'stream_started', group: 'Watching', audience: 'admins', label: 'Someone started watching', description: 'A movie or episode started playing on Plex or Jellyfin.', quiet: true, vars: stream, title: '{{user}} started {{title}}', body: streamBody, image: '{{poster}}' },
  {
    key: 'stream_stopped', group: 'Watching', audience: 'admins', label: 'Someone finished watching', description: 'A stream ended after at least 30 seconds, with how long it was watched.', quiet: true,
    vars: [...stream, v('minutes', 'Minutes watched', '42'), v('percent', 'How far through (%)', '87')],
    title: '{{user}} finished watching {{title}}', body: '{{#subtitle}}{{subtitle}}: {{/subtitle}}watched {{minutes}} min ({{percent}}% through) on {{device}}.', image: '{{poster}}',
  },
  { key: 'stream_transcoding', group: 'Watching', audience: 'admins', label: 'A stream is being converted', description: 'The server is re-encoding video for a device, which uses extra power.', quiet: true, vars: stream, title: '{{title}} is being converted', body: '{{user}} on {{device}}. {{#reason}}{{reason}} {{/reason}}Converting uses extra power on the server.', image: '' },
  { key: 'stream_paused', group: 'Watching', audience: 'admins', label: 'Someone paused', description: 'A stream was paused.', quiet: true, vars: stream, title: '{{user}} paused {{title}}', body: streamBody, image: '' },
  { key: 'stream_resumed', group: 'Watching', audience: 'admins', label: 'Someone resumed', description: 'A paused stream carried on.', quiet: true, vars: stream, title: '{{user}} resumed {{title}}', body: streamBody, image: '' },

  // Something wrong?
  {
    key: 'issue_reported', group: 'Requests', audience: 'admins', label: 'Someone says something’s wrong', description: 'Someone reported a problem with a title: picture, sound, subtitles, the wrong title or something else.',
    vars: [v('user', 'Who', 'Jessie'), titleVar(), v('problem', 'What’s wrong', 'The sound is out of sync'), v('message', 'What they said', 'From about 20 minutes in.')],
    title: 'Something’s wrong with {{title}}', body: '{{user}}: {{problem}}{{#message}}. “{{message}}”{{/message}}', image: '',
  },
  {
    key: 'issue_comment', group: 'Requests', audience: 'admins', label: 'Someone replied about a problem', description: 'The person who reported a problem wrote back.',
    vars: [v('user', 'Who', 'Jessie'), titleVar(), v('message', 'What they said', 'Still happening on the TV.')],
    title: '{{user}} replied about {{title}}', body: '{{message}}', image: '',
  },
  {
    key: 'issue_reply', group: 'Requests', audience: 'requester', label: 'A reply about a problem you reported', description: 'An admin wrote back about something you said was wrong.',
    vars: [v('by', 'Who', 'Josh'), titleVar(), v('message', 'What they said', 'Found a better copy, try it now.')],
    title: 'About {{title}}', body: '{{by}}: {{message}}', image: '',
  },
  {
    key: 'issue_fixed', group: 'Requests', audience: 'requester', label: 'A problem you reported is fixed', description: 'An admin marked something you reported as fixed.',
    vars: [v('by', 'Who', 'Josh'), titleVar(), v('message', 'What they said', 'Swapped in a better copy.')],
    title: '{{title}} is fixed', body: '{{by}} fixed it{{#message}}: {{message}}{{/message}}{{^message}}.{{/message}}', image: '',
  },

  // Marquee itself
  {
    key: 'marquee_updated', group: 'Marquee', audience: 'admins', label: 'Marquee was updated', description: 'Marquee started on a new version.',
    vars: [v('version', 'New version', '1.3.0'), v('previous', 'Old version', '1.2.0')],
    title: 'Marquee updated', body: 'Now on {{version}}{{#previous}} (was {{previous}}){{/previous}}.', image: '',
  },
];

export const PRIORITIES: NotificationPriority[] = ['silent', 'quiet', 'normal', 'high'];

/** Watching is chatty, so it arrives quietly; everything else arrives normally. Admins can change each one. */
export const EVENTS: NotificationEventInfo[] = LIST.map((e) => ({ ...e, priority: e.group === 'Watching' ? 'quiet' : 'normal' }));

/** Variables every message has, whatever the event. */
export const COMMON_VARS: NotificationVar[] = [
  v('link', 'Link into Marquee', 'https://marquee.example.com/requests'),
  v('time', 'When it happened', '18 Nov, 20:15'),
  v('event', 'What kind of message', 'Ready to watch'),
];

export const eventInfo = (key: string) => EVENTS.find((e) => e.key === key);
export const ADMIN_EVENTS = EVENTS.filter((e) => e.audience === 'admins').map((e) => e.key);
/** What a new channel gets: everything except the chatty events, which you turn on yourself. */
export const DEFAULT_ADMIN_EVENTS = EVENTS.filter((e) => e.audience === 'admins' && !e.quiet).map((e) => e.key);
/** Events a person can hear about: their own, plus the admin ones for admins. */
export const eventsFor = (role: string) => EVENTS.filter((e) => e.audience === 'requester' || role === 'admin');

/** What a new channel of someone's own starts with: everything they get that isn't a quiet one. */
export const defaultEventsFor = (u: { role: 'admin' | 'member' | 'kid' }) => eventsFor(u.role).filter((e) => !e.quiet).map((e) => e.key);
