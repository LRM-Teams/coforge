import { ChevronRight, Hash01 as Hash, Plus } from "@untitledui/icons";
import { useEffect, useId, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";

import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { AgentDisplayAvatar } from "@/features/agents/agent-activity-avatar";
import type { LiveAgent } from "@/features/agents/workspace-agents-realtime";
import { cx } from "@/utils/cx";
import { m } from "@/paraglide/messages";
import {
  readCollapsedSections,
  writeCollapsedSections,
  type DirectorySectionId,
} from "./directory-sections";

type DirectoryChannel = { id: string; name: string; joined: boolean };

// A local row (not NavItemBase — its `icon` slot hardcodes size-5 and can't
// take an Avatar) so channel and DM rows share one grid: 20px icon column,
// text starting at the same x, and the same current/hover treatment.
function ConversationRow({
  target,
  current,
  icon,
  muted,
  children,
}: {
  target: { channelId: string } | { agentId: string };
  current?: boolean;
  icon: ReactNode;
  muted?: boolean;
  children: ReactNode;
}) {
  return (
    <Link
      {...("channelId" in target
        ? { to: "/messages/channels/$channelId", params: target }
        : { to: "/messages/$agentId", params: target })}
      aria-current={current ? "page" : undefined}
      className={cx(
        "flex max-h-9 w-full cursor-pointer items-center gap-2 rounded-md p-2 outline-focus-ring transition duration-100 ease-linear select-none focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-2",
        current ? "bg-sidebar-accent" : "hover:bg-primary_hover",
      )}
    >
      <span className="flex size-5 shrink-0 items-center justify-center">{icon}</span>
      <span
        className={cx(
          "flex-1 truncate text-sm",
          current
            ? "font-semibold text-brand-secondary"
            : muted
              ? "text-tertiary"
              : "text-secondary",
        )}
      >
        {children}
      </span>
    </Link>
  );
}

/**
 * A collapsible sidebar group (CHANNELS, DIRECT MESSAGES). The caption itself is the toggle,
 * like Slack's sidebar sections; the chevron sits in a 20px gutter so the caption keeps the exact
 * x position it has without a toggle, and the list below stays aligned with it.
 */
function DirectorySection({
  label,
  expanded,
  onToggle,
  action,
  children,
}: {
  label: string;
  expanded: boolean;
  onToggle: () => void;
  /** Optional trailing control on the header row, e.g. a "+" that creates a channel. It sits
   * outside the toggle button so it is its own click target, not part of collapsing. */
  action?: ReactNode;
  children: ReactNode;
}) {
  const listId = useId();
  return (
    <>
      <div className="flex items-center gap-1 pr-2 pl-1">
        {/* The whole caption row is the toggle (`w-full`), so the click target spans the sidebar
            width like Slack's sections rather than just the short caption text. */}
        <Button
          color="tertiary"
          size="xs"
          aria-expanded={expanded}
          aria-controls={listId}
          onPress={onToggle}
          /* `justify-start px-1` lands the caption on the same x the rows' icons use while the
             button still fills the row for a large hit area. */
          className="w-full min-w-0 justify-start px-1 text-quaternary hover:text-tertiary"
          iconLeading={
            <ChevronRight
              aria-hidden="true"
              className={cx(
                "size-3.5 shrink-0 transition-transform duration-100 ease-linear",
                expanded && "rotate-90",
              )}
            />
          }
        >
          <span className="truncate text-[0.6875rem] tracking-wide uppercase">{label}</span>
        </Button>
        {action}
      </div>
      {/* Kept mounted but hidden: collapsing must not throw away the rows' realtime state. */}
      <div id={listId} hidden={!expanded}>
        {children}
      </div>
    </>
  );
}

/** Channel and direct-message selection within the Chat page. */
export function ConversationDirectory({
  channels,
  agents,
  selectedChannelId,
  selectedAgentId,
  onCreateChannel,
}: {
  channels: DirectoryChannel[];
  agents: LiveAgent[];
  selectedChannelId?: string;
  selectedAgentId?: string;
  /** Opens the create-channel flow from the "+" next to the CHANNELS caption. */
  onCreateChannel?: () => void;
}) {
  const sortedChannels = [...channels].sort((left, right) =>
    left.joined === right.joined ? 0 : left.joined ? -1 : 1,
  );
  /** Both groups start expanded so SSR and the first client render agree; the stored preference
   * is applied right after mount (`localStorage` is unavailable during SSR). */
  const [collapsed, setCollapsed] = useState<DirectorySectionId[]>([]);
  useEffect(() => setCollapsed(readCollapsedSections()), []);
  const toggle = (id: DirectorySectionId) =>
    setCollapsed((current) => {
      const next = current.includes(id)
        ? current.filter((entry) => entry !== id)
        : [...current, id];
      writeCollapsedSections(next);
      return next;
    });
  return (
    <>
      <div className="mt-2">
        <DirectorySection
          label={m.channels_title()}
          expanded={!collapsed.includes("channels")}
          onToggle={() => toggle("channels")}
          action={
            onCreateChannel ? (
              <ButtonUtility
                icon={Plus}
                size="xs"
                color="tertiary"
                tooltip={m.channel_create()}
                aria-label={m.channel_create()}
                onClick={onCreateChannel}
                className="shrink-0"
              />
            ) : undefined
          }
        >
          <ul aria-label={m.channels_title()} className="flex flex-col px-4">
            {sortedChannels.map((channel) => {
              const current = channel.id === selectedChannelId;
              return (
                <li key={channel.id} className="py-px">
                  <ConversationRow
                    target={{ channelId: channel.id }}
                    current={current}
                    muted={!channel.joined}
                    icon={
                      <Hash
                        aria-hidden="true"
                        className={cx("size-4", current ? "text-brand-secondary" : "text-tertiary")}
                      />
                    }
                  >
                    {channel.name}
                  </ConversationRow>
                </li>
              );
            })}
          </ul>
        </DirectorySection>
      </div>

      <div className="mt-4">
        <DirectorySection
          label={m.messages_agents_action()}
          expanded={!collapsed.includes("agents")}
          onToggle={() => toggle("agents")}
        >
          <ul aria-label={m.messages_agents_action()} className="flex flex-col px-4 pb-3">
            {agents.map((agent) => (
              <li key={agent.id} className="py-px">
                <ConversationRow
                  target={{ agentId: agent.id }}
                  current={agent.id === selectedAgentId}
                  icon={
                    <AgentDisplayAvatar
                      name={agent.displayName}
                      display={agent.display}
                      size="xs"
                    />
                  }
                >
                  {agent.displayName}
                </ConversationRow>
              </li>
            ))}
          </ul>
        </DirectorySection>
      </div>
    </>
  );
}
