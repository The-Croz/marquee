import { useState } from 'react';
import type { Role, ServerPerson } from '@marquee/shared';
import { api, ApiFailure, queryClient } from '../api';
import { Button, Card, Notice } from './ui';

type Kind = 'plex' | 'jellyfin';
type Account = { id: number; username: string; displayName: string };
const NAME: Record<Kind, string> = { plex: 'Plex', jellyfin: 'Jellyfin' };

/** Settings → Users: pick people from Plex's or Jellyfin's own list and give them a Marquee account. */
export function ServerPeople({ jellyfinSignIn }: { jellyfinSignIn: boolean }) {
  const [kind, setKind] = useState<Kind | null>(null);
  const [people, setPeople] = useState<ServerPerson[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  /** For each ticked person: a new account with this role, or "link:<id>" to link one that's already here. */
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  async function load(k: Kind) {
    setBusy(true);
    setMessage(null);
    setKind(k);
    setPicked({});
    try {
      const res = await api<{ people: ServerPerson[]; accounts: Account[] }>(`/users/server-people?server=${k}`);
      setPeople(res.people);
      setAccounts(res.accounts);
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
      const body = Object.entries(picked).map(([id, choice]) => (choice.startsWith('link:') ? { id, linkTo: Number(choice.slice(5)) } : { id, role: choice as Role }));
      const res = await api<{ users: unknown[]; linked: unknown[] }>('/users/from-server', { body: { server: kind, people: body } });
      const n = (k: number) => `${k} ${k === 1 ? 'person' : 'people'}`;
      const parts = [res.users.length ? `${n(res.users.length)} added` : '', res.linked.length ? `${n(res.linked.length)} linked to their account` : ''].filter(Boolean).join(', ');
      setMessage({ tone: 'success', text: `${parts}. ${kind === 'jellyfin' ? 'They can sign in with their Jellyfin password.' : 'They can sign in with Plex.'}` });
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
  /** An account can be linked to only one person on this server. */
  const free = (personId: string, accountId: number) => !Object.entries(picked).some(([id, c]) => id !== personId && c === `link:${accountId}`);

  return (
    <Card className="flex flex-col gap-4">
      <h2 className="m-0 text-lg font-semibold">Add or link people from Plex or Jellyfin</h2>
      <p className="m-0 text-sm text-muted">
        Pick from the list your server already has. Give each person a new account, or link them to an account that’s already here (yours too), which keeps its name, role and password. They can then sign in with {jellyfinSignIn ? 'their Plex or Jellyfin account' : 'Plex'}. Connect each server under Settings → Services first.
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
                    if (e.target.checked) next[p.id] = p.suggest !== null && free(p.id, p.suggest) ? `link:${p.suggest}` : 'member';
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
                    What to do for {p.name}
                  </label>
                  <select
                    id={`pr-${p.id}`}
                    value={picked[p.id]}
                    onChange={(e) => setPicked((cur) => ({ ...cur, [p.id]: e.target.value }))}
                    className="h-11 rounded-lg border border-line-strong bg-ink px-3 text-sm text-text"
                  >
                    <optgroup label="New account">
                      <option value="member">New account · Member</option>
                      <option value="kid">New account · Kid</option>
                      <option value="admin">New account · Admin</option>
                    </optgroup>
                    {accounts.length > 0 && (
                      <optgroup label="Link to someone already here">
                        {accounts.map((a) => (
                          <option key={a.id} value={`link:${a.id}`} disabled={!free(p.id, a.id)}>
                            Link to {a.displayName} ({a.username})
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </select>
                </>
              )}
            </div>
          ))}
          <div className="pt-3">
            <Button disabled={count === 0 || busy} onClick={add}>
              {count ? `Add or link ${count}` : 'Add or link selected'}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
