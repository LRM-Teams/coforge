import { BookmarkCheck, ChevronRight, Hash01 as Hash, Plus } from "@untitledui/icons";
import { useEffect, useId, useState, type DragEvent, type ReactNode } from "react";
import { Link, useRouter } from "@tanstack/react-router";
import { Link as AriaLink } from "react-aria-components";
import { useServerFn } from "@tanstack/react-start";

import { Avatar } from "#src/components/base/avatar/avatar";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { AgentDisplayAvatar } from "#src/features/agents/agent-activity-avatar";
import type { LiveAgent } from "#src/features/agents/workspace-agents-realtime";
import { RelativeTime } from "#src/components/ui/relative-time";
import { useAppToast } from "#src/components/ui/toast";
import type { SavedMessageView } from "#src/server/conversations/saved-messages.server";
import { cx } from "#src/utils/cx";
import { m } from "#src/paraglide/messages";
import {
  useChannelUnreadCounts,
  useCloseConversationList,
  useSavedMessages,
} from "./conversation-navigation";
import { savedJumpTarget } from "./saved-messages-model";
import { saveMessage, unsaveMessage } from "./saved-messages.functions";
import { MessageBody } from "./message-body";
import { savedDropPayload, SAVED_DRAG_MIME } from "./saved-drop-model";
import { ConversationRowMenu } from "./conversation-row-menu";
import { directRowPreference } from "./conversation-row-menu-model";
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
  /** The member pinned this row; it sorts above the rest and its menu item reads "Unpin". */
  pinned: boolean;
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
  target: { channelId: string } | { agentId: string } | { view: "saved" };
  current?: boolean;
  icon: ReactNode;
  muted?: boolean;
  unreadCount?: number;
  /** The row's own name, so an unread row keeps its accessible name instead of replacing it. */
  label: string;
  children: ReactNode;
}) {
  const closeList = useCloseConversationList();
  const router = useRouter();
  const route =
    "channelId" in target
      ? ({ to: "/messages/channels/$channelId", params: target } as const)
      : "agentId" in target
        ? ({ to: "/messages/$agentId", params: target } as const)
        : ({ to: "/messages/saved" } as const);
  return (
    // The row is a React Aria link so the conversation menu's `MenuTrigger trigger="contextMenu"`
    // can use it as its trigger; `render` hands the element to TanStack's `Link`, which owns
    // navigation (React Aria's documented client-side routing pattern, react-aria.adobe.com/Link).
    <AriaLink
      href={router.buildLocation(route).href}
      // `href` is always set, so React Aria renders an `<a>`; the check narrows the props type.
      render={(props) => ("href" in props ? <Link {...props} {...route} /> : <span {...props} />)}
      aria-current={current ? "page" : undefined}
      aria-label={rowLabel(unreadCount, label)}
      // On mobile the list is a separate pane; choosing a row reveals the conversation even when
      // the URL is unchanged (re-opening the channel already in the address bar), which the
      // pathname-based reset in `ConversationNavigation` cannot see.
      onPress={closeList}
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
  selectedSaved: _selectedSaved,
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
  /** The Saved view is open — kept for call-site stability; the section never reads as
   * "current" because it spans conversations. */
  selectedSaved?: boolean;
  /** Opens the create-channel flow from the "+" next to the CHANNELS caption. */
  onCreateChannel?: () => void;
}) {
  const unreadCounts = useChannelUnreadCounts();
  const sortedChannels = [...channels].sort((left, right) =>
    left.joined === right.joined ? 0 : left.joined ? -1 : 1,
  );
  /** Closed DMs leave the list; pinned ones come first, in the order the member arranged them,
   * then the Agent list's own order (the server owns both facts, this only reads them). */
  const sortedAgents = agents
    .map((agent) => ({ agent, preference: directRowPreference(directPreferences, agent.id) }))
    .filter(({ preference }) => !preference.hidden)
    .sort((left, right) =>
      left.preference.pinned || right.preference.pinned
        ? Number(right.preference.pinned) - Number(left.preference.pinned) ||
          (left.preference.sortOrder ?? 0) - (right.preference.sortOrder ?? 0)
        : 0,
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
      <SavedDirectorySection
        collapsed={collapsed.includes("saved")}
        onToggle={() => toggle("saved")}
      />
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
                <ConversationRowMenu key={channel.id} target={{ kind: "channel", ...channel }}>
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
            {sortedAgents.map(({ agent, preference }) => (
              <ConversationRowMenu
                key={agent.id}
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
            ))}
          </ul>
        </DirectorySection>
      </div>
    </>
  );
}

/**
 * The SAVED section (#127, the boss's 2026-09-23 ruling): a dedicated sidebar group like CHANNELS,
 * not the old single entry. One row per bookmarked message — the sender's avatar and name with the
 * time and a clamped body excerpt, no group label (the boss's ruling: "不用显示群，要显示头像和
 * username") — and the row jumps to the message's position in its conversation (the same jump the
 * Saved view's cards use). The whole section is the drop target: dragging a message row's avatar
 * here bookmarks it; the per-row bookmark unsaves. The Saved detail view stays reachable at
 * `/messages/saved` for deep links; the section is the primary surface.
 */
