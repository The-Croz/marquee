import type { CalendarItem } from '@marquee/shared';

/**
 * The calendar as an iCalendar feed (RFC 5545), for Apple Calendar, Google
 * Calendar or Outlook: one all-day event per episode or movie date.
 */

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

/** Long lines are folded at 75 octets, as the format asks. */
function fold(line: string): string {
  const out: string[] = [];
  let rest = line;
  while (Buffer.byteLength(rest) > 75) {
    let cut = 75;
    while (Buffer.byteLength(rest.slice(0, cut)) > 75) cut--;
    out.push(rest.slice(0, cut));
    rest = ` ${rest.slice(cut)}`;
  }
  out.push(rest);
  return out.join('\r\n');
}

const day = (iso: string) => iso.replace(/-/g, '');
const nextDay = (iso: string) => new Date(Date.parse(`${iso}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10).replace(/-/g, '');
const stamp = (now: number) => new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

export function toIcal(items: CalendarItem[], now: number, name = 'Marquee'): string {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Marquee//Calendar//EN', 'CALSCALE:GREGORIAN', `X-WR-CALNAME:${esc(name)}`, 'X-PUBLISHED-TTL:PT6H'];
  for (const i of items) {
    const summary = i.kind === 'episode' ? `${i.show} S${String(i.season).padStart(2, '0')}E${String(i.episode).padStart(2, '0')}${i.title ? ` · ${i.title}` : ''}` : `${i.show}${i.title ? ` · ${i.title}` : ''}`;
    const uid = i.kind === 'episode' ? `ep-${i.seriesId}-${i.season}-${i.episode}@marquee` : `movie-${i.movieId}-${day(i.airDate)}@marquee`;
    lines.push('BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${stamp(now)}`, `DTSTART;VALUE=DATE:${day(i.airDate)}`, `DTEND;VALUE=DATE:${nextDay(i.airDate)}`, `SUMMARY:${esc(summary)}`, `DESCRIPTION:${esc(i.note)}`, 'TRANSP:TRANSPARENT', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}
