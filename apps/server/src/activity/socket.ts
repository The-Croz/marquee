/**
 * A WebSocket that reconnects by itself. Plex and Jellyfin push a message the
 * moment something starts, pauses or stops playing; this keeps that line open.
 * Marquee uses those messages only as a nudge ("go and look"); what is really
 * playing is always read from the server, so a missed message costs nothing.
 */

export interface SocketLike {
  send(data: string): void;
  close(): void;
  onopen: ((e: unknown) => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: ((e: unknown) => void) | null;
  onerror: ((e: unknown) => void) | null;
}
export type SocketFactory = (url: string) => SocketLike;

/** Node 22 has WebSocket built in. */
export const nodeSocket: SocketFactory = (url) => new WebSocket(url) as unknown as SocketLike;

export interface Listener {
  url: string;
  /** Runs when the line opens, e.g. to subscribe. */
  onOpen?: (socket: SocketLike) => void;
  onMessage: (text: string) => void;
}

const FIRST_WAIT = 5_000;
const MAX_WAIT = 60_000;

/** Opens the line and reopens it (waiting longer each time) whenever it drops. Returns a function that closes it for good. */
export function keepListening(
  listener: Listener,
  onState: (connected: boolean) => void,
  factory: SocketFactory = nodeSocket,
  wait: (fn: () => void, ms: number) => unknown = (fn, ms) => (setTimeout(fn, ms) as unknown as { unref(): void }).unref(),
): () => void {
  let socket: SocketLike | null = null;
  let stopped = false;
  let delay = FIRST_WAIT;

  const connect = () => {
    if (stopped) return;
    let s: SocketLike;
    try {
      s = factory(listener.url);
    } catch {
      onState(false);
      wait(connect, delay);
      delay = Math.min(delay * 2, MAX_WAIT);
      return;
    }
    socket = s;
    s.onopen = () => {
      delay = FIRST_WAIT;
      onState(true);
      listener.onOpen?.(s);
    };
    s.onmessage = (e) => {
      if (typeof e.data === 'string') listener.onMessage(e.data);
    };
    s.onerror = () => {};
    s.onclose = () => {
      if (socket === s) socket = null;
      onState(false);
      if (stopped) return;
      wait(connect, delay);
      delay = Math.min(delay * 2, MAX_WAIT);
    };
  };
  connect();

  return () => {
    stopped = true;
    try {
      socket?.close();
    } catch {
      /* already closed */
    }
  };
}
