import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { NavLink, Outlet, useOutletContext } from 'react-router';
import type { AuthStatus, DiscoverPrefs, NotificationChannelView, NotificationEventInfo, NotificationGroup, NotificationPreview, NotificationTemplateView, NotificationVar, SessionUser } from '@marquee/shared';
import { api, ApiFailure, queryClient } from '../api';
import { Button, Card, Field, Notice, cx } from '../components/ui';

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
//   For me        what reaches my bell and my own phones (everyone)
//   Shared alerts the admin phones and what goes to each (admins)
//   Wording       what each message says, with its facts filled in (admins)
// ======================================================================

export function NotificationSettingsLayout() {
  const ctx = useOutletContext<Ctx>();
  const admin = ctx.status.user.role === 'admin';
  const tabs = [
    { to: '/settings/notifications', label: 'For me', end: true },
    ...(admin
      ? [
          { to: '/settings/notifications/shared', label: 'Shared alerts', end: false },
          { to: '/settings/notifications/wording', label: 'Wording', end: false },
        ]
      : []),
  ];
  return (
    <div className="flex flex-col gap-6">
      {tabs.length > 1 && (
        <nav aria-label="Notification settings" className="flex flex-wrap gap-1 border-b border-line">
          {tabs.map((t) => (
            <NavLink
              key={t.to}
              to={t.to}
              end={t.end}
              className={({ isActive }) =>
                cx('-mb-px flex min-h-11 items-center border-b-2 px-4 text-sm font-medium no-underline', isActive ? 'border-amber text-text hover:text-text' : 'border-transparent text-muted hover:text-text')
              }
            >
              {t.label}
            </NavLink>
          ))}
        </nav>
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

/** One column of switches: the bell, or a phone. */
interface Column {
  id: string;
  label: string;
  detail?: string;
  paused?: boolean;
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
      <div className="overflow-x-auto rounded-2xl border border-line bg-panel">
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
                  <th scope="rowgroup" className="sticky left-0 z-10 bg-raised px-4 py-2">
                    <span className="block text-body font-semibold">{g}</span>
                    <span className="block text-xs font-normal text-dim">{GROUP_HINT[g]}</span>
                  </th>
                  {columns.map((c) => {
                    const n = keys.filter(c.on).length;
                    return (
                      <td key={c.id} className="px-2 py-1">
                        <div className="flex justify-center">
                          <Box label={`All ${g} messages: ${c.label}`} checked={n === keys.length} mixed={n > 0 && n < keys.length} disabled={busy} onChange={(on) => flip(c, keys, on)} />
                        </div>
                      </td>
                    );
                  })}
                </tr>
                {list.map((e) => (
                  <tr key={e.key} className="border-t border-line/60">
                    <th scope="row" className="sticky left-0 z-10 max-w-[340px] bg-panel px-4 py-2 font-normal">
                      <span className="block text-body">{e.label}</span>
                      <span className="block text-xs text-dim">{e.description}</span>
                    </th>
                    {columns.map((c) => (
                      <td key={c.id} className="px-2 py-1">
                        <div className="flex justify-center">
                          <Box label={`${e.label}: ${c.label}`} checked={c.on(e.key)} disabled={busy} onChange={(on) => flip(c, [e.key], on)} />
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

const channelColumn = (ch: NotificationChannelView, base: string): Column => ({
  id: `ch${ch.id}`,
  label: ch.name,
  detail: ch.kind === 'pushover' ? 'Pushover' : 'ntfy',
  paused: !ch.enabled,
  on: (k) => ch.events.includes(k),
  set: async (keys, on) => {
    const events = on ? [...new Set([...ch.events, ...keys])] : ch.events.filter((k) => !keys.includes(k));
    await api(`${base}/${ch.id}`, { method: 'PATCH', body: { events } });
    await queryClient.invalidateQueries({ queryKey: ['channels'] });
  },
});

// ---------------- Phones ----------------

type Kind = 'pushover' | 'ntfy';

function ChannelRow({ ch, base }: { ch: NotificationChannelView; base: string }) {
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['channels'] });
  async function test() {
    setBusy(true);
    setResult(null);
    try {
      setResult(await api<{ ok: boolean; message: string }>(`${base}/${ch.id}/test`, { body: {} }));
      await refresh();
    } catch (e) {
      setResult({ ok: false, message: errMsg(e) });
    } finally {
      setBusy(false);
    }
  }
  return (
    <li className="flex flex-col gap-2 border-b border-line py-3 last:border-0">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-body font-semibold">
            {ch.name} <span className="text-sm font-normal text-dim">· {ch.kind === 'pushover' ? 'Pushover' : 'ntfy'}</span>
          </span>
          <span className="truncate text-sm text-muted">
            {ch.detail}
            {!ch.lastError && ch.lastOkAt ? ` · last sent ${new Date(ch.lastOkAt).toLocaleString()}` : ''}
          </span>
        </div>
        <Button type="button" variant="ghost" disabled={busy} onClick={test}>
          {busy ? 'Sending…' : 'Send a test'}
        </Button>
        <Button type="button" variant="ghost" onClick={() => run(setError, async () => (await api(`${base}/${ch.id}`, { method: 'PATCH', body: { enabled: !ch.enabled } }), await refresh()))}>
          {ch.enabled ? 'Pause' : 'Turn on'}
        </Button>
        <Button
          type="button"
          variant="danger"
          onClick={() => {
            if (window.confirm(`Remove ${ch.name}? Nothing more is sent there. You can add it again later.`)) void run(setError, async () => (await api(`${base}/${ch.id}`, { method: 'DELETE' }), await refresh()));
          }}
        >
          Remove
        </Button>
      </div>
      {!ch.enabled && <Notice>Paused. Nothing is sent here until you turn it on.</Notice>}
      {ch.lastError && <Notice tone="error">{ch.lastError}</Notice>}
      {result && <Notice tone={result.ok ? 'success' : 'error'}>{result.message}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
    </li>
  );
}

function AddChannel({ base, startOpen }: { base: string; startOpen: boolean }) {
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
      await api(base, {
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
    <details open={startOpen} className="group rounded-xl border border-line-strong">
      <summary className="flex min-h-11 cursor-pointer items-center px-4 text-body font-medium text-amber">Add a phone or another place…</summary>
      <div className="flex flex-col gap-4 px-4 pt-1 pb-4">
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
      </div>
    </details>
  );
}

function Phones({ items, base, title, hint }: { items: NotificationChannelView[]; base: string; title: string; hint: string }) {
  return (
    <Card className="flex flex-col gap-3">
      <div>
        <h2 className="m-0 text-lg font-semibold">{title}</h2>
        <p className="m-0 text-sm text-muted">{hint}</p>
      </div>
      {items.length > 0 && (
        <ul className="m-0 list-none p-0">
          {items.map((ch) => (
            <ChannelRow key={ch.id} ch={ch} base={base} />
          ))}
        </ul>
      )}
      <AddChannel base={base} startOpen={items.length === 0} />
    </Card>
  );
}

// ---------------- For me ----------------

const MINE = '/notifications/channels';

export function MyNotificationsPage() {
  const ev = useQuery({ queryKey: ['notifications', 'events'], queryFn: () => api<{ events: NotificationEventInfo[]; muted: string[] }>('/notifications/events') });
  const ch = useQuery({ queryKey: ['channels', 'mine'], queryFn: () => api<{ items: NotificationChannelView[] }>(MINE) });
  if (!ev.data || !ch.data) return <p className="text-muted">Loading…</p>;
  const { events, muted } = ev.data;
  const bell: Column = {
    id: 'bell',
    label: 'Bell',
    detail: 'In Marquee',
    on: (k) => !muted.includes(k),
    set: async (keys, on) => {
      const next = on ? muted.filter((k) => !keys.includes(k)) : [...new Set([...muted, ...keys])];
      await api('/notifications/muted', { method: 'PUT', body: { muted: next } });
      await queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  };
  // A phone only gets what the bell gets: turning one off in the bell stops it everywhere for you.
  const phones = ch.data.items.map((c) => {
    const col = channelColumn(c, MINE);
    return { ...col, on: (k: string) => col.on(k) && !muted.includes(k) };
  });
  return (
    <div className="flex max-w-[960px] flex-col gap-6">
      <div>
        <h2 className="m-0 text-lg font-semibold">What you hear about</h2>
        <p className="m-0 text-sm text-muted">
          This is just for you. Untick something under <strong className="font-semibold text-soft">Bell</strong> to stop hearing about it anywhere. Add your phone below to get messages there too, and pick which ones in its column.
        </p>
      </div>
      <EventGrid events={events} columns={[bell, ...phones]} caption="Which messages reach you, and where" />
      <Phones items={ch.data.items} base={MINE} title="My phones" hint="Pushover or ntfy, just for you. Only you see these, and only your messages go there." />
    </div>
  );
}

// ---------------- Shared alerts (admins) ----------------

const SHARED = '/settings/notifications';

export function SharedAlertsPage() {
  const { data } = useQuery({ queryKey: ['channels', 'shared'], queryFn: () => api<{ items: NotificationChannelView[]; events: NotificationEventInfo[] }>(SHARED) });
  if (!data) return <p className="text-muted">Loading…</p>;
  return (
    <div className="flex max-w-[960px] flex-col gap-6">
      <div>
        <h2 className="m-0 text-lg font-semibold">Alerts for the admins</h2>
        <p className="m-0 text-sm text-muted">Places every admin message can go, like a shared family ntfy topic or the house Pushover. Each column is one place; tick what it should get. Messages for one person (like “Ready to watch”) go to that person’s own phones instead.</p>
      </div>
      {data.items.length > 0 ? (
        <EventGrid events={data.events} columns={data.items.map((c) => channelColumn(c, SHARED))} caption="Which admin messages go to each shared place" />
      ) : (
        <Notice>Nothing set up yet. Add Pushover or ntfy below and its column shows up here.</Notice>
      )}
      <Phones items={data.items} base={SHARED} title="Shared places" hint="Pushover or ntfy. Secrets are kept by Marquee and never shown again." />
    </div>
  );
}

// ---------------- Wording (admins) ----------------

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
        <span className="text-xs text-dim">A picture address. <code>{'{{poster}}'}</code> is the cover art. Pushover shows the picture in the message; ntfy shows it below.</span>
      </div>

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

export function WordingPage() {
  const { data } = useQuery({ queryKey: ['wording', 'list'], queryFn: () => api<{ items: NotificationTemplateView[]; events: NotificationEventInfo[]; common: NotificationVar[] }>(`${SHARED}/templates`) });
  const [picked, setPicked] = useState<string>('request_ready');
  if (!data) return <p className="text-muted">Loading…</p>;
  const info = data.events.find((e) => e.key === picked) ?? data.events[0]!;
  const current = data.items.find((t) => t.event === info.key)!;
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="m-0 text-lg font-semibold">What each message says</h2>
        <p className="m-0 text-sm text-muted">Change the title, message and picture of anything Marquee sends. Your wording is used in the bell and on every phone.</p>
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
