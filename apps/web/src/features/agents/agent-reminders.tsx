import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { RelativeTime } from "@/components/ui/relative-time";
import { m } from "@/paraglide/messages";
import type { AgentReminderListItem } from "../../server/agents/agent-reminders.server";

type ListResult = Awaited<
  ReturnType<typeof import("./agent-reminders.functions").listAgentReminders>
>;
type HistoryResult = Awaited<
  ReturnType<typeof import("./agent-reminders.functions").getAgentReminderHistory>
>;

export function AgentReminders({
  agentId,
  owned,
  timeZone,
  onLoad,
  onLoadHistory,
}: {
  agentId: string;
  owned: boolean;
  timeZone: string | null;
  onLoad: (cursor?: { id: string }) => Promise<ListResult>;
  onLoadHistory: (reminderId: string) => Promise<HistoryResult>;
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
    return (
      <State
        heading={m.agent_reminders_private()}
        description={m.agent_reminders_private_description()}
      />
    );
  if (error)
    return (
      <State
        heading={m.agent_reminders_error()}
        description={m.agent_reminders_error_description()}
        alert
      />
    );
  if (!result)
    return (
      <div className="mt-6 animate-pulse space-y-3" aria-label={m.agent_reminders_loading()}>
        <div className="h-24 rounded-xl bg-muted" />
        <div className="h-24 rounded-xl bg-muted" />
      </div>
    );
  if (!result.reminders.length)
    return (
      <State
        heading={m.agent_reminders_empty()}
        description={m.agent_reminders_empty_description()}
      />
    );

  return (
    <div className="mt-6 space-y-3">
      <ol className="space-y-3">
        {result.reminders.map((reminder) => (
          <ReminderRow
            key={reminder.id}
            reminder={reminder}
            timeZone={timeZone}
            onLoadHistory={onLoadHistory}
          />
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
  onLoadHistory,
}: {
  reminder: AgentReminderListItem;
  timeZone: string | null;
  onLoadHistory: (id: string) => Promise<HistoryResult>;
}) {
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<HistoryResult>();
  const [historyError, setHistoryError] = useState(false);
  return (
    <li className="rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="break-words font-medium">{reminder.title}</h2>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
            <span>{statusLabel(reminder.status)}</span>
            {reminder.status === "fired" && reminder.firedAt ? (
              <span>
                {m.agent_reminders_fired_time()}{" "}
                <RelativeTime value={reminder.firedAt} timeZone={timeZone} />
              </span>
            ) : (
              <span>
                {reminder.status === "scheduled"
                  ? m.agent_reminders_next()
                  : m.agent_reminders_scheduled_time()}{" "}
                <RelativeTime value={reminder.fireAt} timeZone={timeZone} />
              </span>
            )}
            <span>
              {m.agent_reminders_recurrence()} {reminder.repeat ?? m.agent_reminders_once()}
            </span>
          </div>
        </div>
        {reminder.anchor && <AnchorLink anchor={reminder.anchor} />}
      </div>
      <Button
        className="mt-3 px-0"
        variant="ghost"
        size="sm"
        aria-expanded={open}
        onClick={async () => {
          const nextOpen = !open;
          setOpen(nextOpen);
          if (!nextOpen || history) return;
          try {
            setHistory(await onLoadHistory(reminder.id));
          } catch {
            setHistoryError(true);
          }
        }}
      >
        {open ? <ChevronDown /> : <ChevronRight />}
        {m.agent_reminders_recent_history()}
      </Button>
      {open && (
        <div className="border-t pt-3 text-sm">
          {historyError || history?.status === "unauthorized" ? (
            <p role="alert" className="text-destructive-text">
              {m.agent_reminders_history_error()}
            </p>
          ) : !history ? (
            <p className="text-muted-foreground">{m.agent_reminders_loading()}</p>
          ) : !history.events.length ? (
            <p className="text-muted-foreground">{m.agent_reminders_history_empty()}</p>
          ) : (
            <ol className="space-y-2">
              {history.events.map((event) => (
                <li key={event.id} className="flex flex-wrap justify-between gap-2">
                  <span>
                    {eventLabel(event.type)} · {event.title}
                    <span className="block text-muted-foreground">
                      {m.agent_reminders_scheduled_time()}{" "}
                      <RelativeTime value={event.scheduledFor} timeZone={timeZone} />
                    </span>
                  </span>
                  <RelativeTime value={event.time} timeZone={timeZone} />
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </li>
  );
}

function AnchorLink({ anchor }: { anchor: NonNullable<AgentReminderListItem["anchor"]> }) {
  return anchor.kind === "channel" ? (
    <Link
      className="text-sm font-medium text-primary hover:underline"
      to="/messages/channels/$channelId"
      params={{ channelId: anchor.channelId }}
      search={{ message: anchor.messageId, threadRootId: anchor.threadRootId ?? undefined }}
      hash={`message-${anchor.messageId}`}
    >
      {m.agent_reminders_anchor()}
    </Link>
  ) : (
    <Link
      className="text-sm font-medium text-primary hover:underline"
      to="/messages/$agentId"
      params={{ agentId: anchor.agentId }}
      search={{ message: anchor.messageId, threadRootId: anchor.threadRootId ?? undefined }}
      hash={`message-${anchor.messageId}`}
    >
      {m.agent_reminders_anchor()}
    </Link>
  );
}

function State({
  heading,
  description,
  alert = false,
}: {
  heading: string;
  description: string;
  alert?: boolean;
}) {
  return (
    <div className="mt-6 rounded-xl border bg-card p-6" role={alert ? "alert" : undefined}>
      <p className="font-medium">{heading}</p>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

function statusLabel(status: string) {
  if (status === "scheduled") return m.agent_reminders_status_scheduled();
  if (status === "fired") return m.agent_reminders_status_fired();
  if (status === "canceled") return m.agent_reminders_status_canceled();
  return status;
}

function eventLabel(type: string) {
  if (type === "created") return m.agent_reminders_event_created();
  if (type === "updated") return m.agent_reminders_event_updated();
  if (type === "snoozed") return m.agent_reminders_event_snoozed();
  if (type === "fired") return m.agent_reminders_event_fired();
  if (type === "canceled") return m.agent_reminders_event_canceled();
  return type;
}
