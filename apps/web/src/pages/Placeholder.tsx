import { Card } from '../components/ui';

export function Placeholder({ title, milestone, children }: { title: string; milestone: number; children: React.ReactNode }) {
  return (
    <>
      <h1 className="m-0 font-display text-[56px] leading-none font-normal">{title}</h1>
      <Card className="flex max-w-[640px] flex-col gap-2">
        <span className="text-xs font-semibold tracking-[1.2px] text-amber uppercase">Coming in Milestone {milestone}</span>
        <p className="m-0 text-[15px] leading-relaxed text-soft">{children}</p>
      </Card>
    </>
  );
}
