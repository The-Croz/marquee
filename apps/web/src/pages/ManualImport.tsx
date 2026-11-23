import { useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import type { BrowseView, ImportFile, ImportItemResult, ImportScanView, SearchResult } from '@marquee/shared';
import { api, ApiFailure } from '../api';
import { PageHeader } from '../components/Page';
import { Sheet } from '../components/Overlay';
import { Poster, formatBytes } from '../components/Poster';
import { refreshAfterCare } from '../components/LibraryCare';
import { Button, Notice, cx } from '../components/ui';

/**
 * "Put files in your library" (older apps: manual import). Pick a folder in
 * the downloads folder or a library folder, check what Marquee thinks each
 * video is, fix what's wrong, and put them in with the usual rules.
 */

const errText = (e: unknown, fallback: string) => (e instanceof ApiFailure ? e.message : fallback);

interface Choice {
  on: boolean;
  kind: 'movie' | 'series';
  tmdbId: number | null;
  title: string;
  year: number | null;
  season: string;
  episodes: string;
}

/** "1", "1-3", "1, 2" → [1], [1, 2, 3], [1, 2]. */
function episodeList(text: string): number[] | null {
  const t = text.trim();
  if (!t) return null;
  const range = /^(\d+)\s*-\s*(\d+)$/.exec(t);
  if (range) {
    const [a, b] = [Number(range[1]), Number(range[2])];
    if (b < a || b - a > 50) return null;
    return Array.from({ length: b - a + 1 }, (_, i) => a + i);
  }
  const parts = t.split(/[\s,]+/).filter(Boolean).map(Number);
  return parts.every((n) => Number.isInteger(n) && n >= 0) ? parts : null;
}

function choiceFor(f: ImportFile): Choice {
  const g = f.guess;
  return {
    on: !!g && !f.inLibrary,
    kind: g?.kind ?? 'movie',
    tmdbId: g?.tmdbId ?? null,
    title: g?.title ?? '',
    year: g?.year ?? null,
    season: g?.season !== null && g?.season !== undefined ? String(g.season) : '',
    episodes: g?.episodes.length ? (g.episodes.length > 1 && g.episodes.at(-1)! - g.episodes[0]! === g.episodes.length - 1 ? `${g.episodes[0]}-${g.episodes.at(-1)}` : g.episodes.join(', ')) : '',
  };
}

export function ManualImportPage() {
  const [params, setParams] = useSearchParams();
  const folder = params.get('path');
  const looking = params.get('look') === '1';
  const go = (p: string | null, look = false) => setParams(p ? { path: p, ...(look ? { look: '1' } : {}) } : {}, { replace: false });

  return (
    <>
      <PageHeader
        title="Put files in your library"
        back={{ to: '/library', label: 'Library' }}
        info={
          <>
            Pick a folder of finished downloads (or one that didn’t go in by itself), check what each video is, and put them in. Files from the downloads folder are hardlinked, so qBittorrent keeps sharing; a file already in a library folder is moved instead. They get clean names, subtitles beside them come along, and a file they replace is set aside in .marquee-replaced.
          </>
        }
      />
      {looking && folder ? <Found folder={folder} onBack={() => go(folder)} /> : <Browser at={folder} go={go} />}
    </>
  );
}

function Browser({ at, go }: { at: string | null; go: (p: string | null, look?: boolean) => void }) {
  const q = useQuery({ queryKey: ['import-browse', at], queryFn: () => api<BrowseView>(`/library/import/browse${at ? `?${new URLSearchParams({ path: at })}` : ''}`) });
  const v = q.data;
  return (
    <section aria-label="Pick a folder" className="flex flex-col gap-4">
      <div role="group" aria-label="Start in" className="flex flex-wrap gap-2">
        {(v?.places ?? []).map((p) => (
          <button
            key={p.path}
            type="button"
            aria-pressed={!!at && (at === p.path || at.startsWith(`${p.path}/`))}
            onClick={() => go(p.path)}
            className={cx('h-11 rounded-full border px-4 text-sm font-medium', at && (at === p.path || at.startsWith(`${p.path}/`)) ? 'border-amber bg-amber text-amber-ink' : 'border-line bg-panel text-soft hover:text-text')}
          >
            {p.label}
          </button>
        ))}
      </div>
      {q.isError && <Notice tone="error">{errText(q.error, 'Couldn’t open that folder.')}</Notice>}
      {!at && <p className="m-0 text-sm text-muted">Start in your downloads folder, or a library folder for files that are there but not in Marquee yet.</p>}
      {v?.path && (
        <div className="flex flex-col gap-3 rounded-2xl border border-line bg-panel p-4">
          <p className="m-0 font-mono text-sm break-all text-soft">{v.path}</p>
          <div className="flex flex-wrap gap-3">
            <Button type="button" onClick={() => go(v.path, true)}>
              Look in this folder
            </Button>
            {v.parent && (
              <Button type="button" variant="ghost" onClick={() => go(v.parent)}>
                Up one folder
              </Button>
            )}
          </div>
          {v.folders.length > 0 ? (
            <ul aria-label="Folders inside" className="m-0 flex max-h-[50vh] list-none flex-col overflow-y-auto border-t border-line p-0">
              {v.folders.map((f) => (
                <li key={f.path} className="border-b border-line last:border-b-0">
                  <button type="button" onClick={() => go(f.path)} className="flex min-h-12 w-full items-center gap-3 px-1 text-left text-sm text-text hover:text-amber">
                    <span aria-hidden="true" className="text-dim">
                      ▸
                    </span>
                    <span className="min-w-0 flex-1 break-words">{f.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="m-0 text-sm text-dim">No folders inside. Look in this folder to see its videos.</p>
          )}
        </div>
      )}
    </section>
  );
}

function Found({ folder, onBack }: { folder: string; onBack: () => void }) {
  const q = useQuery({ queryKey: ['import-scan', folder], queryFn: () => api<ImportScanView>(`/library/import/scan?${new URLSearchParams({ path: folder })}`), gcTime: 0 });
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [results, setResults] = useState<Record<string, ImportItemResult>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState<ImportFile | null>(null);
  const v = q.data;
  useEffect(() => {
    if (v) setChoices(Object.fromEntries(v.files.map((f) => [f.path, choiceFor(f)])));
  }, [v]);
  const set = (p: string, c: Partial<Choice>) => setChoices((all) => ({ ...all, [p]: { ...all[p]!, ...c } }));

  const ready = (v?.files ?? []).filter((f) => {
    const c = choices[f.path];
    if (!c?.on || !c.tmdbId || results[f.path]?.ok) return false;
    return c.kind === 'movie' || (c.season !== '' && episodeList(c.episodes));
  });

  async function putIn() {
    setBusy(true);
    setError(null);
    try {
      const items = ready.map((f) => {
        const c = choices[f.path]!;
        return { path: f.path, kind: c.kind, tmdbId: c.tmdbId!, ...(c.kind === 'series' ? { season: Number(c.season), episodes: episodeList(c.episodes)! } : {}) };
      });
      const r = await api<{ results: ImportItemResult[] }>('/library/import', { body: { items } });
      setResults((all) => ({ ...all, ...Object.fromEntries(r.results.map((x) => [x.path, x])) }));
      await refreshAfterCare();
    } catch (e) {
      setError(errText(e, 'That didn’t work. Try again.'));
    } finally {
      setBusy(false);
    }
  }

  if (q.isError) return <Notice tone="error">{errText(q.error, 'Couldn’t look in that folder.')}</Notice>;
  if (!v) return <p className="text-muted">Looking for videos and working out what each one is…</p>;
  return (
    <section aria-label="Videos found" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <p className="m-0 min-w-0 flex-1 font-mono text-sm break-all text-soft">{v.folder}</p>
        <Button type="button" variant="ghost" onClick={onBack}>
          Pick another folder
        </Button>
      </div>
      {v.inLibraryFolder && <Notice>This is inside a library folder, so files are moved to their new names (on the same disk), not linked.</Notice>}
      {v.files.length === 0 ? (
        <Notice>No videos here (samples and extras are left out). Pick another folder.</Notice>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {v.files.map((f) => (
            <FileRow key={f.path} f={f} c={choices[f.path]} result={results[f.path]} set={(c) => set(f.path, c)} onPick={() => setPicking(f)} />
          ))}
        </ul>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      {v.files.length > 0 && (
        <div className="sticky bottom-[calc(72px+env(safe-area-inset-bottom))] flex flex-wrap items-center gap-3 rounded-2xl border border-line-strong bg-raised px-4 py-3 shadow-2xl md:bottom-4">
          <span className="min-w-0 flex-1 text-sm text-soft">{ready.length ? `${ready.length} ready to go in` : 'Tick the files to put in, and say what each one is.'}</span>
          <Button type="button" disabled={busy || ready.length === 0} onClick={() => void putIn()}>
            {busy ? 'Putting them in…' : ready.length ? `Put ${ready.length} in your library` : 'Put them in your library'}
          </Button>
        </div>
      )}
      <Sheet open={picking !== null} onClose={() => setPicking(null)} title="What is this?">
        {picking && (
          <TitlePicker
            file={picking}
            kind={choices[picking.path]?.kind ?? 'movie'}
            onPick={(r) => {
              set(picking.path, { tmdbId: r.tmdbId, title: r.title, year: r.year, kind: r.kind, on: true });
              setPicking(null);
            }}
          />
        )}
      </Sheet>
    </section>
  );
}

function FileRow({ f, c, result, set, onPick }: { f: ImportFile; c: Choice | undefined; result?: ImportItemResult; set: (c: Partial<Choice>) => void; onPick: () => void }) {
  if (!c) return null;
  const epsBad = c.kind === 'series' && c.on && c.episodes !== '' && !episodeList(c.episodes);
  return (
    <li className={cx('flex flex-col gap-3 rounded-2xl border bg-panel p-4', result?.ok ? 'border-teal/50' : result ? 'border-warn/60' : 'border-line')}>
      <div className="flex items-start gap-3">
        <input type="checkbox" aria-label={`Put ${f.name} in your library`} className="mt-1 size-5 flex-none accent-amber" disabled={!!f.inLibrary || !!result?.ok} checked={c.on && !result?.ok} onChange={(e) => set({ on: e.target.checked })} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="font-mono text-sm break-all text-text">{f.name}</span>
          <span className="text-xs text-dim">
            {formatBytes(f.sizeBytes)}
            {f.subtitles.length > 0 && ` · ${f.subtitles.length} ${f.subtitles.length === 1 ? 'subtitle comes' : 'subtitles come'} along`}
          </span>
        </div>
      </div>
      {f.inLibrary ? (
        <p className="m-0 text-sm text-muted">
          Already in your library as{' '}
          <Link to={`/${f.inLibrary.kind === 'movie' ? 'movies' : 'shows'}/${f.inLibrary.id}`}>{f.inLibrary.title}</Link>.
        </p>
      ) : result ? (
        <p className={cx('m-0 text-sm', result.ok ? 'text-teal-hi' : 'text-warn')}>
          {result.message} {result.href && <Link to={result.href}>Open it</Link>}
        </p>
      ) : (
        <div className="flex flex-wrap items-end gap-3 pl-8">
          <label className="flex flex-col gap-1 text-xs text-dim">
            It’s a
            <select value={c.kind} onChange={(e) => set({ kind: e.target.value as Choice['kind'], tmdbId: null, title: '', year: null })} className="h-11 rounded-xl border border-line bg-ink px-3 text-sm text-text">
              <option value="movie">Movie</option>
              <option value="series">Show</option>
            </select>
          </label>
          <div className="flex min-w-[200px] flex-1 flex-col gap-1">
            <span className="text-xs text-dim">{c.kind === 'movie' ? 'Movie' : 'Show'}</span>
            <button type="button" onClick={onPick} className="flex min-h-11 items-center justify-between gap-3 rounded-xl border border-line bg-ink px-3 text-left text-sm text-text hover:border-amber">
              <span className={cx('min-w-0 truncate', !c.tmdbId && 'text-warn')}>{c.tmdbId ? `${c.title}${c.year ? ` (${c.year})` : ''}` : 'Marquee couldn’t tell. Pick one'}</span>
              <span className="flex-none text-amber">Change</span>
            </button>
          </div>
          {c.kind === 'series' && (
            <>
              <label className="flex w-20 flex-col gap-1 text-xs text-dim">
                Season
                <input inputMode="numeric" value={c.season} onChange={(e) => set({ season: e.target.value.replace(/\D/g, '') })} className="h-11 rounded-xl border border-line bg-ink px-3 text-sm text-text" />
              </label>
              <label className="flex w-28 flex-col gap-1 text-xs text-dim">
                Episode
                <input value={c.episodes} placeholder="1 or 1-2" onChange={(e) => set({ episodes: e.target.value })} aria-invalid={epsBad} className={cx('h-11 rounded-xl border bg-ink px-3 text-sm text-text', epsBad ? 'border-warn' : 'border-line')} />
              </label>
            </>
          )}
        </div>
      )}
      {epsBad && <p className="m-0 pl-8 text-xs text-warn">Write the episode as a number (3), a range (3-4), or a list (3, 4).</p>}
    </li>
  );
}

function TitlePicker({ file, kind, onPick }: { file: ImportFile; kind: 'movie' | 'series'; onPick: (r: SearchResult) => void }) {
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [k, setK] = useState(kind);
  const guess = file.guess?.title ?? file.name.split('/').at(-1)!.replace(/\.[^.]+$/, '').replace(/[._]+/g, ' ');
  async function search(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const q = String(new FormData(e.currentTarget).get('q') ?? '').trim();
    if (!q) return;
    setError(null);
    try {
      setResults((await api<{ results: SearchResult[] }>(`/library/search?${new URLSearchParams({ q, kind: k })}`)).results);
    } catch (err) {
      setError(errText(err, 'Search didn’t work.'));
    }
  }
  return (
    <div className="flex flex-col gap-4 pt-1 pb-2">
      <p className="m-0 font-mono text-xs break-all text-dim">{file.name}</p>
      <form onSubmit={search} className="flex flex-wrap gap-2">
        <label htmlFor="pick-q" className="sr-only">
          Title
        </label>
        <input id="pick-q" name="q" defaultValue={guess} className="h-11 min-w-[180px] flex-1 rounded-xl border border-line-strong bg-ink px-4 text-body text-text focus:border-amber focus:outline-none" />
        <select aria-label="Movie or show" value={k} onChange={(e) => setK(e.target.value as typeof k)} className="h-11 rounded-xl border border-line bg-ink px-3 text-sm text-text">
          <option value="movie">Movies</option>
          <option value="series">Shows</option>
        </select>
        <Button type="submit">Search TMDB</Button>
      </form>
      {error && <Notice tone="error">{error}</Notice>}
      {results && results.length === 0 && <Notice>Nothing found. Try fewer words, or without the year.</Notice>}
      {results && results.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {results.map((r) => (
            <li key={`${r.kind}${r.tmdbId}`}>
              <button type="button" onClick={() => onPick(r)} className="flex min-h-14 w-full items-center gap-3 rounded-xl border border-line px-3 py-2 text-left hover:border-amber">
                <Poster title={r.title} path={r.posterPath} className="w-10 flex-none" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-medium text-text">{r.title}</span>
                  <span className="text-xs text-dim">
                    {r.year ?? 'Year unknown'} · {r.kind === 'movie' ? 'Movie' : 'Show'}
                    {r.libraryId ? ' · in your library' : ''}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
