import type { NotificationEventInfo } from '@marquee/shared';

/**
 * Everything Marquee can tell people about. Each event says who it is for:
 * admins (in their inbox and on the push channels the admin sets up) or the
 * person who asked for the title (in their inbox).
 */
export const EVENTS: NotificationEventInfo[] = [
  { key: 'request_pending', audience: 'admins', label: 'Someone asked for something', description: 'A request is waiting for you to approve or turn down.' },
  { key: 'request_approved', audience: 'requester', label: 'Your request was approved', description: 'An admin said yes. Marquee is looking for it.' },
  { key: 'request_declined', audience: 'requester', label: 'Your request was turned down', description: 'An admin said no, and says why.' },
  { key: 'request_ready', audience: 'requester', label: 'Ready to watch', description: 'What you asked for is in the library.' },
  { key: 'download_finished', audience: 'admins', label: 'A download finished', description: 'The downloader has the whole copy.' },
  { key: 'download_problem', audience: 'admins', label: 'A download is stuck or failed', description: 'Nobody is sharing it so Marquee tried another copy, it looked fake, or it couldn’t be put in the library.' },
  { key: 'source_problem', audience: 'admins', label: 'A Source stopped working', description: 'A Source has failed several times in a row. Says what to do about it.' },
  { key: 'downloader_problem', audience: 'admins', label: 'The downloader stopped working', description: 'Marquee can’t reach qBittorrent, or it has no internet.' },
  { key: 'episode_aired', audience: 'admins', label: 'A wanted episode came out', description: 'An episode of a show you want aired today. Marquee is looking for it.' },
  { key: 'media_server_problem', audience: 'admins', label: 'Plex or Jellyfin stopped answering', description: 'Marquee can’t reach a media server, so watching and library scans won’t work.' },
  { key: 'stream_started', audience: 'admins', label: 'Someone started watching', description: 'A movie or episode started playing on Plex or Jellyfin.', quiet: true },
  { key: 'stream_stopped', audience: 'admins', label: 'Someone finished watching', description: 'A stream ended after at least 30 seconds, with how long it was watched.', quiet: true },
  { key: 'stream_transcoding', audience: 'admins', label: 'A stream is being converted', description: 'The server is re-encoding video for a device, which uses extra power.', quiet: true },
  { key: 'stream_paused', audience: 'admins', label: 'Someone paused', description: 'A stream was paused.', quiet: true },
  { key: 'stream_resumed', audience: 'admins', label: 'Someone resumed', description: 'A paused stream carried on.', quiet: true },
  { key: 'imported', audience: 'admins', label: 'Added to the library', description: 'A finished download went into the library.' },
];

export const eventInfo = (key: string) => EVENTS.find((e) => e.key === key);
export const ADMIN_EVENTS = EVENTS.filter((e) => e.audience === 'admins').map((e) => e.key);
/** What a new channel gets: everything except the chatty events, which you turn on yourself. */
export const DEFAULT_ADMIN_EVENTS = EVENTS.filter((e) => e.audience === 'admins' && !e.quiet).map((e) => e.key);
