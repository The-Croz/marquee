import { useEffect, useState, type FormEvent } from 'react';
import { Link, Navigate, NavLink, Outlet, useLocation, useOutletContext, useSearchParams } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { AuthStatus, MediaLibrariesResult, MediaServerView, Role, ServiceTestResult, ServicesUpdate, ServicesView, SessionUser, UserSummary } from '@marquee/shared';
import { api, ApiFailure, queryClient, refreshAuth } from '../api';
import { plexSignIn } from '../plex';
import { ServerPeople } from '../components/ServerPeople';
import { Button, Card, Field, Notice, cx } from '../components/ui';
import { InfoTip, PageHeader } from '../components/Page';

type Ctx = { status: AuthStatus & { user: SessionUser } };

export type SettingsItem = { to: string; label: string; blurb: string; info?: string };
type SettingsGroup = { title: string; items: SettingsItem[] };

/** Every Settings page, grouped the way people think about them. Admin-only groups are left out for others. */
export function settingsGroups(role: Role): SettingsGroup[] {
  const admin = role === 'admin';
  return [
    {
      title: 'You',
      items: [
        { to: '/settings/account', label: 'Account', blurb: 'Your name, password and ways to sign in' },
        { to: '/settings/discover', label: 'Discover', blurb: 'What Discover shows you' },
        { to: '/settings/notifications', label: 'Notifications', blurb: 'What you hear about, and where' },
      ],
    },
    ...(admin
      ? [
          {
            title: 'Getting things',
            items: [
              {
                to: '/settings/sources',
                label: 'Sources',
                blurb: 'The sites Marquee searches',
                info: 'Sources are the sites Marquee searches for copies of a movie or show. Older apps call them indexers. Marquee searches them itself, or through Prowlarr if you still use it. It only reads from them: nothing is downloaded until you say so.',
              },
              { to: '/settings/downloader', label: 'Downloader', blurb: 'qBittorrent, and where finished files go' },
              {
                to: '/settings/quality',
                label: 'Quality',
                blurb: 'Profiles: what a good copy looks like',
                info: 'A profile is what you want for a title: which qualities, which rules and how many points each is worth, sizes, and when a copy is good enough. Everything can be changed. The built-in profiles start from Dictionarry’s space-saving profiles; TRaSH’s are there too.',
              },
              { to: '/settings/lists', label: 'Lists', blurb: 'Plex watchlists, Trakt, IMDb and Letterboxd lists' },
              { to: '/settings/automation', label: 'Automatic searching', blurb: 'Looking for wanted titles by itself' },
            ],
          },
          {
            title: 'Your servers',
            items: [
              { to: '/settings/services', label: 'Services', blurb: 'TMDB, Plex, Jellyfin and library folders' },
              { to: '/settings/watched-sync', label: 'Watched sync', blurb: 'Keep watched marks the same on Plex and Jellyfin' },
              { to: '/settings/users', label: 'Users', blurb: 'Family, roles and who needs approval' },
            ],
          },
        ]
      : []),
    {
      title: 'Marquee',
      items: [
        ...(admin
          ? [
              {
                to: '/settings/health',
                label: 'Health',
                blurb: 'Connections, free space and background jobs',
                info: 'Everything Marquee depends on in one place, each with what to do when it isn’t working, plus free space on each folder and every job Marquee runs by itself, with Run now.',
              },
              { to: '/settings/backups', label: 'Backups', blurb: 'Nightly backups, download one, or restore' },
              { to: '/settings/logs', label: 'Logs', blurb: 'What Marquee has been doing, for a bug report' },
            ]
          : []),
        { to: '/settings/about', label: 'About', blurb: 'Version and where to get help' },
      ],
    },
  ];
}

