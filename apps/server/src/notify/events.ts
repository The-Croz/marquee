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
  { key: 'imported', audience: 'admins', label: 'Added to the library', description: 'A finished download went into the library.' },
];

export const eventInfo = (key: string) => EVENTS.find((e) => e.key === key);
export const ADMIN_EVENTS = EVENTS.filter((e) => e.audience === 'admins').map((e) => e.key);
