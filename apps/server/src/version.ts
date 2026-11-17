/** "main-f00a740…" from CI, shortened to "main-f00a740"; "1.2.0" for releases; "dev" locally. */
export const VERSION = (process.env.MARQUEE_VERSION ?? 'dev').replace(/^(.+-[0-9a-f]{7})[0-9a-f]{33}$/, '$1');
