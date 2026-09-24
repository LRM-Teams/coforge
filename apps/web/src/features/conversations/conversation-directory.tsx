import { Bookmark, ChevronRight, Hash01 as Hash, Plus } from "@untitledui/icons";
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { Link, useRouter } from "@tanstack/react-router";
import { DndContext } from "@dnd-kit/core";
import { Link as AriaLink } from "react-aria-components";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { useAppToast } from "#src/components/ui/toast";
import { AgentDisplayAvatar } from "#src/features/agents/agent-activity-avatar";
import type { LiveAgent } from "#src/features/agents/workspace-agents-realtime";
import { cx } from "#src/utils/cx";
import { m } from "#src/paraglide/messages";
import {
  useChannelUnreadCounts,
  useCloseConversationList,
  useSavedEntries,
} from "./conversation-navigation";
import { ConversationRowMenu } from "./conversation-row-menu";
import { conversationRowMenuEnabled, directRowPreference } from "./conversation-row-menu-model";
import { useSidebarActions } from "./sidebar-lists";
import { DirectoryDragRow, DirectoryDropList, useDirectoryDrag } from "./directory-drag";
import {
  channelRowKey,
  directRowKey,
  splitPinnedConversations,
  type DirectoryLayout,
} from "./pinned-conversations";
import { conversationRoute, type ConversationTarget } from "./last-conversation";
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
  /** The member pinned this row; it moves to the Pinned section and its menu item reads "Unpin". */
  pinned: boolean;
  /** Where the row sits in the Pinned section, among the member's pinned channels and DMs. */
  pinSortOrder: number | null;
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
  count,
  label,
  children,
}: {
  target: ConversationTarget;
  current?: boolean;
  icon: ReactNode;
  muted?: boolean;
  unreadCount?: number;
  /** A plain total shown at the row's end (the Saved entry's bookmark count), not an unread
   * signal: muted, and absent at zero. `label` is how the row's accessible name says it. */
  count?: { value: number; label: string };
  /** The row's own name, so an unread row keeps its accessible name instead of replacing it. */
  label: string;
  children: ReactNode;
}) {
  const closeList = useCloseConversationList();
  const router = useRouter();
  const route = conversationRoute(target);
  return (
    // The row is a React Aria link so the conversation menu's `MenuTrigger trigger="contextMenu"`
    // can use it as its trigger; `render` hands the element to TanStack's `Link`, which owns
    // navigation (React Aria's documented client-side routing pattern, react-aria.adobe.com/Link).
    <AriaLink
      href={router.buildLocation(route).href}
      // `href` is always set, so React Aria renders an `<a>`; the check narrows the props type.
      render={(props) => ("href" in props ? <Link {...props} {...route} /> : <span {...props} />)}
      aria-current={current ? "page" : undefined}
      aria-label={rowLabel(unreadCount, label) ?? (count ? `${label}, ${count.label}` : undefined)}
      // On mobile the list is a separate pane; choosing a row reveals the conversation even when
      // the URL is unchanged (re-opening the channel already in the address bar), which the
      // pathname-based reset in `ConversationNavigation` cannot see.
      onPress={closeList}
      className={cx(
        // `-webkit-user-drag: none`: a sidebar drag moves the row (see `directory-drag.tsx`), never
        // the browser's own link drag.
        "flex max-h-9 w-full cursor-pointer items-center gap-2 rounded-md p-2 outline-focus-ring transition duration-100 ease-linear select-none [-webkit-user-drag:none] focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-2",
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
      {count ? (
        <span aria-hidden="true" className="shrink-0 text-xs text-quaternary tabular-nums">
          {count.value}
        </span>
      ) : null}
    </AriaLink>
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
  directPreferences,
  selectedChannelId,
  selectedAgentId,
  selectedSaved,
  onCreateChannel,
}: {
  channels: DirectoryChannel[];
  agents: LiveAgent[];
  /** The viewer's own DM preferences (P2b, #708): which Agent rows are conversations, which are
   * pinned (and in what order), and which are closed. DM rows come from the Agent list, so this is
   * the only thing that can tell them apart. */
  directPreferences: {
    conversations: readonly string[];
    pinned: readonly { agentId: string; sortOrder: number }[];
    hidden: readonly string[];
  };
  selectedChannelId?: string;
  selectedAgentId?: string;
  /** The Saved view is open — its sidebar entry renders as the current row. */
  selectedSaved?: boolean;
  /** Opens the create-channel flow from the "+" next to the CHANNELS caption. */
  onCreateChannel?: () => void;
}) {
  const unreadCounts = useChannelUnreadCounts();
  const savedCount = useSavedEntries()?.length;
  // Derived once per list change, not per render: the drag reads `base` and `natural` on every
  // pointer move.
  const { sortedChannels, directRows, base, natural } = useMemo(() => {
    const sortedChannels = [...channels].sort((left, right) =>
      left.joined === right.joined ? 0 : left.joined ? -1 : 1,
    );
    /** DM rows in the Agent list's own order; a closed one is left out of its section by the
     * split. */
    const directRows = agents.map((agent) => ({
      agent,
      preference: directRowPreference(directPreferences, agent.id),
    }));
    const sections = splitPinnedConversations(sortedChannels, directRows);
    const base: DirectoryLayout = {
      pinned: sections.pinned.map((entry) =>
        entry.kind === "channel" ? channelRowKey(entry.id) : directRowKey(entry.id),
      ),
      channels: sections.channels.map((channel) => channelRowKey(channel.id)),
      agents: sections.directs.map(({ agent }) => directRowKey(agent.id)),
    };
    /** Where a row returns to when it is dragged out of Pinned: its list's own order. A closed DM
     * that is still pinned is included so it can be seen while it is dragged. */
    const natural = {
      channels: sortedChannels.map((channel) => channelRowKey(channel.id)),
      agents: directRows
        .filter(({ preference }) => preference.pinned || !preference.hidden)
        .map(({ agent }) => directRowKey(agent.id)),
    };
    return { sortedChannels, directRows, base, natural };
  }, [channels, agents, directPreferences]);
  const toast = useAppToast();
  const actions = useSidebarActions();
  const drag = useDirectoryDrag({
    layout: base,
    natural,
    commit: (change) => {
      const saved = actions?.arrange(change).isPersisted.promise ?? Promise.resolve();
      return saved.catch((cause: unknown) => {
        console.error("pinned conversations could not be saved", cause);
        toast.error(m.conversation_menu_action_error());
      });
    },
  });
  /** All groups start expanded so SSR and the first client render agree; the stored preference
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

  const channelRow = (channel: DirectoryChannel) => {
    const current = channel.id === selectedChannelId;
    return (
      <ConversationRowMenu target={{ kind: "channel", ...channel }}>
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
      </ConversationRowMenu>
    );
  };
  const directRow = ({ agent, preference }: (typeof directRows)[number]) => (
    <ConversationRowMenu
      target={{
        kind: "direct",
        agentId: agent.id,
        enabled: preference.enabled,
        pinned: preference.pinned,
      }}
    >
      <ConversationRow
        target={{ agentId: agent.id }}
        current={agent.id === selectedAgentId}
        unreadCount={unreadCounts[agent.id]}
        label={agent.displayName}
        icon={
          <AgentDisplayAvatar
            name={agent.displayName}
            src={agent.avatarUrl}
            display={agent.display}
            size="xs"
          />
        }
      >
        {agent.displayName}
      </ConversationRow>
    </ConversationRowMenu>
  );
  /** Every row by key, with whether it can be pinned (only a conversation the member is in). */
  const rows = new Map<string, { node: ReactNode; draggable: boolean }>([
    ...sortedChannels.map(
      (channel) =>
        [
          channelRowKey(channel.id),
          { node: channelRow(channel), draggable: conversationRowMenuEnabled(channel) },
        ] as const,
    ),
    ...directRows.map(
      (row) =>
        [
          directRowKey(row.agent.id),
          { node: directRow(row), draggable: row.preference.enabled },
        ] as const,
    ),
  ]);
  const list = (section: DirectorySectionId) =>
    drag.layout[section].map((key) => {
      const row = rows.get(key);
      if (!row) return null;
      return (
        <DirectoryDragRow key={key} id={key} section={section} disabled={!row.draggable}>
          {row.node}
        </DirectoryDragRow>
      );
    });
  const pinnedEmpty = drag.layout.pinned.length === 0;

  return (
    <DndContext {...drag.context}>
      <div className="mt-2 px-4">
        <ConversationRow
          target={{ view: "saved" }}
          current={selectedSaved}
          count={
            savedCount
              ? { value: savedCount, label: m.conversation_saved_count({ count: savedCount }) }
              : undefined
          }
          label={m.conversation_saved_nav()}
          icon={
            <Bookmark
              aria-hidden="true"
              className={cx("size-4", selectedSaved ? "text-brand-secondary" : "text-tertiary")}
            />
          }
        >
          {m.conversation_saved_nav()}
        </ConversationRow>
      </div>
      {/* Pinned channels and DMs, together and in the order they were pinned. Empty, it shows
          where to drop a row; a device without a mouse cannot drag, so it leaves it out there
          (its rows pin from their long-press menu). */}
      <div className={cx("mt-2", pinnedEmpty && "hidden any-pointer-fine:block")}>
        <DirectorySection
          label={m.conversation_pinned_section()}
          expanded={!collapsed.includes("pinned")}
          onToggle={() => toggle("pinned")}
        >
          <div className="px-4">
            <DirectoryDropList
              section="pinned"
              keys={drag.layout.pinned}
              label={m.conversation_pinned_section()}
            >
              {pinnedEmpty ? (
                <li className="flex min-h-9 items-center px-2 text-xs text-quaternary">
                  {m.conversation_pinned_empty_hint()}
                </li>
              ) : (
                list("pinned")
              )}
            </DirectoryDropList>
          </div>
        </DirectorySection>
      </div>
      <div className="mt-4">
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
          <div className="px-4">
            <DirectoryDropList
              section="channels"
              keys={drag.layout.channels}
              label={m.channels_title()}
            >
              {list("channels")}
            </DirectoryDropList>
          </div>
        </DirectorySection>
      </div>

      <div className="mt-4">
        <DirectorySection
          label={m.messages_agents_action()}
          expanded={!collapsed.includes("agents")}
          onToggle={() => toggle("agents")}
        >
          <div className="px-4 pb-3">
            <DirectoryDropList
              section="agents"
              keys={drag.layout.agents}
              label={m.messages_agents_action()}
            >
              {list("agents")}
            </DirectoryDropList>
          </div>
        </DirectorySection>
      </div>
    </DndContext>
  );
}
