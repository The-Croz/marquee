import { describe, expect, it } from 'vitest';
import { applyTemplate, urlEncode } from '../src/sources/sites/template.js';
import { applyFilters } from '../src/sources/sites/filters.js';
import { fromTimeAgo, fromUnknown, parseBytes, parseDateLayout, toRegex } from '../src/sources/sites/text.js';
import { jsonGet } from '../src/sources/sites/cardigann.js';

const NOW = Date.parse('2026-11-18T12:00:00Z');

describe('site templates', () => {
  const vars = {
    '.Keywords': 'Dune Part Two',
    '.Config.sort': 'time',
    '.Config.disablesort': null,
    '.Config.freeleech': '.True',
    '.Config.uploader': '',
    '.True': 'True',
    '.False': null,
    '.Categories': ['1', '2'],
    '.Query.IMDBID': null,
  };

  it('fills in variables, if/else and else if', () => {
    expect(applyTemplate('search/{{ .Keywords }}/{{ .Config.sort }}/', vars)).toBe('search/Dune Part Two/time/');
    expect(applyTemplate('{{ if .Keywords }}q{{ else }}latest{{ end }}', vars)).toBe('q');
    expect(applyTemplate('{{ if .Query.IMDBID }}id{{ else if .Keywords }}words{{ else }}none{{ end }}', vars)).toBe('words');
    expect(applyTemplate('{{- if .Config.uploader -}} x {{- else -}} y {{- end -}}', vars)).toBe('y');
  });

  it('treats an off checkbox as .False and an on one as true, like Prowlarr', () => {
    expect(applyTemplate('{{ if and (.Keywords) (eq .Config.disablesort .False) }}sorted{{ else }}plain{{ end }}', vars)).toBe('sorted');
    expect(applyTemplate('{{ if .Config.freeleech }}free{{ end }}', vars)).toBe('free');
    expect(applyTemplate('{{ if eq .Config.freeleech .False }}off{{ else }}on{{ end }}', vars)).toBe('on');
  });

  it('reads and/or/eq without brackets, the way site files write them', () => {
    expect(applyTemplate('{{ if and eq .Config.sort "time" eq .Keywords "Dune Part Two" }}yes{{ else }}no{{ end }}', vars)).toBe('yes');
    expect(applyTemplate('{{ if or .Config.uploader .Keywords }}yes{{ end }}', vars)).toBe('yes');
    expect(applyTemplate('{{ if ne .Config.sort "time" }}yes{{ else }}no{{ end }}', vars)).toBe('no');
  });

  it('ranges over lists, joins them and replaces with patterns', () => {
    expect(applyTemplate('{{ range .Categories }}c{{.}}=1&{{end}}', vars)).toBe('c1=1&c2=1&');
    expect(applyTemplate('{{ range $i, $c := .Categories }}{{ $i }}:{{ $c }};{{ end }}', vars)).toBe('0:1;1:2;');
    expect(applyTemplate('{{ join .Categories "," }}', vars)).toBe('1,2');
    expect(applyTemplate('{{ re_replace .Keywords "\\s+" "." }}', vars)).toBe('Dune.Part.Two');
  });

  it('encodes values from variables for addresses, but not the text around them', () => {
    expect(applyTemplate('search/{{ .Keywords }}/?a=b', vars, urlEncode)).toBe('search/Dune%20Part%20Two/?a=b');
  });
});