function SavedDirectorySection({
  collapsed,
  onToggle,
}: {
  collapsed: boolean;
  onToggle: () => void;
}) {
  const saved = useSavedMessages();
  const router = useRouter();
  const closeList = useCloseConversationList();
  const unsave = useServerFn(unsaveMessage);
  const save = useServerFn(saveMessage);
  const toast = useAppToast();
  const entries = saved?.entries ?? [];
  const [dropActive, setDropActive] = useState(false);

  /** Accepts a dragged message row's payload; a foreign drag is ignored in place. */
  async function onDrop(event: DragEvent<HTMLUListElement>) {
    event.preventDefault();
    setDropActive(false);
    const payload = savedDropPayload(event.dataTransfer.getData(SAVED_DRAG_MIME));
    if (!payload) return;
    try {
      await save({ data: payload });
      await saved?.refresh();
    } catch (cause) {
      console.error("drop-to-save failed", cause);
      toast.error(m.conversation_save_failed());
    }
  }

  return (
    <div className="mt-2">
      <DirectorySection
        label={m.conversation_saved_nav()}
        expanded={!collapsed}
        onToggle={onToggle}
        action={
          entries.length ? (
            <span aria-hidden="true" className="mr-1 text-xs tabular-nums text-quaternary">
              {entries.length}
            </span>
          ) : undefined
        }
      >
        <ul
          aria-label={m.conversation_saved_nav()}
          className={cx(
            "mx-2 flex flex-col rounded-lg",
            dropActive && "outline-2 outline-dashed outline-brand/50",
          )}
          onDragOver={(event) => {
            if (!event.dataTransfer.types.includes(SAVED_DRAG_MIME)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
            setDropActive(true);
          }}
          onDragLeave={() => setDropActive(false)}
          onDrop={(event) => void onDrop(event)}
        >
          {entries.length === 0 ? (
            <li
              aria-hidden="true"
              className="mx-1 my-1 rounded-md px-2 py-2 text-xs leading-5 text-quaternary"
            >
              {m.conversation_saved_drop_hint()}
            </li>
          ) : (
            entries.map((entry) => (
              <SavedMessageRow
                key={entry.message.id}
                entry={entry}
                onUnsave={unsave}
                onSavedRefresh={saved}
                router={router}
                closeList={closeList}
                toast={toast}
              />
            ))
          )}
        </ul>
      </DirectorySection>
    </div>
  );
}

/** One bookmarked message as a sidebar row: the sender's avatar and name, the time, and a clamped
 * body excerpt. The whole row jumps to the message's position; the trailing bookmark unsaves. */
function SavedMessageRow({
  entry,
  onUnsave,
  onSavedRefresh,
  router,
  closeList,
  toast,
}: {
  entry: SavedMessageView;
  onUnsave: ReturnType<typeof useServerFn<typeof unsaveMessage>>;
  onSavedRefresh: ReturnType<typeof useSavedMessages>;
  router: ReturnType<typeof useRouter>;
  closeList: () => void;
  toast: ReturnType<typeof useAppToast>;
}) {
  const jump = savedJumpTarget(entry.conversation, entry.message);
  const jumpProps =
    jump.to === "/messages/channels/$channelId"
      ? { to: jump.to, params: jump.params, search: jump.search }
      : jump.to === "/messages/$agentId"
        ? { to: jump.to, params: jump.params, search: jump.search }
        : { to: jump.to };
  return (
    <li className="group/saved-row relative">
      <AriaLink
        href={router.buildLocation(jumpProps).href}
        render={(props) =>
          "href" in props ? <Link {...props} {...jumpProps} /> : <span {...props} />
        }
        onPress={closeList}
        className="flex min-w-0 items-start gap-2 rounded-md px-2 py-1.5 outline-focus-ring focus-visible:outline-2 focus-visible:outline-offset-2 hover:bg-primary_hover"
      >
        <Avatar
          size="xs"
          src={entry.message.senderAvatarUrl ?? null}
          alt={entry.message.senderName}
          className="mt-0.5 shrink-0"
        />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-sm font-medium text-secondary">
              {entry.message.senderName}
            </span>
            <RelativeTime value={entry.message.createdAt} />
          </span>
          {entry.message.body ? (
            <span className="mt-0.5 line-clamp-2 text-xs leading-4 text-tertiary [&_p]:my-0">
              <MessageBody body={entry.message.body} mentions={entry.message.mentions} />
            </span>
          ) : entry.message.attachments[0] ? (
            <span className="mt-0.5 truncate text-xs text-quaternary">
              {entry.message.attachments[0].fileName}
            </span>
          ) : null}
        </span>
      </AriaLink>
      <ButtonUtility
        icon={BookmarkCheck}
        size="xs"
        color="tertiary"
        tooltip={m.conversation_unsave()}
        aria-label={m.conversation_unsave()}
        onClick={() => {
          void onUnsave({
            data: { conversationId: entry.conversation.id, messageId: entry.message.id },
          })
            .then(() => onSavedRefresh?.refresh())
            .catch(() => toast.error(m.conversation_save_failed()));
        }}
        className="absolute top-1 right-2 shrink-0 opacity-0 transition-opacity group-hover/saved-row:opacity-100"
      />
    </li>
  );
}
