import { useState, type FormEvent } from 'react';
import { Navigate, NavLink, Outlet, useOutletContext, useSearchParams } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { AuthStatus, Role, SessionUser, UserSummary } from '@marquee/shared';
import { api, ApiFailure, queryClient, refreshAuth } from '../api';
import { plexSignIn } from '../plex';
import { Button, Card, Field, Notice, cx } from '../components/ui';

type Ctx = { status: AuthStatus & { user: SessionUser } };

export function SettingsLayout({ status }: Ctx) {
  const tabs = [{ to: '/settings/account', label: 'Account' }, ...(status.user.role === 'admin' ? [{ to: '/settings/users', label: 'Users' }] : [])];
  return (
    <>
      <h1 className="m-0 font-display text-[56px] leading-none font-normal">Settings</h1>
      <nav aria-label="Settings" className="flex gap-2">
        {tabs.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            className={({ isActive }) =>
              cx('rounded-full border px-4 py-2 text-sm font-medium no-underline', isActive ? 'border-amber bg-amber text-amber-ink hover:text-amber-ink' : 'border-line bg-panel text-soft hover:text-text')
            }
          >
            {t.label}
          </NavLink>
        ))}
      </nav>
      <Outlet context={{ status } satisfies Ctx} />
    </>
  );
}

const errMsg = (e: unknown) => (e instanceof ApiFailure ? e.message : 'Something went wrong.');

// ---------------- Account ----------------

export function AccountPage() {
  const { status } = useOutletContext<Ctx>();
  const user = status.user;
  const [params] = useSearchParams();
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(
    params.get('linked') === 'oidc'
      ? { tone: 'success', text: `${status.providers.oidc.name} is linked. You can sign in with it now.` }
      : params.get('error') === 'oidc_in_use'
        ? { tone: 'error', text: 'That account is already linked to another Marquee user.' }
        : params.get('error') === 'oidc_unreachable'
          ? { tone: 'error', text: `Marquee couldn't reach ${status.providers.oidc.name}. Check that it's running and reachable from the Marquee container.` }
        : params.get('error')
          ? { tone: 'error', text: "Linking didn't complete. Please try again." }
          : null,
  );

  async function run(fn: () => Promise<unknown>, ok: string) {
    setMessage(null);
    try {
      await fn();
      await refreshAuth();
      setMessage({ tone: 'success', text: ok });
    } catch (e) {
      setMessage({ tone: 'error', text: errMsg(e) });
    }
  }

  async function onProfile(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const displayName = new FormData(e.currentTarget).get('displayName');
    await run(() => api('/me', { method: 'PATCH', body: { displayName } }), 'Name saved.');
  }

  async function onPassword(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    await run(async () => {
      await api('/me/password', { body: { current: data.get('current') || undefined, next: data.get('next') } });
      form.reset();
    }, 'Password updated. Other devices were signed out.');
  }

  async function onLinkPlex() {
    setMessage(null);
    try {
      const result = await plexSignIn(true);
      await refreshAuth();
      if (result.status === 'ok') setMessage({ tone: 'success', text: 'Plex is linked. You can sign in with it now.' });
      else if (result.status === 'denied') setMessage({ tone: 'error', text: result.message });
      else setMessage({ tone: 'error', text: 'Plex linking timed out.' });
    } catch (e) {
      setMessage({ tone: 'error', text: errMsg(e) });
    }
  }

  return (
    <div className="flex max-w-[720px] flex-col gap-6">
      {message && <Notice tone={message.tone}>{message.text}</Notice>}

      <Card className="flex flex-col gap-4">
        <h2 className="m-0 text-lg font-semibold">Profile</h2>
        <form onSubmit={onProfile} className="flex flex-wrap items-end gap-3">
          <div className="flex-[1_1_260px]">
            <Field label="Display name" name="displayName" defaultValue={user.displayName} required />
          </div>
          <Button type="submit">Save</Button>
        </form>
        <p className="m-0 text-sm text-dim">
          Username <span className="font-mono text-soft">{user.username}</span> · role <span className="text-soft capitalize">{user.role}</span>
        </p>
      </Card>

      <Card className="flex flex-col gap-4">
        <h2 className="m-0 text-lg font-semibold">{user.linked.password ? 'Change password' : 'Set a password'}</h2>
        <form onSubmit={onPassword} className="flex flex-col gap-4">
          {user.linked.password && <Field label="Current password" name="current" type="password" autoComplete="current-password" required />}
          <Field label="New password" name="next" type="password" autoComplete="new-password" minLength={10} hint="At least 10 characters." required />
          <div>
            <Button type="submit">{user.linked.password ? 'Update password' : 'Set password'}</Button>
          </div>
        </form>
      </Card>

      <Card className="flex flex-col gap-1">
        <h2 className="m-0 mb-3 text-lg font-semibold">Other ways to sign in</h2>
        {status.providers.plex.enabled && (
          <LinkRow
            name="Plex"
            linked={user.linked.plex}
            onLink={onLinkPlex}
            onUnlink={() => run(() => api('/me/links/plex', { method: 'DELETE' }), 'Plex unlinked.')}
          />
        )}
        {status.providers.oidc.enabled && (
          <LinkRow
            name={status.providers.oidc.name}
            linked={user.linked.oidc}
            onLink={() => window.location.assign('/api/auth/oidc/start?link=1')}
            onUnlink={() => run(() => api('/me/links/oidc', { method: 'DELETE' }), `${status.providers.oidc.name} unlinked.`)}
          />
        )}
        {!status.providers.plex.enabled && !status.providers.oidc.enabled && (
          <p className="m-0 text-sm text-muted">Plex and single sign-on are turned off. An admin can turn them on with environment variables (see the README).</p>
        )}
      </Card>
    </div>
  );
}

