import { Heading } from "react-aria-components";

import { Avatar, type AvatarProps } from "@/components/base/avatar/avatar";
import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";
import { HoverPopover } from "@/components/ui/hover-popover";
import { avatarInitial, avatarToneClassName } from "@/lib/avatar-tone";
import { cn } from "@/lib/utils";
import { resolveTimeZone } from "@/lib/dates";
import { m } from "@/paraglide/messages";
import { getLocale } from "@/paraglide/runtime";
import {
  activityToneClass,
  agentDisplay,
  presentActivityRows,
} from "./agent-activity-presentation";
import { RECENT_ACTIVITY_LIMIT, type ActivityEntry } from "./agent-activity";

export type AvatarSize = NonNullable<AvatarProps["size"]>;

export function AgentDisplayAvatar({
  name,
  display,
  size = "sm",
}: {
  name: string;
  display?: AgentDisplaySnapshot;
  size?: AvatarSize;
}) {
  const view = agentDisplay(display);
  return (
    <span
      role="img"
      aria-label={`${name}, ${view.label}`}
      className="relative block shrink-0 rounded-[inherit]"
    >
      <Avatar
        size={size}
        alt=""
        initials={avatarInitial(name)}
        contentClassName={avatarToneClassName(name)}
      />
      {display && (
        <span
          aria-hidden="true"
          className={cn(
            "absolute -right-1 -bottom-1 size-3 rounded-full border-2 border-primary",
            activityToneClass(view.tone),
            view.pulse && "motion-safe:animate-pulse",
          )}
        />
      )}
    </span>
  );
}

/** Activity is newest-first, ordered and deduplicated by the owning Activity module. */
export function AgentActivityAvatar({
  agent,
  display,
  activity,
  loading = false,
  error = false,
  size = "sm",
  timeZone,
  onOpen,
  onPress,
}: {
  agent: { name: string; displayName: string; description?: string };
  display?: AgentDisplaySnapshot;
  activity: readonly ActivityEntry[];
  loading?: boolean;
  error?: boolean;
  size?: AvatarSize;
  timeZone?: string | null;
  onOpen?: () => void;
  /** A press/Enter on the avatar, independent of the hover peek popover. */
  onPress?: () => void;
}) {
  const view = agentDisplay(display);
  // Same cap point as before (top N of the row list); merging first means the cap
  // now lands on whole statements instead of possibly splitting one mid-fragment.
  // `activity` itself may already be windowed upstream (RECENT_ACTIVITY_LIMIT or the
  // 100-row history cap) — a statement cut at that boundary just shows what loaded.
  const recent = presentActivityRows(activity).slice(0, RECENT_ACTIVITY_LIMIT);
  const time = new Intl.DateTimeFormat(getLocale(), {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZone: resolveTimeZone(timeZone, Intl.DateTimeFormat().resolvedOptions().timeZone),
  });

  return (
    <HoverPopover
      onOpen={onOpen}
      onPress={onPress}
      label={[agent.displayName, view.label, m.agent_avatar_recent()].join(", ")}
      working={view.pulse}
      triggerClassName={cn(
        "relative shrink-0 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-4",
        size === "sm" && "rounded-lg",
      )}
      trigger={<AgentDisplayAvatar name={agent.displayName} display={display} size={size} />}
    >
      <div className="flex items-center gap-3 px-4 pt-4">
        <Avatar
          size="lg"
          alt=""
          initials={avatarInitial(agent.displayName)}
          contentClassName={avatarToneClassName(agent.displayName)}
        />
        <div className="min-w-0 flex-1">
          <Heading slot="title" className="truncate text-sm font-semibold">
            {agent.displayName}
          </Heading>
          <p className="truncate text-xs text-tertiary">@{agent.name}</p>
        </div>
        {display && (
          <span className="flex items-center gap-1.5 text-xs text-tertiary">
            <span
              aria-hidden="true"
              className={cn(
                "size-1.5 rounded-full",
                activityToneClass(view.tone),
                view.pulse && "motion-safe:animate-pulse",
              )}
            />
            {view.label}
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
        ) : !recent.length ? (
          <p className="pb-3 text-xs text-tertiary">{m.agent_activity_empty()}</p>
        ) : (
          <ol className="space-y-3 pb-2">
            {recent.map((entry) => {
              return (
                <li key={entry.key} className="flex items-start gap-3 text-xs">
                  <time
                    dateTime={new Date(entry.observedAtMs).toISOString()}
                    aria-label={new Date(entry.observedAtMs).toLocaleString(getLocale(), {
                      timeZone: time.resolvedOptions().timeZone,
                    })}
                    className="shrink-0 text-tertiary tabular-nums"
                  >
                    {time.format(new Date(entry.observedAtMs))}
                  </time>
                  <span
                    aria-hidden="true"
                    className={cn(
                      "mt-1 size-1.5 shrink-0 rounded-full",
                      activityToneClass(entry.recentTone),
                      (entry.recentTone === "working" || entry.recentTone === "thinking") &&
                        "motion-safe:animate-pulse",
                    )}
                  />
                  <span className="min-w-0 truncate">{entry.recentLabel}</span>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </HoverPopover>
  );
}
