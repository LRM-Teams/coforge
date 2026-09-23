import { Heading } from "react-aria-components";

import { Avatar, type AvatarProps } from "@/components/base/avatar/avatar";
import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";
import { DELETED_AGENT_AVATAR_CLASS, DeletedAgentBadge } from "./deleted-agent";
import { HoverPopover } from "@/components/ui/hover-popover";
import { StatusDot } from "@/components/ui/status-dot";
import { ClockTime } from "@/components/ui/relative-time";
import { avatarInitial, avatarToneClassName } from "@/lib/avatar-tone";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";
import { agentDisplay, presentActivityRows } from "./agent-activity-presentation";
import {
  POPOVER_EXCLUDED_DETAIL_KINDS,
  RECENT_ACTIVITY_LIMIT,
  type ActivityEntry,
} from "./agent-activity";

export type AvatarSize = NonNullable<AvatarProps["size"]>;

/** One dot scale per avatar size so the sidebar row and the conversation header read alike. */
const displayDotClassName: Record<AvatarSize, string> = {
  xs: "-right-0.5 -bottom-0.5 size-2 border",
  sm: "-right-1 -bottom-1 size-3 border-2",
  md: "-right-1 -bottom-1 size-3 border-2",
  lg: "-right-1 -bottom-1 size-3.5 border-2",
  xl: "-right-1 -bottom-1 size-4 border-2",
  "2xl": "-right-1 -bottom-1 size-4 border-2",
};

export function AgentDisplayAvatar({
  name,
  src,
  display,
  stopped,
  deleted,
  size = "sm",
}: {
  name: string;
  /** The Agent's uploaded avatar, when it has one; initials stand in otherwise. */
  src?: string | null;
  display?: AgentDisplaySnapshot;
  /** The user stopped this Agent; see `agentDisplay`. */
  stopped?: boolean;
  /** The Agent was deleted. Its avatar renders greyed wherever it appears, so a deleted
   * identity is recognisable outside message rows too (DM header, mention chips, member cards). */
  deleted?: boolean;
  size?: AvatarSize;
}) {
  const view = agentDisplay(display, { stopped });
  return (
    <span
      role="img"
      aria-label={`${name}, ${deleted ? m.agent_deleted_badge() : view.label}`}
      className="relative block shrink-0 rounded-[inherit]"
    >
      <Avatar
        size={size}
        alt=""
        src={src}
        initials={avatarInitial(name)}
        contentClassName={deleted ? DELETED_AGENT_AVATAR_CLASS : avatarToneClassName(name)}
      />
      {display && !deleted && (
        <StatusDot
          tone={view.tone}
          pulse={view.pulse}
          className={cn("absolute border-primary", displayDotClassName[size])}
        />
      )}
    </span>
  );
}

/** Activity is newest-first, ordered and deduplicated by the owning Activity module. */
export function AgentActivityAvatar({
  agent,
  src,
  display,
  activity,
  loading = false,
  error = false,
  deleted = false,
  size = "sm",
  timeZone,
  onOpen,
  onPress,
}: {
  agent: { name: string; displayName: string; description?: string };
  src?: string | null;
  display?: AgentDisplaySnapshot;
  activity: readonly ActivityEntry[];
  loading?: boolean;
  error?: boolean;
  /** Render the deleted treatment instead of a live status. */
  deleted?: boolean;
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
  // 500-row history cap) — a statement cut at that boundary just shows what loaded.
  // Filtered here too (defense in depth alongside agent-activity-queries.ts's mergeRecent):
  // this component is also fed the Agent detail page's full, unfiltered feed directly, which
  // now legitimately contains tool_end/thinking_end/compaction_finished status rows
  // that don't belong in this short "recent activity" popover.
  const recent = presentActivityRows(
    activity.filter((entry) => !POPOVER_EXCLUDED_DETAIL_KINDS.has(entry.detailKind)),
  ).slice(0, RECENT_ACTIVITY_LIMIT);

  return (
    <HoverPopover
      onOpen={onOpen}
      onPress={onPress}
      label={[
        agent.displayName,
        // A deleted Agent has no live status, so the popover trigger must not announce
        // one (the inner avatar's own label is already corrected in `AgentDisplayAvatar`).
        deleted ? m.agent_deleted_badge() : view.label,
        m.agent_avatar_recent(),
      ].join(", ")}
      working={view.pulse}
      triggerClassName={cn(
        "relative shrink-0 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-4",
        size === "sm" && "rounded-lg",
      )}
      trigger={
        <AgentDisplayAvatar
          name={agent.displayName}
          src={src}
          display={display}
          deleted={deleted}
          size={size}
        />
      }
    >
      <div className="flex items-center gap-3 px-4 pt-4">
        <Avatar
          size="lg"
          alt=""
          initials={avatarInitial(agent.displayName)}
          contentClassName={
            deleted ? DELETED_AGENT_AVATAR_CLASS : avatarToneClassName(agent.displayName)
          }
        />
        <div className="min-w-0 flex-1">
          <Heading slot="title" className="truncate text-sm font-semibold">
            {agent.displayName}
          </Heading>
          <p className="truncate text-xs text-tertiary">@{agent.name}</p>
        </div>
        {deleted ? (
          <DeletedAgentBadge />
        ) : (
          display && (
            <span className="flex items-center gap-1.5 text-xs text-tertiary">
              <StatusDot tone={view.tone} pulse={view.pulse} className="size-1.5" />
              {view.label}
            </span>
          )
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
                  <ClockTime
                    value={new Date(entry.observedAtMs)}
                    timeZone={timeZone}
                    plain
                    className="shrink-0 font-mono text-tertiary tabular-nums"
                  />
                  <StatusDot
                    tone={entry.recentTone}
                    pulse={entry.recentTone === "working" || entry.recentTone === "thinking"}
                    className="mt-1 size-1.5"
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
