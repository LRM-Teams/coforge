import { CalendarDays, Monitor, MoreVertical } from "lucide-react";

import { Button } from "@/components/ui/button";
import { m } from "@/paraglide/messages";

interface AgentCardProps {
  name: string;
  handle: string;
  role: string;
  description: string;
  computer: string;
  owner: string;
  initials: string;
  avatarClassName: string;
}

export function AgentCard({
  name,
  handle,
  role,
  description,
  computer,
  owner,
  initials,
  avatarClassName,
}: AgentCardProps) {
  return (
    <article
      data-agent-card
      className="flex min-h-64 min-w-0 flex-col rounded-xl border bg-card p-4"
    >
      <div className="flex items-start gap-3">
        <div className="relative shrink-0">
          <div
            className={`flex size-12 items-center justify-center rounded-xl text-sm font-semibold text-white ${avatarClassName}`}
          >
            {initials}
          </div>
          <span className="absolute right-0 bottom-0 size-2.5 rounded-full border-2 border-card bg-success" />
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" className="min-w-24">
            {m.agent_private_chat()}
          </Button>
          <Button variant="outline" size="icon" aria-label={m.agent_more_actions({ name })}>
            <MoreVertical aria-hidden="true" />
          </Button>
        </div>
      </div>

      <div className="mt-3 flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold">
            {name} <span className="font-medium">{role}</span>
          </h2>
          <p className="truncate text-xs text-muted-foreground">@{handle}</p>
        </div>
        <span className="flex max-w-36 shrink-0 items-center gap-1.5 truncate rounded-full bg-muted px-2.5 py-1 text-[11px] text-muted-foreground">
          <Monitor aria-hidden="true" className="size-3" />
          <span className="truncate">{computer}</span>
        </span>
      </div>

      <p className="mt-3 line-clamp-2 text-[13px] leading-5 text-card-foreground">{description}</p>

      <dl className="mt-3 flex flex-wrap gap-2 text-[11px]">
        <div className="rounded bg-muted px-2 py-1">
          <dt className="inline text-muted-foreground">{m.agent_success_rate()} </dt>
          <dd className="inline font-medium">97.2%</dd>
        </div>
        <div className="rounded bg-muted px-2 py-1">
          <dt className="inline text-muted-foreground">{m.agent_total_spend()} </dt>
          <dd className="inline font-medium">$226.23</dd>
        </div>
        <div className="rounded bg-muted px-2 py-1">
          <dt className="inline text-muted-foreground">{m.agent_total_time()} </dt>
          <dd className="inline font-medium">34 {m.agent_days()}</dd>
        </div>
      </dl>

      <footer className="mt-auto flex items-center gap-2 border-t pt-3 text-[11px] text-muted-foreground">
        <span className="flex size-5 items-center justify-center rounded-full bg-muted text-[9px] font-semibold text-muted-foreground">
          {owner.slice(0, 1)}
        </span>
        <span>{owner}</span>
        <CalendarDays aria-hidden="true" className="ml-2 size-3.5" />
        <time dateTime="2026-07-23">2026.07.23</time>
      </footer>
    </article>
  );
}
