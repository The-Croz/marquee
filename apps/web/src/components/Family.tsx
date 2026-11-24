import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { IssueProblem, IssueView, RequestAllowance, SeasonView } from '@marquee/shared';
import { ApiFailure, api, queryClient } from '../api';
import { Sheet } from './Overlay';
import { Button, Card, Notice, cx } from './ui';

/** "Something wrong?" reports, what's left of a weekly limit, and the private calendar link. */

const errMsg = (e: unknown) => (e instanceof ApiFailure ? e.message : 'Something went wrong.');
const when = (ms: number) => new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

const PROBLEMS: { value: IssueProblem; label: string }[] = [
  { value: 'picture', label: 'Picture (blurry, glitches, wrong shape)' },
  { value: 'sound', label: 'Sound (missing, out of sync, wrong language)' },
  { value: 'subtitles', label: 'Subtitles (missing, wrong, out of sync)' },
  { value: 'wrong_title', label: 'It’s the wrong movie or episode' },
  { value: 'other', label: 'Something else' },
];

/** On a title page: report a problem, and see open reports about it. */
export function SomethingWrong({ kind, id, seasons }: { kind: 'movie' | 'series'; id: number; seasons?: SeasonView[] }) {
  const [open, setOpen] = useState(false);
  const [problem, setProblem] = useState<IssueProblem>('picture');
  const [message, setMessage] = useState('');
  const [where, setWhere] = useState('');
  const key = ['issues', 'title', kind, id];
  const q = useQuery({ queryKey: key, queryFn: () => api<{ items: IssueView[] }>(`/issues/title/${kind}/${id}`) });
  const send = useMutation({
    mutationFn: () => {
      const [season, episode] = where ? where.split(':').map(Number) : [];
      return api<IssueView>('/issues', { body: { kind, id, problem, message, ...(season !== undefined ? { season, episode: episode || null } : {}) } });
    },
    onSuccess: async () => {
      setMessage('');
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: ['issues'] });
    },
  });
  const openOnes = q.data?.items ?? [];
  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" onClick={() => setOpen(true)}>
          Something wrong?
        </Button>
        {send.isSuccess && <span className="text-sm text-teal-hi">Thanks. An admin will look at it, and you’ll hear back.</span>}
      </div>
      {openOnes.length > 0 && (
        <Notice>
          {openOnes.length === 1 ? 'One problem' : `${openOnes.length} problems`} reported:{' '}
          {openOnes.map((i) => `${i.problemText}${i.where ? ` (${i.where})` : ''}`).join(', ')}.{' '}
          <Link to="/requests?tab=problems" className="font-semibold">
            See them
          </Link>
        </Notice>
      )}
      <Sheet open={open} onClose={() => setOpen(false)} title="What’s wrong?">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            send.mutate();
          }}
        >
          <fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
            <legend className="mb-1 text-sm text-soft">The problem</legend>
            {PROBLEMS.map((p) => (
              <label key={p.value} className="flex min-h-11 items-center gap-3 text-sm">
                <input type="radio" name="problem" value={p.value} checked={problem === p.value} onChange={() => setProblem(p.value)} className="size-5 accent-amber" />
                {p.label}
              </label>
            ))}
          </fieldset>
          {kind === 'series' && seasons && seasons.length > 0 && (
            <label className="flex flex-col gap-1.5 text-sm text-soft">
              Which episode
              <select value={where} onChange={(e) => setWhere(e.target.value)} className="h-11 rounded-lg border border-line-strong bg-ink px-2.5 text-sm text-text">
                <option value="">The whole show</option>
                {seasons.map((s) => (
                  <optgroup key={s.season} label={s.season === 0 ? 'Specials' : `Season ${s.season}`}>
                    <option value={`${s.season}:0`}>All of {s.season === 0 ? 'the specials' : `season ${s.season}`}</option>
                    {s.episodes
                      .filter((e) => e.file)
                      .map((e) => (
                        <option key={e.episode} value={`${s.season}:${e.episode}`}>
                          Episode {e.episode}
                          {e.title ? ` · ${e.title}` : ''}
                        </option>
                      ))}
                  </optgroup>
                ))}
              </select>
            </label>
          )}
          <label className="flex flex-col gap-1.5 text-sm text-soft">
            Tell us more {problem === 'other' ? '' : '(optional)'}
            <textarea value={message} onChange={(e) => setMessage(e.target.value)} maxLength={1000} rows={3} placeholder="About 20 minutes in, the sound drifts." className="rounded-lg border border-line-strong bg-ink px-3 py-2 text-sm text-text" />
          </label>
          {send.error && <Notice tone="error">{errMsg(send.error)}</Notice>}
          <div className="flex gap-2">
            <Button type="submit" disabled={send.isPending}>
              {send.isPending ? 'Sending…' : 'Send'}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      </Sheet>
    </>
  );
}

