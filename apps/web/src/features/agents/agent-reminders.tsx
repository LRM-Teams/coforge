import { useEffect, useState } from "react";
import { Clock, LinkIcon, Repeat } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { RelativeTime } from "@/components/ui/relative-time";
import { m } from "@/paraglide/messages";
import type { AgentReminderListItem } from "../../server/agents/agent-reminders.server";

type ListResult = Awaited<
  ReturnType<typeof import("./agent-reminders.functions").listAgentReminders>
>;
export function AgentReminders({
  agentId,
  owned,
  timeZone,
  onLoad,
}: {
  agentId: string;
  owned: boolean;
  timeZone: string | null;
  onLoad: (cursor?: { id: string }) => Promise<ListResult>;
}) {
  const [result, setResult] = useState<ListResult>();
  const [error, setError] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    if (!owned) return;
    let active = true;
    setResult(undefined);
    setError(false);
    void onLoad()
      .then((value) => active && setResult(value))
      .catch(() => active && setError(true));
    return () => {
      active = false;
    };
  }, [agentId, onLoad, owned]);

  if (!owned || result?.status === "unauthorized")
    return <State message={m.agent_reminders_private()} />;
  if (error)
    return (
      <State
        message={m.agent_reminders_error()}
        alert
        action={
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setError(false);
              setResult(undefined);
              void onLoad()
                .then(setResult)
                .catch(() => setError(true));
            }}
          >
            {m.agent_reminders_retry()}
          </Button>
        }
      />
    );
  if (!result)
    return (
      <div className="mt-6 animate-pulse space-y-3" aria-label={m.agent_reminders_loading()}>
        <div className="flex items-center justify-between gap-6 rounded-xl border bg-card p-4">
          <div className="h-4 w-52 max-w-2/3 rounded bg-muted" />
          <div className="h-4 w-20 rounded bg-muted" />
        </div>
        <div className="flex items-center justify-between gap-6 rounded-xl border bg-card p-4">
          <div className="h-4 w-64 max-w-2/3 rounded bg-muted" />
          <div className="h-4 w-16 rounded bg-muted" />
        </div>
      </div>
    );
  if (!result.reminders.length) return <State message={m.agent_reminders_empty()} />;

  return (
    <div className="mt-6 space-y-3">
      <ol className="space-y-3">
        {result.reminders.map((reminder) => (
          <ReminderRow key={reminder.id} reminder={reminder} timeZone={timeZone} />
        ))}
      </ol>
      {result.hasMore && result.cursor && (
        <Button
          variant="outline"
          disabled={loadingMore}
          onClick={async () => {
            setLoadingMore(true);
            try {
              const next = await onLoad(result.cursor ?? undefined);
              if (next.status === "ready")
                setResult({ ...next, reminders: [...result.reminders, ...next.reminders] });
            } catch {
              setError(true);
            } finally {
              setLoadingMore(false);
            }
          }}
        >
          {loadingMore ? m.agent_reminders_loading() : m.agent_reminders_load_more()}
        </Button>
      )}
    </div>
  );
}

function ReminderRow({
  reminder,
  timeZone,
}: {
  reminder: AgentReminderListItem;
  timeZone: string | null;
}) {
  return (
    <li className="min-w-0 rounded-xl border bg-card p-4 text-card-foreground">
      <p className="whitespace-pre-wrap break-words font-medium">{reminder.title}</p>
      <div className="mt-3 space-y-2 text-xs text-muted-foreground">
        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <Clock className="size-3.5 shrink-0" aria-hidden="true" />
            <RelativeTime
              value={reminder.fireAt}
              timeZone={reminder.timezone ?? timeZone}
              showExact
            />
          </span>
          {reminder.repeat && (
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <Repeat className="size-3.5 shrink-0" aria-hidden="true" />
              {formatRecurrence(reminder.repeat)}
            </span>
          )}
        </div>
        <div className="flex min-w-0">
          <Source reminder={reminder} />
        </div>
      </div>
    </li>
  );
}

function formatRecurrence(value: string) {
  const every = /^every:([1-9]\d*)([mhd])$/.exec(value);
  if (every)
    return m.agent_reminders_repeat_every({
      count: every[1]!,
      unit:
        every[2] === "m"
          ? m.agent_reminders_unit_minutes()
          : every[2] === "h"
            ? m.agent_reminders_unit_hours()
            : m.agent_reminders_unit_days(),
    });
  const daily = /^daily@(\d{2}:\d{2})$/.exec(value);
  if (daily) return m.agent_reminders_repeat_daily({ time: daily[1]! });
  const weekly = /^weekly:([a-z,]+)@(\d{2}:\d{2})$/.exec(value);
  if (weekly) {
    const weekdays: Record<string, string> = {
      mon: m.agent_reminders_weekday_mon(),
      tue: m.agent_reminders_weekday_tue(),
      wed: m.agent_reminders_weekday_wed(),
      thu: m.agent_reminders_weekday_thu(),
      fri: m.agent_reminders_weekday_fri(),
      sat: m.agent_reminders_weekday_sat(),
      sun: m.agent_reminders_weekday_sun(),
    };
    const days = weekly[1]!
      .split(",")
      .map((day) => weekdays[day] ?? day)
      .join(", ");
    return m.agent_reminders_repeat_weekly({ days, time: weekly[2]! });
  }
  return m.agent_reminders_repeat_unknown({ value });
}

function Source({ reminder }: { reminder: AgentReminderListItem }) {
  const thread = reminder.anchor?.threadRootId;
  const shortThread = thread?.slice(0, 8);
  const target =
    reminder.anchor?.kind === "channel" ? `#${reminder.anchor.channelName}` : reminder.target;
  const label =
    shortThread && !target.includes(shortThread) ? `${target} · ${shortThread}` : target;
  const content = (
    <>
      <LinkIcon className="size-3.5 shrink-0" aria-hidden="true" />
      {label}
    </>
  );
  const className = "inline-flex min-w-0 items-center gap-1.5 break-all";
  return reminder.anchor ? (
    <AnchorLink
      anchor={reminder.anchor}
      className={`${className} rounded-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring`}
    >
      {content}
    </AnchorLink>
  ) : (
    <span className={className}>{content}</span>
  );
}

function AnchorLink({
  anchor,
  children,
  className,
}: {
  anchor: NonNullable<AgentReminderListItem["anchor"]>;
  children: React.ReactNode;
  className?: string;
}) {
  className ??=
    "min-w-0 rounded-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring";
  return anchor.kind === "channel" ? (
    <Link
      className={className}
      to="/messages/channels/$channelId"
      params={{ channelId: anchor.channelId }}
      search={{ message: anchor.messageId, threadRootId: anchor.threadRootId ?? undefined }}
      hash={`message-${anchor.messageId}`}
    >
      {children}
    </Link>
  ) : (
    <Link
      className={className}
      to="/messages/$agentId"
      params={{ agentId: anchor.agentId }}
      search={{ message: anchor.messageId, threadRootId: anchor.threadRootId ?? undefined }}
      hash={`message-${anchor.messageId}`}
    >
      {children}
    </Link>
  );
}

function State({
  message,
  alert = false,
  action,
}: {
  message: string;
  alert?: boolean;
  action?: React.ReactNode;
}) {
  return (
    <div
      className="mt-6 flex min-h-10 items-center gap-3 text-sm text-muted-foreground"
      role={alert ? "alert" : undefined}
    >
      <p>{message}</p>
      {action}
    </div>
  );
}
