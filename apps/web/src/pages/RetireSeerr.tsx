import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import type { RetireView } from '@marquee/shared';
import { api, ApiFailure } from '../api';
import { Card, Notice, cx } from '../components/ui';
import { MARK, SwitchTabs } from './SwitchOver';

/** Switch over → Seerr: what Marquee can check before you turn Seerr off. Read-only. */
export function RetireSeerrPage() {
  const q = useQuery({ queryKey: ['retire-seerr'], queryFn: () => api<RetireView>('/retire-seerr') });
  const v = q.data;
  return (
    <>
      <div className="flex flex-col gap-2">
        <SwitchTabs />
        <h1 className="m-0 font-display text-[56px] leading-none font-normal">Retire Seerr</h1>
        <p className="m-0 max-w-[720px] text-[15px] leading-relaxed text-muted">
          Once your family can browse, ask and hear back in Marquee, Seerr can go. Marquee checks what it can see; the last two steps are yours. Nothing here changes Seerr.
        </p>
      </div>
      {q.error && <Notice tone="error">{q.error instanceof ApiFailure ? q.error.message : 'Something went wrong.'}</Notice>}
      {!v && !q.error && <p className="text-muted">Checking…</p>}
      {v && (
        <>
          <Notice tone={v.ready ? 'success' : 'info'}>
            {v.ready ? 'Everything Marquee can check is done. Tell the family and turn Seerr off when you are ready.' : 'A few things are left before Seerr can go.'}
          </Notice>
          <ol className="m-0 flex list-none flex-col gap-3 p-0">
            {v.steps.map((s, i) => {
              const m = MARK[s.state];
              return (
                <li key={s.key}>
                  <Card className="flex gap-4">
                    <span aria-hidden="true" className={cx('flex size-9 flex-none items-center justify-center rounded-full border-2 font-bold', m.tone)}>
                      {s.state === 'todo' ? i + 1 : m.sign}
                    </span>
                    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                      <h2 className="m-0 text-[17px] font-semibold">
                        {s.title} <span className={cx('text-sm font-normal', m.tone.split(' ')[1])}>· {m.label}</span>
                      </h2>
                      <p className="m-0 text-sm text-soft">{s.detail}</p>
                      {s.action && (
                        <Link to={s.action.to} className="flex min-h-11 items-center self-start text-sm font-medium">
                          {s.action.label} →
                        </Link>
                      )}
                    </div>
                  </Card>
                </li>
              );
            })}
          </ol>
        </>
      )}
    </>
  );
}