function IssueRow({ issue, admin }: { issue: IssueView; admin: boolean }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const full = useQuery({ queryKey: ['issue', issue.id], queryFn: () => api<IssueView>(`/issues/${issue.id}`), enabled: open });
  const done = async (v: IssueView) => {
    setText('');
    queryClient.setQueryData(['issue', issue.id], v);
    await queryClient.invalidateQueries({ queryKey: ['issues'] });
  };
  const reply = useMutation({ mutationFn: () => api<IssueView>(`/issues/${issue.id}/replies`, { body: { body: text } }), onSuccess: done });
  const fix = useMutation({ mutationFn: (fixed: boolean) => api<IssueView>(`/issues/${issue.id}/fixed`, { body: { fixed, message: text } }), onSuccess: done });
  const v = full.data ?? issue;
  return (
    <li className="flex flex-col gap-2 rounded-2xl border border-line bg-panel p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <strong className="text-body text-text">
            {v.href ? <Link to={v.href}>{v.title}</Link> : v.title}
            {v.where && <span className="font-normal text-soft"> · {v.where}</span>}
          </strong>
          <span className="text-sm text-soft">
            {v.problemText}
            {v.message && `: “${v.message}”`}
          </span>
          <span className="text-label text-muted">
            {v.by}, {when(v.createdAt)} · {v.status === 'fixed' ? 'Fixed' : 'Open'}
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          {admin && v.href && v.status === 'open' && (
            <Link to={`${v.href}?find=1`} className="inline-flex h-11 items-center rounded-xl border border-line-strong px-4 text-sm font-medium text-text no-underline hover:bg-raised">
              Find a better copy
            </Link>
          )}
          <Button variant="ghost" onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? 'Hide' : 'Replies'}
          </Button>
        </div>
      </div>
      {open && (
        <div className="flex flex-col gap-2 border-t border-line pt-2">
          {v.comments.map((c) => (
            <p key={c.id} className="m-0 text-sm">
              <strong>{c.by}</strong> <span className="text-label text-muted">{when(c.createdAt)}</span>
              <br />
              {c.body}
            </p>
          ))}
          <label className="sr-only" htmlFor={`reply-${v.id}`}>
            Reply
          </label>
          <textarea id={`reply-${v.id}`} value={text} onChange={(e) => setText(e.target.value)} rows={2} maxLength={1000} placeholder="Write a reply…" className="rounded-lg border border-line-strong bg-ink px-3 py-2 text-sm text-text" />
          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" disabled={!text.trim() || reply.isPending} onClick={() => reply.mutate()}>
              Send reply
            </Button>
            {admin && v.status === 'open' && <Button onClick={() => fix.mutate(true)}>{text.trim() ? 'Send and mark fixed' : 'Mark fixed'}</Button>}
            {admin && v.status === 'fixed' && (
              <Button variant="ghost" onClick={() => fix.mutate(false)}>
                Open it again
              </Button>
            )}
          </div>
          {(reply.error || fix.error) && <Notice tone="error">{errMsg(reply.error ?? fix.error)}</Notice>}
        </div>
      )}
    </li>
  );
}

