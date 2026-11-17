import type { CopyView } from '@marquee/shared';
import type { Decision } from './decide.js';

/** A decision as screens see it. Leaves out the download link, which stays on the server. */
export function copyView(d: Decision): CopyView {
  const p = d.parsed;
  return {
    title: d.copy.title,
    sizeBytes: d.copy.size,
    seeders: d.seeders,
    leechers: d.leechers,
    publishedAt: d.copy.publishedAt,
    infoUrl: d.copy.infoUrl,
    sources: d.sources,
    quality: d.quality,
    qualityLabel: d.qualityLabel,
    tier: d.tier,
    score: d.score,
    rules: d.rules,
    rejections: d.rejections,
    accepted: d.accepted,
    details: { resolution: p.resolution, hdr: p.hdr, codec: p.codec, audio: p.audio, atmos: p.atmos, service: p.service, group: p.group, editions: p.editions, repack: p.repack > 0 || p.proper },
  };
}