describe('site filters', () => {
  const f = (value: string, filters: { name: string; args?: unknown }[]) => applyFilters(value, filters, {}, NOW);

  it('replaces, splits, trims and picks out parts', () => {
    expect(f('Dune-Part-Two', [{ name: 'replace', args: ['-', ' '] }])).toBe('Dune Part Two');
    expect(f('a/b/c', [{ name: 'split', args: ['/', 1] }])).toBe('b');
    expect(f('a/b/c', [{ name: 'split', args: ['/', -1] }])).toBe('c');
    expect(f('/torrent/123/Dune-torrent-456.html', [{ name: 'regexp', args: '/(.+?)-torrent-\\d+\\.html' }])).toBe('torrent/123/Dune');
    expect(f('details.php?id=42&x=1', [{ name: 'querystring', args: 'id' }])).toBe('42');
    expect(f('  hi  ', [{ name: 'trim' }])).toBe('hi');
    expect(f('Dune', [{ name: 'append', args: ' 2024' }, { name: 'prepend', args: 'The ' }])).toBe('The Dune 2024');
  });

  it('reads .NET-style regular expressions and replacements', () => {
    expect(f('Season 2 Complete', [{ name: 're_replace', args: ['(?i)\\bseason[\\s.]+(\\d)([\\s.]+complete)?\\b', 'S0$1'] }])).toBe('S02');
    expect(f('abc', [{ name: 're_replace', args: ['(?<x>b)', '[${x}]'] }])).toBe('a[b]c');
    expect(toRegex('([\\p{IsCJKUnifiedIdeographs}\\W]+)')).not.toBeNull();
  });

  it('turns site dates into times', () => {
    expect(f('3 hours ago', [{ name: 'timeago' }])).toBe('2026-11-18T09:00:00.000Z');
    expect(f('2024-05-01 14:30', [{ name: 'dateparse', args: 'yyyy-MM-dd HH:mm' }])).toBe('2024-05-01T14:30:00.000Z');
    expect(f('2024-05-01 14:30', [{ name: 'dateparse', args: '2006-01-02 15:04' }])).toBe('2024-05-01T14:30:00.000Z');
    expect(f('Nov. 3rd 22', [{ name: 'dateparse', args: 'MMM. d yy' }])).toBe('2022-11-03T00:00:00.000Z');
    expect(f('Today 08:15', [{ name: 'fuzzytime' }])).toBe('2026-11-18T08:15:00.000Z');
  });
});

describe('site text', () => {
  it('reads sizes as sites write them', () => {
    expect(parseBytes('1.5 GB')).toBe(Math.round(1.5 * 1024 ** 3));
    expect(parseBytes('700 MiB')).toBe(700 * 1024 ** 2);
    expect(parseBytes('1,234.5 MB')).toBe(Math.round(1234.5 * 1024 ** 2));
    expect(parseBytes('1,5 GB')).toBe(Math.round(1.5 * 1024 ** 3));
    expect(parseBytes('123456789')).toBe(123456789);
    expect(parseBytes('nothing')).toBeNull();
  });

  it('reads dates in any of the usual forms', () => {
    expect(fromUnknown('1714573800', NOW)).toBe(1714573800 * 1000);
    expect(fromUnknown('2024-05-01T14:30:00Z', NOW)).toBe(Date.parse('2024-05-01T14:30:00Z'));
    expect(fromUnknown('2 days ago', NOW)).toBe(NOW - 2 * 86_400_000);
    expect(fromTimeAgo('Last Month', NOW)).toBe(NOW - 30 * 86_400_000);
    expect(fromUnknown('Yesterday', NOW)).toBe(Date.parse('2026-11-17T00:00:00Z'));
    // A date with no year that would be in the future is from last year.
    expect(parseDateLayout('Dec 25', 'MMM d', NOW)).toBe(Date.parse('2025-12-25T00:00:00Z'));
  });

  it('follows JSON paths', () => {
    const doc = { data: { movies: [{ id: 7, torrents: [{ hash: 'abc' }] }] }, 'a b': 1 };
    expect(jsonGet(doc, 'data.movies[0].torrents[0].hash')).toBe('abc');
    expect(jsonGet(doc.data.movies, '$[0].id')).toBe(7);
    expect(jsonGet(doc, "['a b']")).toBe(1);
    expect(jsonGet(doc, 'data.missing.x')).toBeUndefined();
  });
});
