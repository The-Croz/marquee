import { useEffect, useId, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import type { LibraryCard, SessionUser } from '@marquee/shared';
import { api } from '../api';
import { Sheet } from './Overlay';
import { cx } from './ui';

/** A place the bar can take you. */
export interface Destination {
  to: string;
  label: string;
  /** Shown on the right, e.g. "Settings". */
  group: string;
  /** Extra words that should find it ("indexers" finds Sources). */
  keywords?: string;
}

interface Row extends Destination {
  key: string;
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const commandKeyHint = isMac ? '⌘K' : 'Ctrl K';

/**
 * ⌘K (Ctrl K elsewhere): jump to any page or Setting, any title in the
 * library, or look for something new to add. Opens on the shortcut or when
 * `open` is set by a button.
 */
export function CommandBar({ user, destinations, open, onOpenChange }: { user: SessionUser; destinations: Destination[]; open: boolean; onOpenChange: (o: boolean) => void }) {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [at, setAt] = useState(0);
  const listId = useId();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        onOpenChange(!open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onOpenChange]);

  useEffect(() => {
    if (!open) setQ('');
  }, [open]);

  const term = q.trim();
  const titles = useQuery({
    queryKey: ['command', term],
    enabled: open && term.length >= 2,
    staleTime: 30_000,
    queryFn: async () => {
      const params = new URLSearchParams({ q: term, sort: 'title' });
      const [movies, shows] = await Promise.all([api<{ items: LibraryCard[] }>(`/movies?${params}`), api<{ items: LibraryCard[] }>(`/shows?${params}`)]);
      return [
        ...movies.items.slice(0, 5).map((m) => ({ key: `m${m.id}`, to: `/movies/${m.id}`, label: m.year ? `${m.title} (${m.year})` : m.title, group: 'Movie' })),
        ...shows.items.slice(0, 5).map((s) => ({ key: `s${s.id}`, to: `/shows/${s.id}`, label: s.year ? `${s.title} (${s.year})` : s.title, group: 'Show' })),
      ];
    },
  });

  const rows: Row[] = useMemo(() => {
    const needle = term.toLowerCase();
    const pages = destinations
      .filter((d) => !needle || `${d.label} ${d.group} ${d.keywords ?? ''}`.toLowerCase().includes(needle))
      .map((d) => ({ ...d, key: `p${d.to}` }));
    const found = term.length >= 2 ? (titles.data ?? []) : [];
    const add = term && user.role !== 'kid' ? [{ key: 'search', to: `/search?${new URLSearchParams({ q: term })}`, label: `Look for “${term}” to add`, group: 'Search' }] : [];
    return [...found, ...pages.slice(0, 8), ...add];
  }, [destinations, term, titles.data, user.role]);

  useEffect(() => setAt(0), [term]);

  function go(r: Row | undefined) {
    if (!r) return;
    onOpenChange(false);
    navigate(r.to);
  }

  return (
    <Sheet open={open} onClose={() => onOpenChange(false)} title="Go to" hideTitle className="sm:mt-[12vh] sm:mb-auto">
      <div className="flex flex-col gap-2 pt-1">
        <input
          autoFocus
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={rows[at] ? `${listId}-${at}` : undefined}
          aria-label="Go to a page, a title or a setting"
          placeholder="Go to a page, a title or a setting"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') setAt((i) => Math.min(i + 1, rows.length - 1));
            else if (e.key === 'ArrowUp') setAt((i) => Math.max(i - 1, 0));
            else if (e.key === 'Enter') go(rows[at]);
            else return;
            e.preventDefault();
          }}
          className="h-12 w-full rounded-xl border border-line bg-ink px-4 text-body text-text placeholder:text-dim focus:border-amber focus:outline-none"
        />
        <ul id={listId} role="listbox" aria-label="Results" className="m-0 flex list-none flex-col p-0 pb-1">
          {rows.map((r, i) => (
            <li
              key={r.key}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === at}
              onMouseMove={() => setAt(i)}
              onClick={() => go(r)}
              className={cx('flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-3 text-sm', i === at ? 'bg-raised text-text' : 'text-soft')}
            >
              <span className="min-w-0 flex-1 truncate">{r.label}</span>
              <span className="text-caption text-dim">{r.group}</span>
            </li>
          ))}
          {term.length >= 2 && titles.isFetching && <li className="px-3 py-2 text-sm text-dim">Looking in your library…</li>}
          {!rows.length && !titles.isFetching && <li className="px-3 py-2 text-sm text-muted">Nothing matches that.</li>}
        </ul>
      </div>
    </Sheet>
  );
}