function LinkRow({ name, linked, onLink, onUnlink }: { name: string; linked: boolean; onLink: () => void; onUnlink: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-4 border-t border-line py-3.5">
      <div className="flex-1">
        <div className="text-[15px] font-medium">{name}</div>
        <div className={cx('text-sm', linked ? 'text-teal-hi' : 'text-dim')}>{linked ? 'Linked' : 'Not linked'}</div>
      </div>
      {linked ? (
        <Button variant="ghost" onClick={onUnlink}>
          Unlink
        </Button>
      ) : (
        <Button variant="ghost" onClick={onLink}>
          Link {name}
        </Button>
      )}
    </div>
  );
}

// ---------------- Users (admin) ----------------

const ROLES: { value: Role; label: string; note: string }[] = [
  { value: 'admin', label: 'Admin', note: 'Everything, including settings and approvals' },
  { value: 'member', label: 'Member', note: 'Requests go through without approval' },
  { value: 'kid', label: 'Kid', note: 'Kids-only Discover; requests need approval' },
];

export function UsersPage() {
  const { status } = useOutletContext<Ctx>();
  if (status.user.role !== 'admin') return <Navigate to="/settings/account" replace />;
  return <UsersAdmin status={status} />;
}

function UsersAdmin({ status }: Ctx) {
  const { data } = useQuery({ queryKey: ['users'], queryFn: () => api<{ users: UserSummary[] }>('/users') });
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const reload = () => queryClient.invalidateQueries({ queryKey: ['users'] });

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => api('/users', { body }),
    onSuccess: () => {
      setMessage({ tone: 'success', text: 'User added.' });
      reload();
    },
    onError: (e) => setMessage({ tone: 'error', text: errMsg(e) }),
  });

  async function update(id: number, body: Record<string, unknown>, ok: string) {
    setMessage(null);
    try {
      await api(`/users/${id}`, { method: 'PATCH', body });
      setMessage({ tone: 'success', text: ok });
      reload();
    } catch (e) {
      setMessage({ tone: 'error', text: errMsg(e) });
    }
  }

  async function remove(u: UserSummary) {
    if (!window.confirm(`Delete ${u.displayName}? This can't be undone.`)) return;
    setMessage(null);
    try {
      await api(`/users/${u.id}`, { method: 'DELETE' });
      setMessage({ tone: 'success', text: `${u.displayName} was deleted.` });
      reload();
    } catch (e) {
      setMessage({ tone: 'error', text: errMsg(e) });
    }
  }

  function onCreate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const d = new FormData(form);
    create.mutate(
      { displayName: d.get('displayName'), username: d.get('username'), role: d.get('role'), password: d.get('password') || undefined },
      { onSuccess: () => form.reset() },
    );
  }

  return (
    <div className="flex max-w-[960px] flex-col gap-6">
      {message && <Notice tone={message.tone}>{message.text}</Notice>}

      <Card className="flex flex-col gap-1">
        <h2 className="m-0 mb-3 text-lg font-semibold">People</h2>
        {data?.users.map((u) => (
          <div key={u.id} className="flex flex-wrap items-center gap-4 border-t border-line py-4">
            <span className="flex size-10 flex-none items-center justify-center rounded-full bg-raised font-semibold" aria-hidden="true">
              {u.displayName.slice(0, 1).toUpperCase()}
            </span>
            <div className="min-w-[180px] flex-1">
              <div className="text-[15px] font-semibold">
                {u.displayName} {u.id === status.user.id && <span className="text-sm font-normal text-dim">(you)</span>}
              </div>
              <div className="text-[13px] text-muted">
                {u.username}
                {u.plexUsername && ` · Plex: ${u.plexUsername}`}
                {u.linked.oidc && ` · ${status.providers.oidc.name || 'SSO'}`}
                {!u.linked.password && ' · no password'}
              </div>
            </div>
            <label className="sr-only" htmlFor={`role-${u.id}`}>
              Role for {u.displayName}
            </label>
            <select
              id={`role-${u.id}`}
              value={u.role}
              onChange={(e) => update(u.id, { role: e.target.value }, `${u.displayName} is now ${e.target.value}.`)}
              className="h-10 rounded-lg border border-line-strong bg-ink px-3 text-sm text-text"
            >
              {ROLES.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
            <Button
              variant="ghost"
              className="h-10 px-3.5 text-sm"
              onClick={() => {
                const pw = window.prompt(`New password for ${u.displayName} (at least 10 characters):`);
                if (pw) update(u.id, { password: pw }, `Password reset for ${u.displayName}.`);
              }}
            >
              Reset password
            </Button>
            {u.id !== status.user.id && (
              <Button variant="danger" className="h-10 px-3.5 text-sm" onClick={() => remove(u)}>
                Delete
              </Button>
            )}
          </div>
        ))}
      </Card>

      <Card className="flex flex-col gap-4">
        <h2 className="m-0 text-lg font-semibold">Add someone</h2>
        <p className="m-0 text-sm text-muted">
          Give them a password, or leave it blank and have them link Plex or {status.providers.oidc.name || 'single sign-on'} instead.
        </p>
        <form onSubmit={onCreate} className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-4">
          <Field label="Name" name="displayName" required />
          <Field label="Username" name="username" autoCapitalize="none" required />
          <Field label="Password (optional)" name="password" type="password" autoComplete="new-password" minLength={10} />
          <div className="flex flex-col gap-2">
            <label htmlFor="new-role" className="text-sm font-medium text-soft">
              Role
            </label>
            <select id="new-role" name="role" defaultValue="member" className="h-12 rounded-xl border border-line-strong bg-ink px-4 text-[15px] text-text">
              {ROLES.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
            <span className="text-xs text-dim">Members' requests go straight through. Kids get a kids-only Discover and need approval.</span>
          </div>
          <div>
            <Button type="submit" disabled={create.isPending}>
              Add user
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