/** Requests → Something wrong?: everyone's (admins) or your own reports. */
export function ProblemsList({ admin }: { admin: boolean }) {
  const [status, setStatus] = useState<'open' | 'fixed'>('open');
  const q = useQuery({ queryKey: ['issues', status], queryFn: () => api<{ items: IssueView[] }>(`/issues?status=${status}`) });
  return (
    <div className="flex flex-col gap-3">
      <div role="group" aria-label="Which reports" className="flex gap-2">
        {(['open', 'fixed'] as const).map((s) => (
          <button key={s} type="button" aria-pressed={status === s} onClick={() => setStatus(s)} className={cx('h-11 rounded-full border px-4 text-sm', status === s ? 'border-line-strong bg-raised text-text' : 'border-line text-muted')}>
            {s === 'open' ? 'Open' : 'Fixed'}
          </button>
        ))}
      </div>
      {q.error && <Notice tone="error">{errMsg(q.error)}</Notice>}
      {q.data && q.data.items.length === 0 && <Notice>{status === 'open' ? 'Nothing reported. Use “Something wrong?” on a title’s page when a copy has a problem.' : 'Nothing fixed yet.'}</Notice>}
      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {q.data?.items.map((i) => (
          <IssueRow key={i.id} issue={i} admin={admin} />
        ))}
      </ul>
    </div>
  );
}

/** "2 of 5 requests left this week", shown before asking. Nothing when there's no limit. */
export function RequestsLeft({ className }: { className?: string }) {
  const q = useQuery({ queryKey: ['requests', 'allowance'], queryFn: () => api<RequestAllowance>('/requests/allowance') });
  const a = q.data;
  if (!a || !a.limit) return null;
  return (
    <span className={cx('text-sm', a.left === 0 ? 'text-warn' : 'text-soft', className)}>
      {a.left === 0
        ? `You’ve used all ${a.limit} requests this week. The next one frees up ${a.nextAt ? new Date(a.nextAt).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }) : 'soon'}.`
        : `${a.left} of ${a.limit} requests left this week.`}
    </span>
  );
}

/** Calendar: a private link to subscribe to in Apple Calendar, Google Calendar or Outlook. */
export function CalendarLink() {
  const q = useQuery({ queryKey: ['calendar', 'link'], queryFn: () => api<{ path: string | null; base: string | null }>('/calendar/link') });
  const set = (v: { path: string | null; base?: string | null }) => queryClient.setQueryData(['calendar', 'link'], { base: q.data?.base ?? null, ...v });
  const make = useMutation({ mutationFn: () => api<{ path: string; base: string | null }>('/calendar/link', { body: {} }), onSuccess: set });
  const remove = useMutation({ mutationFn: () => api<{ path: null }>('/calendar/link', { method: 'DELETE' }), onSuccess: set });
  const [copied, setCopied] = useState(false);
  if (!q.data) return null;
  const url = q.data.path ? `${(q.data.base ?? window.location.origin).replace(/\/+$/, '')}${q.data.path}` : null;
  return (
    <Card className="flex flex-col gap-3">
      <h2 className="m-0 text-heading font-semibold">In your calendar app</h2>
      <p className="m-0 text-label text-muted">A private link to subscribe to in Apple Calendar, Google Calendar or Outlook. Anyone with the link can see this calendar, so keep it to yourself; make a new one to turn the old one off.</p>
      {url ? (
        <>
          <input readOnly value={url} aria-label="Your calendar link" onFocus={(e) => e.target.select()} className="h-11 rounded-lg border border-line-strong bg-ink px-3 font-mono text-sm text-text" />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                void navigator.clipboard?.writeText(url).then(() => setCopied(true));
              }}
            >
              {copied ? 'Copied' : 'Copy link'}
            </Button>
            <a href={url.replace(/^https?:/, 'webcal:')} className="inline-flex h-11 items-center rounded-xl border border-line-strong px-4 text-sm font-medium text-text no-underline hover:bg-raised">
              Open in Calendar
            </a>
            <Button variant="ghost" onClick={() => window.confirm('Make a new link? The old one stops working.') && make.mutate()}>
              New link
            </Button>
            <Button variant="danger" onClick={() => remove.mutate()}>
              Turn off
            </Button>
          </div>
        </>
      ) : (
        <Button className="self-start" onClick={() => make.mutate()} disabled={make.isPending}>
          Make my link
        </Button>
      )}
      {(make.error || remove.error) && <Notice tone="error">{errMsg(make.error ?? remove.error)}</Notice>}
    </Card>
  );
}
