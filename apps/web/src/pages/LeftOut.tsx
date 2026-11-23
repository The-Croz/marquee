import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { LeftOutItem } from '@marquee/shared';
import { api, ApiFailure, queryClient } from '../api';
import { EmptyState, PageHeader } from '../components/Page';
import { useToast } from '../components/Overlay';
import { Button, Notice } from '../components/ui';

/** Titles removed with "Don't add it back when scanning", with Let it back in. */
export function LeftOutPage() {
  const q = useQuery({ queryKey: ['left-out'], queryFn: () => api<{ items: LeftOutItem[] }>('/library/left-out') });
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const items = q.data?.items ?? [];
  async function letIn(i: LeftOutItem) {
    setError(null);
    try {
      const r = await api<{ message: string }>(`/library/left-out/${i.id}`, { method: 'DELETE' });
      await queryClient.invalidateQueries({ queryKey: ['left-out'] });
      toast({ message: `${i.title}: ${r.message}` });
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : 'That didn’t work. Try again.');
    }
  }
  return (
    <>
      <PageHeader
        title="Left out of scans"
        back={{ to: '/library', label: 'Library' }}
        meta={q.data && `${items.length} ${items.length === 1 ? 'title' : 'titles'}`}
        info="When you remove a title with “Don’t add it back when scanning”, library scans skip its folder (and the title, even in a renamed folder). Let it back in, and the next scan adds it again. Adding it yourself, or a request for it, lets it back in too."
      />
      {error && <Notice tone="error">{error}</Notice>}
      {q.isError && <Notice tone="error">Couldn’t load the list.</Notice>}
      {q.data && items.length === 0 && <EmptyState title="Nothing is left out">Titles you remove with “Don’t add it back when scanning” show up here.</EmptyState>}
      {items.length > 0 && (
        <ul className="m-0 flex max-w-[860px] list-none flex-col p-0">
          {items.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line py-3 last:border-b-0">
              <span className="flex min-w-[220px] flex-1 flex-col">
                <span className="font-medium">
                  {i.title}
                  {i.year ? ` (${i.year})` : ''} <span className="text-sm text-dim">· {i.kind === 'movie' ? 'Movie' : 'Show'}</span>
                </span>
                {i.path && <span className="font-mono text-xs break-all text-dim">{i.path}</span>}
                <span className="text-xs text-dim">
                  Left out {new Date(i.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                  {i.who ? ` by ${i.who}` : ''}
                </span>
              </span>
              <Button type="button" variant="ghost" onClick={() => void letIn(i)}>
                Let it back in
              </Button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
