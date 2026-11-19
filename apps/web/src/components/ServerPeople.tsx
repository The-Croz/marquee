import { useState } from 'react';
import type { Role, ServerPerson } from '@marquee/shared';
import { api, ApiFailure, queryClient } from '../api';
import { Button, Card, Notice } from './ui';

type Kind = 'plex' | 'jellyfin';
const NAME: Record<Kind, string> = { plex: 'Plex', jellyfin: 'Jellyfin' };

/** Settings → Users: pick people from Plex's or Jellyfin's own list and give them a Marquee account. */
export function ServerPeople({ jellyfinSignIn }: { jellyfinSignIn: boolean }) {
  const [kind, setKind] = useState<Kind | null>(null);
  const [people, setPeople] = useState<ServerPerson[]>([]);
  const [picked, setPicked] = useState<Record<string, Role>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  async function load(k: Kind) {
    setBusy(true);
    setMessage(null);
    setKind(k);
    setPicked({});
    try {
      const res = await api<{ people: ServerPerson[] }>(`/users/server-people?server=${k}`);
      setPeople(res.people);
    } catch (e) {
      setPeople([]);
      setKind(null);
      setMessage({ tone: 'error', text: e instanceof ApiFailure ? e.message : `Couldn't reach ${NAME[k]}.` });
    } finally {
      setBusy(false);
    }
  }

  async function add() {
    if (!kind) return;
    setBusy(true);
    try {
      const res = await api<{ users: unknown[] }>('/users/from-server', { body: { server: kind, people: Object.entries(picked).map(([id, role]) => ({ id, role })) } });
      setMessage({ tone: 'success', text: `${res.users.length} ${res.users.length === 1 ? 'person' : 'people'} added. ${kind === 'jellyfin' ? 'They can sign in with their Jellyfin password.' : 'They can sign in with Plex.'}` });
      setKind(null);
      setPeople([]);
      queryClient.invalidateQueries({ queryKey: ['users'] });
    } catch (e) {
      setMessage({ tone: 'error', text: e instanceof ApiFailure ? e.message : "Couldn't add them." });
    } finally {
      setBusy(false);
    }
  }

  const count = Object.keys(picked).length;

  return (
    <Card className="flex flex-col gap-4">
      <h2 className="m-0 text-lg font-semibold">Add people from Plex or Jellyfin</h2>
      <p className="m-0 text-sm text-muted">
        Pick from the list your server already has. They don't need a new password: they sign in with {jellyfinSignIn ? 'their Plex or Jellyfin account' : 'Plex'}. Connect each server under Settings → Services first.
      </p>
      {message && <Notice tone={message.tone}>{message.text}</Notice>}
      <div className="flex flex-wrap gap-3">
        {(['plex', 'jellyfin'] as const).map((k) => (
          <Button key={k} variant="ghost" disabled={busy} onClick={() => load(k)}>
            Pick from {NAME[k]}
          </Button>
        ))}
      </div>

      {kind && !busy && (
        <div className="flex flex-col">
          <h3 className="m-0 mb-2 text-sm font-semibold text-soft">People on {NAME[kind]}</h3>
          {people.length === 0 && <p className="m-0 text-sm text-muted">{NAME[kind]} didn't list anyone.</p>}
          {people.map((p) => (
            <div key={p.id} className="flex min-h-11 flex-wrap items-center gap-3 border-t border-line py-2">
              <input
                type="checkbox"
                id={`pp-${p.id}`}
                className="size-5"
                disabled={p.marqueeUser !== null}
                checked={p.id in picked}
                onChange={(e) =>
                  setPicked((cur) => {
                    const next = { ...cur };
                    if (e.target.checked) next[p.id] = 'member';
                    else delete next[p.id];
                    return next;
                  })
                }
              />
              <label htmlFor={`pp-${p.id}`} className="min-w-[160px] flex-1 text-[15px]">
                {p.name}
                <span className="text-[13px] text-muted">
                  {p.username !== p.name && ` · ${p.username}`}
                  {p.marqueeUser && ` · already in Marquee as ${p.marqueeUser}`}
                </span>
              </label>
              {p.id in picked && (
                <>
                  <label className="sr-only" htmlFor={`pr-${p.id}`}>
                    Role for {p.name}
                  </label>
                  <select
                    id={`pr-${p.id}`}
                    value={picked[p.id]}
                    onChange={(e) => setPicked((cur) => ({ ...cur, [p.id]: e.target.value as Role }))}
                    className="h-10 rounded-lg border border-line-strong bg-ink px-3 text-sm text-text"
                  >
                    <option value="member">Member</option>
                    <option value="kid">Kid</option>
                    <option value="admin">Admin</option>
                  </select>
                </>
              )}
            </div>
          ))}
          <div className="pt-3">
            <Button disabled={count === 0 || busy} onClick={add}>
              Add {count || ''} selected
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
