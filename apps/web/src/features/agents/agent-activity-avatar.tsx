import { Avatar, type AvatarProps } from "#src/components/base/avatar/avatar";
import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";
import { StatusDot } from "#src/components/ui/status-dot";
import { avatarInitial, avatarToneClassName } from "#src/lib/avatar-tone";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { DELETED_AGENT_AVATAR_CLASS } from "./deleted-agent";
import { agentDisplay } from "./agent-activity-presentation";

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
  cornerDot = true,
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
  /** Draw the status dot on the avatar's corner. Off where the status already reads inline
   * beside the name (the DM header), so it is not shown twice. */
  cornerDot?: boolean;
}) {
  const view = agentDisplay(display, { stopped });
  return (
    <span
      role="img"
      aria-label={`${name}, ${deleted ? m.agent_deleted_badge() : view.label}`}
      className="relative flex shrink-0 rounded-[inherit]"
    >
      <Avatar
        size={size}
        alt=""
        src={src}
        initials={avatarInitial(name)}
        contentClassName={deleted ? DELETED_AGENT_AVATAR_CLASS : avatarToneClassName(name)}
      />
      {cornerDot && display && !deleted && (
        <StatusDot
          tone={view.tone}
          pulse={view.pulse}
          className={cn("absolute border-primary", displayDotClassName[size])}
        />
      )}
    </span>
  );
}

/** One face in an overlapping stack of Agents: no status dot, which the overlap would half cover. */
export function AgentStackFace({
  agent,
}: {
  agent: { displayName: string; avatarUrl?: string | null };
}) {
  return (
    <Avatar
      size="xs"
      alt=""
      src={agent.avatarUrl}
      initials={avatarInitial(agent.displayName)}
      contentClassName={avatarToneClassName(agent.displayName)}
      // The ring separates the overlapping faces, as an avatar group does.
      className="ring-2 ring-bg-primary"
    />
  );
}
