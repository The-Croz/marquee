import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { DiscoverPrefs, NotificationChannelView, NotificationEventInfo } from '@marquee/shared';
import { api, ApiFailure, queryClient } from '../api';
import { Button, Card, Field, Notice, cx } from '../components/ui';
import { useOutletContext } from 'react-router';
import type { AuthStatus, SessionUser } from '@marquee/shared';

const errMsg = (e: unknown) => (e instanceof ApiFailure ? e.message : 'Something went wrong. Try again.');

function Check({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="flex min-h-11 items-start gap-3 py-1.5">
      <input type="checkbox" className="mt-1 size-5 flex-none accent-amber" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="flex flex-col">
        <span className="text-[15px]">{label}</span>
        {hint && <span className="text-sm text-muted">{hint}</span>}
      </span>
    </label>
  );
}

/** Settings → Discover: services you don't want chips for, and trailers. Everyone. */
export function DiscoverSettingsPage() {
  const { data } = useQuery({ queryKey: ['discover', 'prefs'], queryFn: () => api<DiscoverPrefs>('/discover/prefs') });
  const [error, setError] = useState<string | null>(null);
  if (!data) return <p className="text-muted">Loading…</p>;
  async function save(next: DiscoverPrefs) {
    setError(null);
    try {
      await api('/discover/prefs', { method: 'PUT', body: { hiddenServices: next.hiddenServices, trailers: next.trailers } });
      await queryClient.invalidateQueries({ queryKey: ['discover'] });
    } catch (e) {
      setError(errMsg(e));
    }
  }
  return (
    <Card className="flex max-w-[640px] flex-col gap-4">
      <div>
        <h2 className="m-0 text-lg font-semibold">Discover</h2>
        <p className="m-0 text-sm text-muted">This is just for you. Untick a service to take its tab off Discover.</p>
      </div>
      <fieldset className="m-0 flex flex-col border-0 p-0">
        <legend className="sr-only">Streaming services</legend>
        {(data.all ?? []).map((s) => (
          <Check
            key={s.key}
            label={s.name}
            checked={!data.hiddenServices.includes(s.key)}
            onChange={(on) => save({ ...data, hiddenServices: on ? data.hiddenServices.filter((k) => k !== s.key) : [...data.hiddenServices, s.key] })}
          />
        ))}
      </fieldset>
      <Check label="Play trailers when I rest on a cover" hint="Trailers play from YouTube’s privacy-friendly player. Turn this off and none are loaded." checked={data.trailers} onChange={(on) => save({ ...data, trailers: on })} />
      {error && <Notice tone="error">{error}</Notice>}
    </Card>
  );
}

function MyEvents() {
  const { data } = useQuery({ queryKey: ['notifications', 'events'], queryFn: () => api<{ events: NotificationEventInfo[]; muted: string[] }>('/notifications/events') });
  const [error, setError] = useState<string | null>(null);
  if (!data) return null;
  async function set(key: string, on: boolean) {
    setError(null);
    try {
      const muted = on ? data!.muted.filter((k) => k !== key) : [...data!.muted, key];
      await api('/notifications/muted', { method: 'PUT', body: { muted } });
      await queryClient.invalidateQueries({ queryKey: ['notifications'] });
    } catch (e) {
      setError(errMsg(e));
    }
  }
  return (
    <Card className="flex max-w-[640px] flex-col gap-3">
      <div>
        <h2 className="m-0 text-lg font-semibold">What shows up in my bell</h2>
        <p className="m-0 text-sm text-muted">Untick anything you don’t want to hear about.</p>
      </div>
      {data.events.map((e) => (
        <Check key={e.key} label={e.label} hint={e.description} checked={!data.muted.includes(e.key)} onChange={(on) => set(e.key, on)} />
      ))}
      {error && <Notice tone="error">{error}</Notice>}
    </Card>
  );
}

type Kind = 'pushover' | 'ntfy';