export function SettingsLayout({ status }: Ctx) {
  const { pathname } = useLocation();
  const groups = settingsGroups(status.user.role);
  const current = groups.flatMap((g) => g.items).find((i) => pathname === i.to || pathname.startsWith(`${i.to}/`));

  if (!current) {
    return (
      <>
        <PageHeader title="Settings" />
        <div className="flex max-w-[720px] flex-col gap-8">
          {groups.map((g) => (
            <section key={g.title} aria-labelledby={`sg-${g.title}`} className="flex flex-col gap-2">
              <h2 id={`sg-${g.title}`} className="m-0 text-caption font-semibold tracking-widest text-dim uppercase">
                {g.title}
              </h2>
              <ul className="m-0 flex list-none flex-col overflow-hidden rounded-2xl border border-line bg-panel p-0">
                {g.items.map((i) => (
                  <li key={i.to} className="border-line not-last:border-b">
                    <Link to={i.to} className="flex min-h-14 items-center gap-4 px-4 py-3 text-text no-underline hover:bg-raised hover:text-text">
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="text-body font-semibold">{i.label}</span>
                        <span className="text-sm text-muted">{i.blurb}</span>
                      </span>
                      <span aria-hidden="true" className="text-dim">
                        ›
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </>
    );
  }

  return (
    <div className="flex items-start gap-10">
      <nav aria-label="Settings" className="sticky top-6 hidden w-[220px] flex-none flex-col gap-5 lg:flex">
        <Link to="/settings" className="text-title font-semibold tracking-tight text-text no-underline hover:text-text">
          Settings
        </Link>
        {groups.map((g) => (
          <div key={g.title} className="flex flex-col gap-0.5">
            <span className="px-3 pb-1 text-caption font-semibold tracking-widest text-dim uppercase">{g.title}</span>
            {g.items.map((i) => (
              <NavLink
                key={i.to}
                to={i.to}
                className={() =>
                  cx('flex min-h-10 items-center rounded-lg px-3 text-sm no-underline', i === current ? 'bg-raised font-semibold text-text hover:text-text' : 'text-muted hover:bg-panel hover:text-text')
                }
                aria-current={i === current ? 'page' : undefined}
              >
                {i.label}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>
      <div className="flex min-w-0 flex-1 flex-col gap-6">
        <PageHeader title={current.label} docTitle={`${current.label} · Settings`} back={{ to: '/settings', label: 'Settings', wideHidden: true }} info={current.info} />
        <Outlet context={{ status } satisfies Ctx} />
      </div>
    </div>
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
        <div className="text-body font-medium">{name}</div>
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
  { value: 'member', label: 'Member', note: 'Can browse and ask; an admin approves requests' },
  { value: 'kid', label: 'Kid', note: 'Kids-only Discover; an admin approves requests' },
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
              <div className="text-body font-semibold">
                {u.displayName} {u.id === status.user.id && <span className="text-sm font-normal text-dim">(you)</span>}
              </div>
              <div className="text-label text-muted">
                {u.username}
                {u.plexUsername && ` · Plex: ${u.plexUsername}`}
                {u.jellyfinUsername && ` · Jellyfin: ${u.jellyfinUsername}`}
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

      <ServerPeople jellyfinSignIn />

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
            <select id="new-role" name="role" defaultValue="member" className="h-12 rounded-xl border border-line-strong bg-ink px-4 text-body text-text">
              {ROLES.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
            <span className="text-xs text-dim">Members can ask for things and an admin approves them. Kids get a kids-only Discover.</span>
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

// ---------------- Services (admin) ----------------

function ServiceTest({ service, getValues }: { service: 'tmdb' | 'streamingTop' | 'omdb' | 'radarr' | 'sonarr' | 'plex' | 'jellyfin'; getValues: () => { url?: string; apiKey?: string } }) {
  const [result, setResult] = useState<ServiceTestResult | null>(null);
  const [busy, setBusy] = useState(false);
  async function test() {
    setBusy(true);
    setResult(null);
    try {
      const v = getValues();
      setResult(await api<ServiceTestResult>('/settings/services/test', { body: { service, ...(v.url ? { url: v.url } : {}), ...(v.apiKey ? { apiKey: v.apiKey } : {}) } }));
    } catch (e) {
      setResult({ ok: false, message: errMsg(e) });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button type="button" variant="ghost" onClick={test} disabled={busy}>
        {busy ? 'Testing…' : 'Test connection'}
      </Button>
      {result && (
        <span role="status" className={cx('text-sm', result.ok ? 'text-teal-hi' : 'text-warn')}>
          {result.message}
        </span>
      )}
    </div>
  );
}

/** Plex or Jellyfin: address, token or key, test, and which libraries get scanned. */
function MediaServerCard({ kind, s }: { kind: 'plex' | 'jellyfin'; s: MediaServerView }) {
  const name = kind === 'plex' ? 'Plex' : 'Jellyfin';
  const secretName = kind === 'plex' ? 'plexToken' : 'jellyfinApiKey';
  const [libs, setLibs] = useState<MediaLibrariesResult | null>(null);
  const [libError, setLibError] = useState<string | null>(null);
  const val = (id: string) => (document.getElementById(id) as HTMLInputElement | null)?.value.trim() ?? '';
  async function load() {
    setLibError(null);
    try {
      const url = val(`${kind}Url`);
      const secret = val(secretName);
      setLibs(await api<MediaLibrariesResult>('/settings/services/media-libraries', { body: { server: kind, ...(url ? { url } : {}), ...(secret ? { secret } : {}) } }));
    } catch (e) {
      setLibError(errMsg(e));
    }
  }
  useEffect(() => {
    if (s.configured) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.configured]);
  const picker = (which: 'movie' | 'tv') => {
    const field = `${kind}${which === 'movie' ? 'Movie' : 'Tv'}Library`;
    const chosen = which === 'movie' ? s.movieLibrary : s.tvLibrary;
    const auto = libs?.libraries.find((l) => l.id === libs.picked[which]);
    return (
      <div className="flex flex-col gap-1.5">
        <label htmlFor={field} className="text-sm font-medium text-soft">
          {which === 'movie' ? 'Movies library' : 'TV library'}
        </label>
        <select id={field} name={field} defaultValue={chosen ?? ''} className="h-11 rounded-xl border border-line-strong bg-ink px-3 text-sm text-text">
          <option value="">{auto ? `Let Marquee pick (${auto.name})` : 'Let Marquee pick'}</option>
          {libs?.libraries.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name} · {l.locations.join(', ') || 'no folders'}
            </option>
          ))}
        </select>
      </div>
    );
  };
  return (
    <Card className="flex flex-col gap-4">
      <div>
        <h2 className="m-0 text-lg font-semibold">
          {name} <span className="text-sm font-normal text-dim">optional</span>
        </h2>
        <p className="m-0 mt-1 text-sm text-muted">
          New arrivals show up in {name} within seconds.{' '}
          <InfoTip className="-my-3.5 align-middle" label={`About ${name}`}>
            After Marquee puts something in your library, it asks {name} to scan just that folder. If {name} sees your library under different folder names, Marquee works out its own path from the library you pick.
          </InfoTip>
        </p>
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-4">
        <Field label="Address" name={`${kind}Url`} id={`${kind}Url`} defaultValue={s.url ?? ''} placeholder={kind === 'plex' ? 'http://192.168.1.100:32400' : 'http://192.168.1.100:8096'} />
        <Field
          label={kind === 'plex' ? 'Token' : 'API key'}
          name={secretName}
          id={secretName}
          type="password"
          autoComplete="off"
          placeholder={s.configured ? '••••••••••••' : ''}
          hint={
            s.configured
              ? 'Saved. Leave blank to keep it.'
              : kind === 'plex'
                ? 'In Plex Web, open any movie → ⋯ → Get Info → View XML; the address ends in X-Plex-Token=…'
                : 'Jellyfin → Dashboard → API Keys → +'
          }
        />
      </div>
      <ServiceTest service={kind} getValues={() => ({ url: val(`${kind}Url`), apiKey: val(secretName) })} />
      {libs && <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-4">{(['movie', 'tv'] as const).map(picker)}</div>}
      {!libs && (
        <button type="button" onClick={load} className="h-11 self-start text-sm font-medium text-amber">
          Show {name}'s libraries
        </button>
      )}
      {libError && <p className="m-0 text-sm text-warn">{libError}</p>}
    </Card>
  );
}

/** A name pattern with a live example underneath, so you see what files will be called before saving. */
function NamePattern({ kind, saved, fallback }: { kind: 'movie' | 'tv'; saved: string; fallback: string }) {
  const [value, setValue] = useState(saved);
  const [preview, setPreview] = useState<{ example: string | null; problem: string | null } | null>(null);
  useEffect(() => {
    const t = setTimeout(() => {
      api<{ example: string | null; problem: string | null }>('/settings/services/name-example', { body: { kind, pattern: value } }).then(setPreview, () => setPreview(null));
    }, 250);
    return () => clearTimeout(t);
  }, [kind, value]);
  const id = `${kind}Pattern`;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-soft">
        {kind === 'movie' ? 'Movie names' : 'TV names'}
      </label>
      <input
        id={id}
        name={id}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        spellCheck={false}
        aria-describedby={`${id}-preview`}
        className="h-11 rounded-xl border border-line-strong bg-ink px-3.5 font-mono text-label text-text"
      />
      <p id={`${id}-preview`} role="status" className={cx('m-0 font-mono text-caption break-all', preview?.problem ? 'text-warn' : 'text-muted')}>
        {preview?.problem ?? (preview?.example ? `e.g. ${preview.example}` : ' ')}
      </p>
      {value !== fallback && (
        <button type="button" onClick={() => setValue(fallback)} className="h-11 self-start text-sm font-medium text-amber">
          Use the standard pattern
        </button>
      )}
    </div>
  );
}

export function ServicesPage() {
  const { status } = useOutletContext<Ctx>();
  if (status.user.role !== 'admin') return <Navigate to="/settings/account" replace />;
  return <ServicesAdmin />;
}

function ServicesAdmin() {
  const { data } = useQuery({ queryKey: ['services'], queryFn: () => api<ServicesView>('/settings/services') });
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  if (!data) return <p className="text-muted">Loading…</p>;

  const val = (id: string) => (document.getElementById(id) as HTMLInputElement | null)?.value.trim() ?? '';

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    const body: ServicesUpdate = {
      radarrUrl: String(d.get('radarrUrl') ?? ''),
      sonarrUrl: String(d.get('sonarrUrl') ?? ''),
      moviesRoot: String(d.get('moviesRoot') ?? ''),
      tvRoot: String(d.get('tvRoot') ?? ''),
      moviePattern: String(d.get('moviePattern') ?? ''),
      tvPattern: String(d.get('tvPattern') ?? ''),
      plexUrl: String(d.get('plexUrl') ?? ''),
      jellyfinUrl: String(d.get('jellyfinUrl') ?? ''),
    };
    // Library pickers only exist once the libraries are shown.
    for (const k of ['plexMovieLibrary', 'plexTvLibrary', 'jellyfinMovieLibrary', 'jellyfinTvLibrary'] as const) {
      if (d.has(k)) body[k] = String(d.get(k) ?? '');
    }
    // Blank secret fields mean "keep what's saved".
    for (const k of ['tmdbApiKey', 'streamingTopKey', 'omdbKey', 'radarrApiKey', 'sonarrApiKey', 'plexToken', 'jellyfinApiKey'] as const) {
      const v = String(d.get(k) ?? '').trim();
      if (v) body[k] = v;
    }
    setMessage(null);
    try {
      await api('/settings/services', { method: 'PUT', body });
      await queryClient.invalidateQueries({ queryKey: ['services'] });
      await queryClient.invalidateQueries({ queryKey: ['discover'] });
      (e.target as HTMLFormElement).querySelectorAll<HTMLInputElement>('input[type=password]').forEach((i) => (i.value = ''));
      setMessage({ tone: 'success', text: 'Saved.' });
    } catch (err) {
      setMessage({ tone: 'error', text: errMsg(err) });
    }
  }

  async function clearServer(kind: 'plex' | 'jellyfin') {
    await api('/settings/services', { method: 'PUT', body: kind === 'plex' ? { plexUrl: null, plexToken: null } : { jellyfinUrl: null, jellyfinApiKey: null } });
    await queryClient.invalidateQueries({ queryKey: ['services'] });
    setMessage({ tone: 'success', text: `${kind === 'plex' ? 'Plex' : 'Jellyfin'} disconnected.` });
  }

  async function clearTop() {
    await api('/settings/services', { method: 'PUT', body: { streamingTopKey: null } });
    await queryClient.invalidateQueries({ queryKey: ['services'] });
    await queryClient.invalidateQueries({ queryKey: ['discover'] });
    setMessage({ tone: 'success', text: 'Key removed. Discover shows what’s popular on each service instead.' });
  }

  async function clearOmdb() {
    await api('/settings/services', { method: 'PUT', body: { omdbKey: null } });
    await queryClient.invalidateQueries({ queryKey: ['services'] });
    await queryClient.invalidateQueries({ queryKey: ['discover'] });
    setMessage({ tone: 'success', text: 'Key removed. Title pages show TMDB’s score only.' });
  }

  async function clear(field: 'radarr' | 'sonarr') {
    await api('/settings/services', { method: 'PUT', body: { [`${field}Url`]: null, [`${field}ApiKey`]: null } });
    await queryClient.invalidateQueries({ queryKey: ['services'] });
    setMessage({ tone: 'success', text: `${field === 'radarr' ? 'Radarr' : 'Sonarr'} disconnected.` });
  }

  const savedHint = (configured: boolean) => (configured ? 'Saved. Leave blank to keep it.' : undefined);

  return (
    <form onSubmit={save} className="flex max-w-[760px] flex-col gap-6">
      {message && <Notice tone={message.tone}>{message.text}</Notice>}

      <Card className="flex flex-col gap-4">
        <div>
          <h2 className="m-0 text-lg font-semibold">TMDB</h2>
          <p className="m-0 mt-1 text-sm text-muted">
            Posters, descriptions and matching come from The Movie Database. Get a free key at themoviedb.org → Settings → API. The API key or the read access token both work.
          </p>
        </div>
        <Field
          label="API key"
          name="tmdbApiKey"
          id="tmdbApiKey"
          type="password"
          autoComplete="off"
          placeholder={data.tmdb.configured ? '••••••••••••' : ''}
          hint={data.tmdb.fromEnvironment ? 'Using the key from the container settings. Enter one here to override it.' : savedHint(data.tmdb.configured)}
        />
        <ServiceTest service="tmdb" getValues={() => ({ apiKey: val('tmdbApiKey') })} />
      </Card>

      <Card className="flex flex-col gap-4">
        <div>
          <h2 className="m-0 text-lg font-semibold">
            Streaming Top 10s <span className="text-sm font-normal text-dim">optional</span>
          </h2>
          <p className="m-0 mt-1 text-sm text-muted">
            Discover’s Top 10s for Netflix, HBO Max, Disney+, Apple TV, Prime Video, Hulu and Paramount+ come from Streaming Availability. Without a key Discover shows what’s popular on each service instead, without numbers.{' '}
            <InfoTip className="-my-3.5 align-middle" label="About Streaming Top 10s">
              TMDB only knows what’s popular overall, so its “popular on a service” repeats the same big titles everywhere. Streaming Availability has each service’s own list. Get a free key at movieofthenight.com or on RapidAPI (either works). Marquee keeps each list 12 hours, so it uses a few dozen calls a day at most. Peacock doesn’t share a Top 10.
            </InfoTip>
          </p>
        </div>
        <Field label="API key" name="streamingTopKey" id="streamingTopKey" type="password" autoComplete="off" placeholder={data.streamingTop.configured ? '••••••••••••' : ''} hint={savedHint(data.streamingTop.configured)} />
        <div className="flex flex-wrap items-center gap-3">
          <ServiceTest service="streamingTop" getValues={() => ({ apiKey: val('streamingTopKey') })} />
          {data.streamingTop.configured && (
            <button type="button" onClick={clearTop} className="h-11 text-sm font-medium text-warn">
              Remove the key
            </button>
          )}
        </div>
      </Card>

      <Card className="flex flex-col gap-4">
        <div>
          <h2 className="m-0 text-lg font-semibold">
            IMDb and Rotten Tomatoes scores <span className="text-sm font-normal text-dim">optional</span>
          </h2>
          <p className="m-0 mt-1 text-sm text-muted">
            Title pages always show TMDB’s score. With a free OMDb key they also show IMDb, Rotten Tomatoes and Metacritic.{' '}
            <InfoTip className="-my-3.5 align-middle" label="About OMDb">
              Get a free key at omdbapi.com (the free plan allows 1,000 lookups a day). Marquee keeps each title’s scores for 3 days, so a normal day uses far fewer. If OMDb is down or the day’s limit is used up, pages show TMDB’s score and try again later.
            </InfoTip>
          </p>
        </div>
        <Field label="OMDb key" name="omdbKey" id="omdbKey" type="password" autoComplete="off" placeholder={data.omdb.configured ? '••••••••••••' : ''} hint={savedHint(data.omdb.configured)} />
        <div className="flex flex-wrap items-center gap-3">
          <ServiceTest service="omdb" getValues={() => ({ apiKey: val('omdbKey') })} />
          {data.omdb.configured && (
            <button type="button" onClick={clearOmdb} className="h-11 text-sm font-medium text-warn">
              Remove the key
            </button>
          )}
        </div>
      </Card>

      <Card className="flex flex-col gap-4">
        <div>
          <h2 className="m-0 text-lg font-semibold">Library folders</h2>
          <p className="m-0 mt-1 text-sm text-muted">Paths inside the Marquee container. With the Unraid template, /data is your data share.</p>
        </div>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-4">
          <Field label="Movies" name="moviesRoot" defaultValue={data.moviesRoot} required />
          <Field label="TV" name="tvRoot" defaultValue={data.tvRoot} required />
        </div>
        <details className="rounded-xl border border-line px-4 py-3">
          <summary className="cursor-pointer text-sm font-medium text-soft">How Marquee names files · For experts</summary>
          <div className="mt-4 flex flex-col gap-4">
            <p className="m-0 text-sm text-muted">
              Finished downloads are hardlinked into these folders under clean names, so they take no extra space and qBittorrent keeps sharing. A “/” starts a folder. Titles that already have a folder keep it.
              Words in braces are filled in: {'{Title} {Year} {TmdbId} {Quality} {HDR} {Edition} {Group}'}, and for TV {'{Show} {Season:00} {Episode:00} {Episode Title} {TvdbId}'}.
            </p>
            <NamePattern kind="movie" saved={data.naming.movie} fallback={data.naming.defaultMovie} />
            <NamePattern kind="tv" saved={data.naming.tv} fallback={data.naming.defaultTv} />
            <p className="m-0 text-sm text-muted">
              Files already in your library keep their names until you rename them: Library → More → Rename files to Marquee’s names shows every change first, and can be undone.
            </p>
          </div>
        </details>
      </Card>

      {(['plex', 'jellyfin'] as const).map((kind) => (
        <div key={kind} className="flex flex-col gap-2">
          <MediaServerCard kind={kind} s={data[kind]} />
          {data[kind].configured && (
            <Button type="button" variant="ghost" className="h-10 self-start px-3.5 text-sm" onClick={() => clearServer(kind)}>
              Disconnect {kind === 'plex' ? 'Plex' : 'Jellyfin'}
            </Button>
          )}
        </div>
      ))}

      {(['radarr', 'sonarr'] as const).map((kind) => {
        const s = data[kind];
        const name = kind === 'radarr' ? 'Radarr' : 'Sonarr';
        return (
          <Card key={kind} className="flex flex-col gap-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="m-0 text-lg font-semibold">
                  {name} <span className="text-sm font-normal text-dim">optional · read-only</span>
                </h2>
                <p className="m-0 mt-1 text-sm text-muted">
                  While Marquee runs beside {name}, it uses {name}'s records to match your {kind === 'radarr' ? 'movies' : 'shows'} exactly. Marquee never changes anything in {name}.
                </p>
              </div>
              {s.configured && (
                <Button type="button" variant="ghost" className="h-10 px-3.5 text-sm" onClick={() => clear(kind)}>
                  Disconnect
                </Button>
              )}
            </div>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-4">
              <Field label="Address" name={`${kind}Url`} id={`${kind}Url`} defaultValue={s.url ?? ''} placeholder={kind === 'radarr' ? 'http://192.168.1.100:7878' : 'http://192.168.1.100:8989'} />
              <Field
                label="API key"
                name={`${kind}ApiKey`}
                id={`${kind}ApiKey`}
                type="password"
                autoComplete="off"
                placeholder={s.configured ? '••••••••••••' : ''}
                hint={savedHint(s.configured) ?? `${name} → Settings → General → API Key`}
              />
            </div>
            <ServiceTest service={kind} getValues={() => ({ url: val(`${kind}Url`), apiKey: val(`${kind}ApiKey`) })} />
          </Card>
        );
      })}

      <div>
        <Button type="submit">Save</Button>
      </div>
    </form>
  );
}

// ---------------- About ----------------

export function AboutPage() {
  const { status } = useOutletContext<Ctx>();
  return (
    <Card className="flex max-w-[640px] flex-col gap-4">
      <div>
        <h2 className="m-0 text-lg font-semibold">About Marquee</h2>
        <p className="m-0 text-sm text-muted">Movies and shows for your household, from one app.</p>
      </div>
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-body">
        <dt className="text-dim">Version</dt>
        <dd className="m-0 font-mono text-soft">{status.version}</dd>
        <dt className="text-dim">License</dt>
        <dd className="m-0 text-soft">GPL-3.0-or-later</dd>
        <dt className="text-dim">Source</dt>
        <dd className="m-0">
          <a href="https://github.com/The-Croz/marquee" target="_blank" rel="noreferrer">
            github.com/The-Croz/marquee
          </a>
        </dd>
      </dl>
      <p className="m-0 text-sm text-muted">
        Movie and show information and artwork come from TMDB. Where to watch comes from JustWatch, through TMDB. Marquee isn’t endorsed or certified by TMDB.
      </p>
    </Card>
  );
}
