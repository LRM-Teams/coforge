import { ChevronRight, Hash01 as Hash, Plus } from "@untitledui/icons";
import { useEffect, useId, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";

import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { AgentDisplayAvatar } from "@/features/agents/agent-activity-avatar";
import type { LiveAgent } from "@/features/agents/workspace-agents-realtime";
import { cx } from "@/utils/cx";
import { m } from "@/paraglide/messages";
import { useChannelUnreadCounts, useCloseConversationList } from "./conversation-navigation";
import {
  readCollapsedSections,
  writeCollapsedSections,
  type DirectorySectionId,
} from "./directory-sections";

type DirectoryChannel = {
  id: string;
  name: string;
  joined: boolean;
  /** The member muted this channel; its unread badge degrades to a bare dot. */
  muted?: boolean;
};

/** Slack-style badge: the count up to 99, then "99+". Hidden from AT by the row's label. */
export function UnreadBadge({ count }: { count: number }) {
  return (
    <span
      aria-hidden="true"
      className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-brand-solid px-1.5 text-xs font-semibold leading-none text-white tabular-nums"
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

/** The unread marker without a number: "there is something here", not "how much". Used where the
 * marker sits on an icon — a count on a small glyph is noise, and the sidebar keeps the numbers. */
export function UnreadDot() {
  return (
    <span aria-hidden="true" className="inline-flex size-2 shrink-0 rounded-full bg-brand-solid" />
  );
}

/** The row's accessible name: the conversation it names, plus its unread count when it has one. */
function rowLabel(unreadCount: number | undefined, label: string): string | undefined {
  if (!unreadCount) return undefined;
  return m.channel_unread_accessible({ channel: label, count: unreadCount });
}

// A local row (not NavItemBase — its `icon` slot hardcodes size-5 and can't
// take an Avatar) so channel and DM rows share one grid: 20px icon column,
// text starting at the same x, and the same current/hover treatment.
function ConversationRow({
  target,
  current,
  icon,
  muted,
  unreadCount,
  label,
  children,
}: {
  target: { channelId: string } | { agentId: string };
  current?: boolean;
  icon: ReactNode;
  muted?: boolean;
  unreadCount?: number;
  /** The row's own name, so an unread row keeps its accessible name instead of replacing it. */
  label: string;
  children: ReactNode;
}) {
  const closeList = useCloseConversationList();
  return (
    <Link
      {...("channelId" in target
        ? { to: "/messages/channels/$channelId", params: target }
        : { to: "/messages/$agentId", params: target })}
      aria-current={current ? "page" : undefined}
      aria-label={rowLabel(unreadCount, label)}
      // On mobile the list is a separate pane; choosing a row reveals the conversation even when
      // the URL is unchanged (re-opening the channel already in the address bar), which the
      // pathname-based reset in `ConversationNavigation` cannot see.
      onClick={closeList}
      className={cx(
        "flex max-h-9 w-full cursor-pointer items-center gap-2 rounded-md p-2 outline-focus-ring transition duration-100 ease-linear select-none focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-2",
        current ? "bg-sidebar-accent" : "hover:bg-primary_hover",
      )}
    >
      <span className="flex size-5 shrink-0 items-center justify-center">{icon}</span>
      <span
        className={cx(
          "min-w-0 flex-1 truncate text-sm",
          current
            ? "font-semibold text-brand-secondary"
            : muted
              ? "text-tertiary"
              : "text-secondary",
        )}
      >
        {children}
      </span>
      {unreadCount ? muted ? <UnreadDot /> : <UnreadBadge count={unreadCount} /> : null}
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
      {/* One unified hover surface for the whole header row: the row itself carries the
          `hover:bg-primary_hover` (like a channel/DM row), and the toggle and the trailing `+`
          are transparent so they never paint a second, differently-shaped highlight. They stay
          independent click targets. */}
      <div className="group/section flex items-center gap-1 rounded-md pr-2 pl-1 transition-colors duration-100 ease-linear hover:bg-primary_hover">
        {/* The whole caption row is the toggle. `size="sm"` gives it a ~36px tall target and
            `flex-1` fills the row width, so the hit area is large both ways (the user reported
            the old target was too small); `justify-start pl-0` keeps the caption's left edge on
            the same x the channel rows' icons use. */}
        <Button
          color="tertiary"
          size="sm"
          aria-expanded={expanded}
          aria-controls={listId}
          onPress={onToggle}
          className="min-w-0 flex-1 justify-start pr-2 pl-0 text-quaternary group-hover/section:text-tertiary hover:bg-transparent!"
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
  const unreadCounts = useChannelUnreadCounts();
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
                className="shrink-0 hover:bg-transparent!"
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
                    muted={!channel.joined || channel.muted}
                    unreadCount={unreadCounts[channel.id]}
                    label={`#${channel.name}`}
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
                  unreadCount={unreadCounts[agent.id]}
                  label={agent.displayName}
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