function ChannelCard({ ch, events }: { ch: NotificationChannelView; events: NotificationEventInfo[] }) {
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const patch = async (body: object) => {
    setError(null);
    try {
      await api(`/settings/notifications/${ch.id}`, { method: 'PATCH', body });
      await queryClient.invalidateQueries({ queryKey: ['channels'] });
    } catch (e) {
      setError(errMsg(e));
    }
  };
  async function test() {
    setBusy(true);
    setResult(null);
    try {
      setResult(await api<{ ok: boolean; message: string }>(`/settings/notifications/${ch.id}/test`, { body: {} }));
      await queryClient.invalidateQueries({ queryKey: ['channels'] });
    } catch (e) {
      setResult({ ok: false, message: errMsg(e) });
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    await api(`/settings/notifications/${ch.id}`, { method: 'DELETE' });
    await queryClient.invalidateQueries({ queryKey: ['channels'] });
  }
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col">
          <h3 className="m-0 text-[17px] font-semibold">
            {ch.name} <span className="text-sm font-normal text-dim">· {ch.kind === 'pushover' ? 'Pushover' : 'ntfy'}</span>
          </h3>
          <span className="truncate text-sm text-muted">{ch.detail}</span>
        </div>
        <Button type="button" variant="ghost" disabled={busy} onClick={test}>
          {busy ? 'Sending…' : 'Send a test'}
        </Button>
        <Button type="button" variant="ghost" onClick={() => patch({ enabled: !ch.enabled })}>
          {ch.enabled ? 'Pause' : 'Turn on'}
        </Button>
        <Button type="button" variant="danger" onClick={remove}>
          Remove
        </Button>
      </div>
      {!ch.enabled && <Notice>Paused. Nothing is sent here until you turn it on.</Notice>}
      {ch.lastError && <Notice tone="error">{ch.lastError}</Notice>}
      {result && <Notice tone={result.ok ? 'success' : 'error'}>{result.message}</Notice>}
      {!ch.lastError && ch.lastOkAt && <p className="m-0 text-xs text-dim">Last sent {new Date(ch.lastOkAt).toLocaleString()}.</p>}
      <fieldset className="m-0 flex flex-col border-0 p-0">
        <legend className="mb-1 text-sm text-soft">Send here when…</legend>
        {events.map((e) => (
          <Check key={e.key} label={e.label} hint={e.description} checked={ch.events.includes(e.key)} onChange={(on) => patch({ events: on ? [...ch.events, e.key] : ch.events.filter((k) => k !== e.key) })} />
        ))}
      </fieldset>
      {error && <Notice tone="error">{error}</Notice>}
    </Card>
  );
}

function AddChannel() {
  const [kind, setKind] = useState<Kind>('pushover');
  const [f, setF] = useState({ name: '', appToken: '', userKey: '', server: '', topic: '', token: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/settings/notifications', {
        body: kind === 'pushover' ? { kind, name: f.name || 'Pushover', appToken: f.appToken, userKey: f.userKey } : { kind, name: f.name || 'ntfy', server: f.server, topic: f.topic, ...(f.token ? { token: f.token } : {}) },
      });
      setF({ name: '', appToken: '', userKey: '', server: '', topic: '', token: '' });
      await queryClient.invalidateQueries({ queryKey: ['channels'] });
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card className="flex flex-col gap-4">
      <h3 className="m-0 text-[17px] font-semibold">Add a place to send alerts</h3>
      <div role="group" aria-label="Which service" className="flex gap-2">
        {(['pushover', 'ntfy'] as const).map((k) => (
          <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)} className={cx('h-11 rounded-full border px-4 text-sm font-medium', kind === k ? 'border-amber bg-amber text-amber-ink' : 'border-line bg-panel text-soft hover:text-text')}>
            {k === 'pushover' ? 'Pushover' : 'ntfy'}
          </button>
        ))}
      </div>
      <form onSubmit={add} className="flex flex-col gap-4">
        <Field label="Name" value={f.name} onChange={set('name')} placeholder={kind === 'pushover' ? 'My phone' : 'Family topic'} />
        {kind === 'pushover' ? (
          <>
            <Field label="Application token" type="password" autoComplete="off" value={f.appToken} onChange={set('appToken')} hint="From pushover.net: create an application, then copy its API token." required />
            <Field label="Your user key" type="password" autoComplete="off" value={f.userKey} onChange={set('userKey')} hint="Shown on your Pushover home page." required />
          </>
        ) : (
          <>
            <Field label="Server" value={f.server} onChange={set('server')} placeholder="https://ntfy.sh" hint="Leave blank for ntfy.sh, or type the address of your own server." />
            <Field label="Topic" value={f.topic} onChange={set('topic')} hint="Anyone who knows the topic name can read it on ntfy.sh, so make it hard to guess." required />
            <Field label="Access token (if the topic needs one)" type="password" autoComplete="off" value={f.token} onChange={set('token')} />
          </>
        )}
        {error && <Notice tone="error">{error}</Notice>}
        <Button type="submit" className="self-start" disabled={busy}>
          {busy ? 'Adding…' : 'Add'}
        </Button>
      </form>
    </Card>
  );
}

function Channels() {
  const { data } = useQuery({ queryKey: ['channels'], queryFn: () => api<{ items: NotificationChannelView[]; events: NotificationEventInfo[] }>('/settings/notifications') });
  return (
    <section aria-labelledby="channels" className="flex max-w-[720px] flex-col gap-4">
      <div>
        <h2 id="channels" className="m-0 text-lg font-semibold">
          Alerts to your phone
        </h2>
        <p className="m-0 text-sm text-muted">Marquee can send admin alerts through Pushover or ntfy. Everything also shows in the bell.</p>
      </div>
      {data?.items.map((ch) => <ChannelCard key={ch.id} ch={ch} events={data.events} />)}
      {data && data.items.length === 0 && <Notice>Nothing set up yet. Add Pushover or ntfy below.</Notice>}
      <AddChannel />
    </section>
  );
}

export function NotificationSettingsPage() {
  const { status } = useOutletContext<{ status: AuthStatus & { user: SessionUser } }>();
  return (
    <div className="flex flex-col gap-8">
      <MyEvents />
      {status.user.role === 'admin' && <Channels />}
    </div>
  );
}
