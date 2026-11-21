import { StreamingTopError, type StreamingTopApi, type TopTitle } from '../../src/discover/streamingTop.js';

/**
 * A fake Streaming Availability: each service's Top 10 is whatever the test
 * (or demo) sets. A wrong key is turned down like the real one.
 */
export class FakeStreamingTop {
  lists: Record<string, { movie?: number[]; series?: number[] }> = {};
  calls: string[] = [];
  down = false;

  as(key: string): StreamingTopApi {
    const check = () => {
      if (key !== 'good-top-key') throw new StreamingTopError('key', 'Streaming Availability turned the key down. Check it in Settings → Services.');
      if (this.down) throw new StreamingTopError('down', 'Streaming Availability didn’t answer. Marquee tries again later.');
    };
    return {
      top: async (service, kind): Promise<TopTitle[]> => {
        this.calls.push(`${service}:${kind}`);
        check();
        return (this.lists[service]?.[kind] ?? []).map((tmdbId) => ({ kind, tmdbId, title: '' }));
      },
      ping: async () => check(),
    };
  }
}
