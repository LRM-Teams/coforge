import { useEffect, useState } from "react";
import { Heading } from "react-aria-components";

import { Avatar } from "@/components/base/avatar/avatar";
import { HoverPopover } from "@/components/ui/hover-popover";
import { avatarInitial, avatarToneClassName } from "@/lib/avatar-tone";
import { cn } from "@/lib/utils";
import { resolveTimeZone } from "@/lib/dates";
import { m } from "@/paraglide/messages";
import { getLocale } from "@/paraglide/runtime";
import { activityDotClass, activityLabel } from "./agent-activity-presentation";

type AvatarActivity = {
  id?: string;
  detailKind: string;
  level: string;
  detail: string;
  observedAtMs: number;
};

const workActivities = new Set([
  "working",
  "running_command",
  "reading_file",
  "writing_file",
  "editing_file",
  "using_tool",
]);

export function useAgentWorkingLabel({
  activity,
  status,
  loading = false,
  error = false,
}: {
  activity: readonly AvatarActivity[];
  status?: "active" | "inactive";
  loading?: boolean;
  error?: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  const latest = activity[0];
  const age = latest ? now - latest.observedAtMs : Infinity;
  const working =
    status === "active" &&
    !loading &&
    !error &&
    age >= 0 &&
    age < 60_000 &&
    latest?.level !== "error" &&
    workActivities.has(latest?.detailKind ?? "");
  useEffect(() => {
    setNow(Date.now());
    if (!working) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [latest, working]);
  return working && latest ? activityLabel(latest.detailKind, latest.level) : null;
}

/** Activity is newest-first, ordered and deduplicated by the owning Activity module. */
export function AgentActivityAvatar({
  agent,
  status,
  activity,
  loading = false,
  error = false,
  size = "sm",
  timeZone,
  onOpen,
}: {
  agent: { name: string; displayName: string; description?: string };
  status?: "active" | "inactive";
  activity: readonly AvatarActivity[];
  loading?: boolean;
  error?: boolean;
  size?: "sm" | "lg";
  timeZone?: string | null;
  onOpen?: () => void;
}) {
  const workingLabel = useAgentWorkingLabel({
    activity,
    status,
    loading,
    error,
  });
  const presence =
    status === "active"
      ? m.agent_status_online()
      : status === "inactive"
        ? m.agent_status_offline()
        : undefined;
  const time = new Intl.DateTimeFormat(getLocale(), {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZone: resolveTimeZone(timeZone, Intl.DateTimeFormat().resolvedOptions().timeZone),
  });
  const avatarSize = size === "sm" ? "sm" : "lg";

  return (
    <HoverPopover
      onOpen={onOpen}
      label={[agent.displayName, presence, workingLabel, m.agent_avatar_recent()]
        .filter(Boolean)
        .join(", ")}
      working={Boolean(workingLabel)}
      triggerClassName="relative shrink-0 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-4"
      trigger={
        <span className="relative block rounded-[inherit]">
          <Avatar
            size={avatarSize}
            alt={agent.displayName}
            initials={avatarInitial(agent.displayName)}
            contentClassName={avatarToneClassName(agent.displayName)}
          />
          {status ? (
            <span
              aria-hidden="true"
              className={cn(
                "absolute -right-1 -bottom-1 size-3 rounded-full border-2 border-primary",
                workingLabel && activity[0]?.detailKind === "running_command"
                  ? cn(
                      activityDotClass(activity[0].detailKind, activity[0].level),
                      "motion-safe:animate-pulse",
                    )
                  : status === "active"
                    ? "bg-online"
                    : "bg-offline",
              )}
            />
          ) : null}
        </span>
      }
    >
      <div className="flex items-center gap-3 px-4 pt-4">
        <Avatar
          size="lg"
          alt={agent.displayName}
          initials={avatarInitial(agent.displayName)}
          contentClassName={avatarToneClassName(agent.displayName)}
        />
        <div className="min-w-0 flex-1">
          <Heading slot="title" className="truncate text-sm font-semibold text-primary">
            {agent.displayName}
          </Heading>
          <p className="truncate text-xs text-tertiary">@{agent.name}</p>
        </div>
        {presence && (
          <span className="flex items-center gap-1.5 text-xs text-tertiary">
            <span
              aria-hidden="true"
              className={cn(
                "size-1.5 rounded-full",
                status === "active" ? "bg-online" : "bg-offline",
              )}
            />
            {presence}
          </span>
        )}
      </div>
      {agent.description && (
        <p className="px-4 pt-3 text-xs leading-5 text-tertiary">{agent.description}</p>
      )}
      <div className="mt-4 border-t border-secondary px-4 pt-3 pb-2">
        <h3 className="mb-3 text-xs font-medium text-tertiary">{m.agent_avatar_recent()}</h3>
        {loading ? (
          <p className="pb-3 text-xs text-tertiary">{m.agent_avatar_loading()}</p>
        ) : error ? (
          <p role="status" className="pb-3 text-xs text-tertiary">
            {m.agent_avatar_error()}
          </p>
        ) : !activity.length ? (
          <p className="pb-3 text-xs text-tertiary">{m.agent_activity_empty()}</p>
        ) : (
          <ol className="space-y-3 pb-2">
            {activity.slice(0, 5).map((entry, index) => {
              return (
                <li key={entry.id ?? index} className="flex items-start gap-3 text-xs">
                  <time
                    dateTime={new Date(entry.observedAtMs).toISOString()}
                    aria-label={new Date(entry.observedAtMs).toLocaleString(getLocale(), {
                      timeZone: time.resolvedOptions().timeZone,
                    })}
                    className="shrink-0 font-mono text-tertiary tabular-nums"
                  >
                    {time.format(new Date(entry.observedAtMs))}
                  </time>
                  <span
                    aria-hidden="true"
                    className={cn(
                      "mt-1 size-1.5 shrink-0 rounded-full",
                      activityDotClass(entry.detailKind, entry.level),
                    )}
                  />
                  <span className="min-w-0 text-primary">
                    {activityLabel(entry.detailKind, entry.level)}
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </HoverPopover>
  );
}
