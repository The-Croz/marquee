import type { SiteField, SiteSummary } from '@marquee/shared';
import type { TorznabApi } from '../../torznab.js';
import type { SiteSettingsValues } from '../cardigann.js';
import type { SiteHttp } from '../http.js';

/** A site written into Marquee itself (Prowlarr has these in code, not in its catalogue). */
export interface BuiltinSite {
  summary: SiteSummary;
  links: string[];
  fields: SiteField[];
  create(o: { settings: SiteSettingsValues; baseUrl: string; http: SiteHttp; now: () => number }): TorznabApi;
}
