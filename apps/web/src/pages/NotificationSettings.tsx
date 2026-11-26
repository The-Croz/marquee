import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Outlet, useOutletContext } from 'react-router';
import type { AuthStatus, DiscoverPrefs, NotificationChannelView, NotificationEventInfo, NotificationGroup, NotificationPreview, NotificationPriority, NotificationTemplateView, NotificationVar, SessionUser } from '@marquee/shared';
import { api, ApiFailure, queryClient } from '../api';
import { Button, Card, Field, Notice, cx } from '../components/ui';
import { Tabs } from '../components/Page';

type Ctx = { status: AuthStatus & { user: SessionUser } };

const errMsg = (e: unknown) => (e instanceof ApiFailure ? e.message : 'Something went wrong. Try again.');

function Check({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="flex min-h-11 items-start gap-3 py-1.5">
      <input type="checkbox" className="mt-1 size-5 flex-none accent-amber" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="flex flex-col">
        <span className="text-body">{label}</span>
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


// ======================================================================
// Settings → Notifications
//   What to send  every place (web UI, phones, added services) and what each gets
//   Customize     what each message says, with its facts filled in (admins)
// ======================================================================

export function NotificationSettingsLayout() {
  const ctx = useOutletContext<Ctx>();
  const admin = ctx.status.user.role === 'admin';
  return (
    <div className="flex flex-col gap-6">
      {admin && (
        <Tabs
          label="Notification settings"
          items={[
            { value: '/settings/notifications', label: 'What to send', to: '/settings/notifications', end: true },
            { value: '/settings/notifications/customize', label: 'Customize', to: '/settings/notifications/customize', end: false },
          ]}
        />
      )}
      <Outlet context={ctx} />
    </div>
  );
}

const GROUPS: NotificationGroup[] = ['Requests', 'Downloads', 'Problems', 'Watching', 'Marquee'];
const GROUP_HINT: Record<NotificationGroup, string> = {
  Requests: 'Asking for things, and hearing back',
  Downloads: 'Copies arriving in the library',
  Problems: 'Something stopped working',
  Watching: 'Who is watching what. Chatty, so off until you turn them on',
  Marquee: 'Marquee itself',
};

async function run(setError: (s: string | null) => void, f: () => Promise<unknown>) {
  setError(null);
  try {
    await f();
  } catch (e) {
    setError(errMsg(e));
  }
}

// ---------------- The grid of switches ----------------

/** One column of switches: the web UI, or one place messages are pushed to. */
interface Column {
  id: string;
  label: string;
  detail?: string;
  paused?: boolean;
  /** Whether this place can get the message at all (all of them, when left out). */
  can?: (event: string) => boolean;
  on: (event: string) => boolean;
  set: (events: string[], on: boolean) => Promise<void>;
}

function Box({ checked, mixed, onChange, label, disabled }: { checked: boolean; mixed?: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!mixed;
  }, [mixed]);
  return (
    <label className="flex size-11 cursor-pointer items-center justify-center rounded-lg hover:bg-raised">
      <input ref={ref} type="checkbox" className="size-5 accent-amber" checked={checked} disabled={disabled} aria-label={label} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

function Unavailable({ label }: { label: string }) {
  return (
    <span className="relative flex size-11 items-center justify-center text-dim">
      <span aria-hidden="true">—</span>
      <span className="sr-only">{label}: not sent here, because it is about one person</span>
    </span>
  );
}

/**
 * Every message down the side, every place it can go across the top. Each
 * group has a switch for all of it at once.
 */
function EventGrid({ events, columns, caption }: { events: NotificationEventInfo[]; columns: Column[]; caption: string }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const flip = (col: Column, keys: string[], on: boolean) => {
    setBusy(true);
    void run(setError, () => col.set(keys, on)).finally(() => setBusy(false));
  };
  return (
    <div className="flex flex-col gap-3">
      <div className="relative overflow-x-auto rounded-2xl border border-line bg-panel">
        <table className="w-full border-collapse text-left">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="border-b border-line">
              <th scope="col" className="sticky left-0 z-10 bg-panel px-4 py-3 text-sm font-medium text-soft">
                Message
              </th>
              {columns.map((c) => (
                <th key={c.id} scope="col" className="min-w-[88px] px-2 py-3 text-center align-bottom text-sm font-medium">
                  <span className="block">{c.label}</span>
                  {c.detail && <span className="block text-xs font-normal text-dim">{c.detail}</span>}
                  {c.paused && <span className="block text-xs font-normal text-warn">Paused</span>}
                </th>
              ))}
            </tr>
          </thead>
          {GROUPS.map((g) => {
            const list = events.filter((e) => e.group === g);
            if (!list.length) return null;
            const keys = list.map((e) => e.key);
            return (
              <tbody key={g} className="border-b border-line last:border-0">
                <tr className="bg-raised/50">
                  <th scope="rowgroup" className="sticky left-0 z-10 bg-raised px-4 py-2 max-sm:max-w-[170px]">
                    <span className="block text-body font-semibold">{g}</span>
                    <span className="block text-xs font-normal text-dim max-sm:hidden">{GROUP_HINT[g]}</span>
                  </th>
                  {columns.map((c) => {
                    const mine = keys.filter((k) => c.can?.(k) ?? true);
                    const n = mine.filter(c.on).length;
                    const label = `All ${g} messages: ${c.label}`;
                    return (
                      <td key={c.id} className="px-2 py-1">
                        <div className="flex justify-center">
                          {mine.length === 0 ? <Unavailable label={label} /> : <Box label={label} checked={n === mine.length} mixed={n > 0 && n < mine.length} disabled={busy} onChange={(on) => flip(c, mine, on)} />}
                        </div>
                      </td>
                    );
                  })}
                </tr>
                {list.map((e) => (
                  <tr key={e.key} className="border-t border-line/60">
                    <th scope="row" className="sticky left-0 z-10 max-w-[340px] bg-panel px-4 py-2 font-normal max-sm:max-w-[170px] max-sm:min-w-[140px]">
                      <span className="block text-body">{e.label}</span>
                      <span className="block text-xs text-dim max-sm:hidden">{e.description}</span>
                    </th>
                    {columns.map((c) => (
                      <td key={c.id} className="px-2 py-1">
                        <div className="flex justify-center">
                          {(c.can?.(e.key) ?? true) ? <Box label={`${e.label}: ${c.label}`} checked={c.on(e.key)} disabled={busy} onChange={(on) => flip(c, [e.key], on)} /> : <Unavailable label={`${e.label}: ${c.label}`} />}
                        </div>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            );
          })}
        </table>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
    </div>
  );
}

const MINE = '/notifications/channels';
const SHARED = '/settings/notifications';

type Kind = NotificationChannelView['kind'];
const KIND_NAME: Record<Kind, string> = { pushover: 'Pushover', ntfy: 'ntfy', webhook: 'Webhook', apns: 'iPhone app' };

/** Where a place's own routes are: shared ones are the admins', the rest are yours. */
const baseOf = (ch: NotificationChannelView) => (ch.shared ? SHARED : MINE);
const refreshChannels = () => queryClient.invalidateQueries({ queryKey: ['channels'] });

// ---------------- Places ----------------

function ChannelRow({ ch, admin }: { ch: NotificationChannelView; admin: boolean }) {
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const url = `${baseOf(ch)}/${ch.id}`;
  /** A phone is switched on and off in the app, which would only add it again if it were removed here. */
  const phone = ch.kind === 'apns';
  const change = (f: () => Promise<unknown>) => run(setError, async () => (await f(), await refreshChannels()));
  async function test() {
    setBusy(true);
    setResult(null);
    try {
      setResult(await api<{ ok: boolean; message: string }>(`${url}/test`, { body: {} }));
      await refreshChannels();
    } catch (e) {
      setResult({ ok: false, message: errMsg(e) });
    } finally {
      setBusy(false);
    }
  }
  const sent = !ch.lastError && ch.lastOkAt ? `last sent ${new Date(ch.lastOkAt).toLocaleString()}` : '';
  // Only ntfy and webhooks have an address worth showing; the others would just repeat their kind.
  const facts = [ch.kind === 'ntfy' || ch.kind === 'webhook' ? ch.detail : '', sent].filter(Boolean).join(' · ');
  return (
    <li className="flex flex-col gap-2 border-b border-line py-3 last:border-0">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-body font-semibold">
            {ch.name} <span className="text-sm font-normal text-dim">· {KIND_NAME[ch.kind]}</span>
          </span>
          {facts && <span className="truncate text-sm text-muted">{facts}</span>}
        </div>
        <Button type="button" variant="ghost" disabled={busy} onClick={test}>
          {busy ? 'Sending…' : 'Send a test'}
        </Button>
        {!phone && (
          <>
            <Button type="button" variant="ghost" onClick={() => change(() => api(url, { method: 'PATCH', body: { enabled: !ch.enabled } }))}>
              {ch.enabled ? 'Pause' : 'Turn on'}
            </Button>
            <Button
              type="button"
              variant="danger"
              onClick={() => {
                if (window.confirm(`Remove ${ch.name}? Nothing more is sent there. You can add it again later.`)) void change(() => api(url, { method: 'DELETE' }));
              }}
            >
              Remove
            </Button>
          </>
        )}
      </div>
      {admin && !phone && (
        <Check
          label="Shared with the other admins"
          hint="Every admin can change it, and it gets admin messages only, not ones about a single person."
          checked={ch.shared}
          onChange={(shared) => {
            if (shared || window.confirm(`Make ${ch.name} just yours? The other admins won’t see or change it any more.`)) void change(() => api(`${SHARED}/${ch.id}/shared`, { method: 'PUT', body: { shared } }));
          }}
        />
      )}
      {phone && <span className="text-sm text-muted">To stop all of them, open the Marquee app and switch notifications off under You.</span>}
      {!ch.enabled && <Notice>Paused. Nothing is sent here until you turn it on.</Notice>}
      {ch.lastError && <Notice tone="error">{ch.lastError}</Notice>}
      {result && <Notice tone={result.ok ? 'success' : 'error'}>{result.message}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
    </li>
  );
}

function AddChannel({ admin, startOpen }: { admin: boolean; startOpen: boolean }) {
  const [kind, setKind] = useState<Exclude<Kind, 'apns'>>('pushover');
  const [shared, setShared] = useState(false);
  const [f, setF] = useState({ name: '', appToken: '', userKey: '', server: '', topic: '', token: '', url: '', secret: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(shared ? SHARED : MINE, {
        body:
          kind === 'pushover'
            ? { kind, name: f.name || 'Pushover', appToken: f.appToken, userKey: f.userKey }
            : kind === 'webhook'
              ? { kind, name: f.name || 'Webhook', url: f.url, ...(f.secret ? { secret: f.secret } : {}) }
              : { kind, name: f.name || 'ntfy', server: f.server, topic: f.topic, ...(f.token ? { token: f.token } : {}) },
      });
      setF({ name: '', appToken: '', userKey: '', server: '', topic: '', token: '', url: '', secret: '' });
      setShared(false);
      await refreshChannels();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <details open={startOpen} className="group rounded-xl border border-line-strong">
      <summary className="flex min-h-11 cursor-pointer items-center px-4 text-body font-medium text-amber">Add Pushover, ntfy or a webhook…</summary>
      <div className="flex flex-col gap-4 px-4 pt-1 pb-4">
        <div role="group" aria-label="Which service" className="flex gap-2">
          {(['pushover', 'ntfy', 'webhook'] as const).map((k) => (
            <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)} className={cx('h-11 rounded-full border px-4 text-sm font-medium', kind === k ? 'border-amber bg-amber text-amber-ink' : 'border-line bg-panel text-soft hover:text-text')}>
              {KIND_NAME[k]}
            </button>
          ))}
        </div>
        <form onSubmit={add} className="flex flex-col gap-4">
          <Field label="Name" value={f.name} onChange={set('name')} placeholder={kind === 'pushover' ? 'My phone' : 'Family topic'} />
          {kind === 'webhook' ? (
            <>
              <Field label="Address" value={f.url} onChange={set('url')} placeholder="https://homeassistant.local:8123/api/webhook/marquee" hint="Marquee sends each message here as JSON: event, title, body, link, image and its facts." required />
              <Field label="Secret (optional)" type="password" autoComplete="off" value={f.secret} onChange={set('secret')} hint="Sent as “Authorization: Bearer …”, so the other end can check it’s Marquee." />
            </>
          ) : kind === 'pushover' ? (
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
          {admin && <Check label="Shared with the other admins" hint="For something like a family topic. It gets admin messages only." checked={shared} onChange={setShared} />}
          {error && <Notice tone="error">{error}</Notice>}
          <Button type="submit" className="self-start" disabled={busy}>
            {busy ? 'Adding…' : 'Add'}
          </Button>
        </form>
      </div>
    </details>
  );
}

// ---------------- What to send ----------------

export function NotificationsPage() {
  const ctx = useOutletContext<Ctx>();
  const admin = ctx.status.user.role === 'admin';
  const ev = useQuery({ queryKey: ['notifications', 'events'], queryFn: () => api<{ events: NotificationEventInfo[]; muted: string[] }>('/notifications/events') });
  const mine = useQuery({ queryKey: ['channels', 'mine'], queryFn: () => api<{ items: NotificationChannelView[] }>(MINE) });
  const shared = useQuery({ queryKey: ['channels', 'shared'], queryFn: () => api<{ items: NotificationChannelView[] }>(SHARED), enabled: admin });
  if (!ev.data || !mine.data || (admin && !shared.data)) return <p className="text-muted">Loading…</p>;
  const { events, muted } = ev.data;
  const places = [...mine.data.items, ...(shared.data?.items ?? [])].sort((a, b) => a.id - b.id);
  const web: Column = {
    id: 'web',
    label: 'Web UI',
    detail: 'In Marquee',
    on: (k) => !muted.includes(k),
    set: async (keys, on) => {
      const next = on ? muted.filter((k) => !keys.includes(k)) : [...new Set([...muted, ...keys])];
      await api('/notifications/muted', { method: 'PUT', body: { muted: next } });
      await queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  };
  const forAdmins = new Set(events.filter((e) => e.audience === 'admins').map((e) => e.key));
  const columns = places.map((ch): Column => ({
    id: `ch${ch.id}`,
    label: ch.name,
    detail: ch.shared ? `${KIND_NAME[ch.kind]} · Shared` : KIND_NAME[ch.kind],
    paused: !ch.enabled,
    can: ch.shared ? (k) => forAdmins.has(k) : undefined,
    on: (k) => ch.events.includes(k),
    set: async (keys, on) => {
      const next = on ? [...new Set([...ch.events, ...keys])] : ch.events.filter((k) => !keys.includes(k));
      await api(`${baseOf(ch)}/${ch.id}`, { method: 'PATCH', body: { events: next } });
      await refreshChannels();
    },
  }));
  return (
    <div className="flex max-w-[960px] flex-col gap-6">
      <div>
        <h2 className="m-0 text-lg font-semibold">What you hear about, and where</h2>
        <p className="m-0 text-sm text-muted">
          Each column is a place Marquee can send to. Tick what each one should get; every box works on its own.
          {places.some((p) => p.shared) && ' A dash means a shared place can’t get that message, because it’s about one person.'}
        </p>
      </div>
      <EventGrid events={events} columns={[web, ...columns]} caption="Which messages go to each place" />
      <Card className="flex flex-col gap-3">
        <div>
          <h2 className="m-0 text-lg font-semibold">Places</h2>
          <p className="m-0 text-sm text-muted">Your iPhone appears here by itself once notifications are on in the Marquee app. Secrets are kept by Marquee and never shown again.</p>
        </div>
        {places.length > 0 && (
          <ul className="m-0 list-none p-0">
            {places.map((ch) => (
              <ChannelRow key={ch.id} ch={ch} admin={admin} />
            ))}
          </ul>
        )}
        <AddChannel admin={admin} startOpen={places.length === 0} />
      </Card>
    </div>
  );
}

// ---------------- Customize (admins) ----------------

type Draft = { title: string; body: string; image: string };
type FieldKey = keyof Draft;

function usePreview(event: string, draft: Draft) {
  const [shown, setShown] = useState(draft);
  useEffect(() => {
    const t = setTimeout(() => setShown(draft), 300);
    return () => clearTimeout(t);
  }, [draft]);
  return useQuery({
    queryKey: ['wording', 'preview', event, shown],
    queryFn: () => api<NotificationPreview>(`${SHARED}/templates/preview`, { body: { event, ...shown } }),
    placeholderData: (prev) => prev,
  });
}

function Chip({ v, onPick }: { v: NotificationVar; onPick: (key: string) => void }) {
  return (
    <button type="button" onClick={() => onPick(v.key)} title={v.example ? `For example: ${v.example}` : undefined} className="flex min-h-11 items-center gap-1.5 rounded-full border border-line bg-ink px-3 text-sm hover:border-amber">
      <code className="text-amber">{`{{${v.key}}}`}</code>
      <span className="text-muted">{v.label}</span>
    </button>
  );
}

const ARRIVES: { value: NotificationPriority; label: string; hint: string }[] = [
  { value: 'silent', label: 'Silently', hint: 'No banner or sound. It just waits on your phone until you look.' },
  { value: 'quiet', label: 'Quietly', hint: 'A banner, but no sound or buzz.' },
  { value: 'normal', label: 'Normally', hint: 'A banner and your usual sound.' },
  { value: 'high', label: 'Right away', hint: 'Time Sensitive on an iPhone: it shows even during Focus and Do Not Disturb.' },
];

/** How one message arrives on phones. Saved as soon as you pick. */
function Arrives({ info, current }: { info: NotificationEventInfo; current: NotificationTemplateView }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pick = (priority: NotificationPriority) =>
    run(setError, async () => {
      setBusy(true);
      try {
        await api(`${SHARED}/templates/${info.key}/priority`, { method: 'PUT', body: { priority } });
        await queryClient.invalidateQueries({ queryKey: ['wording', 'list'] });
      } finally {
        setBusy(false);
      }
    });
  return (
    <fieldset className="m-0 flex flex-col gap-2 border-0 p-0" disabled={busy}>
      <legend className="mb-2 p-0 text-sm font-medium text-soft">How it arrives on phones</legend>
      <div className="flex flex-col gap-2">
        {ARRIVES.map((o) => (
          <label key={o.value} className={cx('flex min-h-11 cursor-pointer gap-3 rounded-xl border px-4 py-3 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-amber', current.priority === o.value ? 'border-amber bg-amber/10' : 'border-line hover:border-line-strong')}>
            <input type="radio" name={`arrives-${info.key}`} value={o.value} checked={current.priority === o.value} onChange={() => pick(o.value)} className="mt-1 accent-amber" />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="flex flex-wrap items-baseline gap-x-2 text-sm font-medium">
                {o.label}
                {o.value === info.priority && <span className="text-xs font-normal text-dim">Marquee’s choice</span>}
              </span>
              <span className="text-xs text-muted">{o.hint}</span>
            </span>
          </label>
        ))}
      </div>
      <span className="text-xs text-dim">This doesn’t change the web UI. Webhooks get it as “priority”.</span>
      {error && <Notice tone="error">{error}</Notice>}
    </fieldset>
  );
}

function Editor({ info, current, common }: { info: NotificationEventInfo; current: NotificationTemplateView; common: NotificationVar[] }) {
  const [draft, setDraft] = useState<Draft>({ title: current.title, body: current.body, image: current.image });
  const [focus, setFocus] = useState<FieldKey>('body');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const refs = { title: useRef<HTMLInputElement>(null), body: useRef<HTMLTextAreaElement>(null), image: useRef<HTMLInputElement>(null) };
  const preview = usePreview(info.key, draft);
  const changed = draft.title !== current.title || draft.body !== current.body || draft.image !== current.image;

  function insert(key: string) {
    const el = refs[focus].current;
    const text = `{{${key}}}`;
    const value = draft[focus];
    const at = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? at;
    setDraft({ ...draft, [focus]: value.slice(0, at) + text + value.slice(end) });
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at + text.length, at + text.length);
    });
  }
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['wording', 'list'] });
  const save = () =>
    run(setError, async () => {
      await api(`${SHARED}/templates/${info.key}`, { method: 'PUT', body: draft });
      await refresh();
      setSaved('Saved. New messages use this wording.');
    });
  const reset = () =>
    run(setError, async () => {
      const back = await api<NotificationTemplateView>(`${SHARED}/templates/${info.key}`, { method: 'DELETE' });
      setDraft({ title: back.title, body: back.body, image: back.image });
      await refresh();
      setSaved('Back to Marquee’s wording.');
    });
  const p = preview.data;
  const field = 'rounded-xl border border-line-strong bg-ink px-4 text-body text-text placeholder:text-dim focus:border-amber focus:outline-none';
  return (
    <Card className="flex min-w-0 flex-1 flex-col gap-5">
      <div>
        <h2 className="m-0 text-lg font-semibold">{info.label}</h2>
        <p className="m-0 text-sm text-muted">
          {info.description} Goes to {info.audience === 'admins' ? 'the admins' : 'the person it’s about'}.
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <label htmlFor="w-title" className="text-sm font-medium text-soft">Title</label>
        <input id="w-title" ref={refs.title} className={cx('h-12', field)} value={draft.title} onFocus={() => setFocus('title')} onChange={(e) => (setSaved(null), setDraft({ ...draft, title: e.target.value }))} />
      </div>
      <div className="flex flex-col gap-2">
        <label htmlFor="w-body" className="text-sm font-medium text-soft">Message</label>
        <textarea id="w-body" ref={refs.body} rows={3} className={cx('py-3', field)} value={draft.body} onFocus={() => setFocus('body')} onChange={(e) => (setSaved(null), setDraft({ ...draft, body: e.target.value }))} />
      </div>
      <div className="flex flex-col gap-2">
        <label htmlFor="w-image" className="text-sm font-medium text-soft">Picture</label>
        <input id="w-image" ref={refs.image} className={cx('h-12', field)} value={draft.image} placeholder="Leave blank for no picture" onFocus={() => setFocus('image')} onChange={(e) => (setSaved(null), setDraft({ ...draft, image: e.target.value }))} />
        <span className="text-xs text-dim">A picture address. <code>{'{{poster}}'}</code> is the cover art. Pushover shows the picture in the message; ntfy shows it below, and the iPhone app shows cover art.</span>
      </div>

      <Arrives info={info} current={current} />

      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium text-soft">Facts you can use</span>
        <span className="text-xs text-dim">Tap one to put it where your cursor is (in the {focus === 'body' ? 'message' : focus}).</span>
        <div className="flex flex-wrap gap-2">
          {info.vars.map((v) => (
            <Chip key={v.key} v={v} onPick={insert} />
          ))}
        </div>
        <details>
          <summary className="flex min-h-11 cursor-pointer items-center text-sm text-muted">Facts every message has</summary>
          <div className="flex flex-wrap gap-2">
            {common.map((v) => (
              <Chip key={v.key} v={v} onPick={insert} />
            ))}
          </div>
        </details>
        <details>
          <summary className="flex min-h-11 cursor-pointer items-center text-sm text-muted">Showing a part only sometimes</summary>
          <div className="flex flex-col gap-1 text-sm text-soft">
            <p className="m-0"><code>{'{{#year}} ({{year}}){{/year}}'}</code> shows “ (2024)” only when there is a year.</p>
            <p className="m-0"><code>{'{{^reason}}No reason given.{{/reason}}'}</code> shows the words only when there is no reason.</p>
            <p className="m-0">A fact with no value comes out empty, so a typo never breaks a message.</p>
          </div>
        </details>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium text-soft">Preview, with example facts</span>
        <div className="flex gap-3 rounded-xl bg-raised p-4" aria-live="polite">
          {p?.image && <img src={p.image} alt="" className="h-20 w-14 flex-none rounded-md object-cover" />}
          <div className="flex min-w-0 flex-col gap-1">
            <span className="font-semibold">{p?.title ?? '…'}</span>
            <span className="text-sm text-muted">{p?.body || <em className="text-dim">No message</em>}</span>
          </div>
        </div>
        {p && p.unknown.length > 0 && (
          <Notice tone="error">
            This message doesn’t have {p.unknown.map((n) => `{{${n}}}`).join(', ')}, so {p.unknown.length === 1 ? 'it comes' : 'they come'} out empty. Check the spelling against the facts above.
          </Notice>
        )}
      </div>

      {error && <Notice tone="error">{error}</Notice>}
      {saved && <Notice tone="success">{saved}</Notice>}
      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={save} disabled={!changed || !draft.title.trim()}>
          Save wording
        </Button>
        {current.custom && (
          <Button type="button" variant="ghost" onClick={reset}>
            Put Marquee’s wording back
          </Button>
        )}
      </div>
    </Card>
  );
}

export function CustomizePage() {
  const { data } = useQuery({ queryKey: ['wording', 'list'], queryFn: () => api<{ items: NotificationTemplateView[]; events: NotificationEventInfo[]; common: NotificationVar[] }>(`${SHARED}/templates`) });
  const [picked, setPicked] = useState<string>('request_ready');
  if (!data) return <p className="text-muted">Loading…</p>;
  const info = data.events.find((e) => e.key === picked) ?? data.events[0]!;
  const current = data.items.find((t) => t.event === info.key)!;
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="m-0 text-lg font-semibold">What each message says</h2>
        <p className="m-0 text-sm text-muted">Change the title, message and picture of anything Marquee sends, and how loudly it arrives. Your wording is used in the web UI and everywhere else.</p>
      </div>
      <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
        <nav aria-label="Messages" className="flex flex-col gap-4 lg:w-[280px] lg:flex-none">
          {GROUPS.map((g) => {
            const list = data.events.filter((e) => e.group === g);
            if (!list.length) return null;
            return (
              <div key={g} className="flex flex-col">
                <span className="px-3 pb-1 text-xs font-semibold tracking-wide text-dim uppercase">{g}</span>
                {list.map((e) => {
                  const custom = data.items.find((t) => t.event === e.key)?.custom;
                  return (
                    <button
                      key={e.key}
                      type="button"
                      aria-current={e.key === info.key ? 'true' : undefined}
                      onClick={() => setPicked(e.key)}
                      className={cx('flex min-h-11 items-center justify-between gap-2 rounded-lg px-3 text-left text-sm', e.key === info.key ? 'bg-raised text-text' : 'text-soft hover:bg-raised/60 hover:text-text')}
                    >
                      <span>{e.label}</span>
                      {custom && <span className="flex-none rounded-full bg-amber/15 px-2 py-0.5 text-xs text-amber">Yours</span>}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </nav>
        <Editor key={`${info.key}:${current.custom}:${current.title}:${current.body}:${current.image}`} info={info} current={current} common={data.common} />
      </div>
    </div>
  );
}
