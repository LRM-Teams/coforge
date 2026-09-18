import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import { useStateWithRef } from "@/hooks/use-state-with-ref";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { measureElement, observeElementRect, useVirtualizer } from "@tanstack/react-virtual";
import { ClientOnly, getRouteApi } from "@tanstack/react-router";
import {
  ArrowDown,
  ArrowLeft,
  DotsHorizontal,
  MessageSquare01 as MessageSquare,
} from "@untitledui/icons";
import type { TaskView } from "@lrm/coforge-sdk/internal";

import { ConversationTaskTabs } from "@/features/tasks/conversation-task-tabs";
import { useAgentRecentActivity, useLiveAgent } from "@/features/agents/workspace-agents-realtime";
import { conversationLayoutStorage } from "@/features/conversations/layout-storage";
import { AgentActivityAvatar } from "@/features/agents/agent-activity-avatar";
import { agentDisplay } from "@/features/agents/agent-activity-presentation";
import { Avatar } from "@/components/base/avatar/avatar";
import { avatarInitial, avatarToneClassName } from "@/lib/avatar-tone";
import { DELETED_AGENT_AVATAR_CLASS, DeletedAgentBadge } from "@/features/agents/deleted-agent";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { ConversationListButton, useConversationDetailVisible } from "./conversation-navigation";
import { ConversationPending } from "./conversation-pending";
import { useBreakpoint } from "@/hooks/use-breakpoint";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";
import { RelativeTime } from "@/components/ui/relative-time";
import { Dropdown } from "@/components/base/dropdown/dropdown";
import { useAppToast } from "@/components/ui/toast";
import { MessageComposer } from "./message-composer";
import { MessageBody } from "./message-body";
import { makeMentionBodyFormatter, type Mentionable } from "./mention-text";
import { AttachmentCard, MessageRow, clockLabel, groupsWithPrevious } from "./message-row";
import {
  OwnMessagesMenu,
  useOwnMessagesIndex,
  type OwnMessageIndexEntry,
} from "./own-messages-menu";
import { cn } from "@/lib/utils";
import { TaskBadge } from "@/features/tasks/task-board";
import { m } from "@/paraglide/messages";
import { getLocale } from "@/paraglide/runtime";
import { AgentProfilePanel } from "@/features/agents/profile-panel/agent-profile-panel";
import { resolveVisibleConversationSlot } from "@/features/agents/profile-panel/profile-panel-slot";
import type { AgentProfileTab } from "@/features/agents/profile-panel/profile-panel-search";

const appRoute = getRouteApi("/_app");

const observeConversationRect: typeof observeElementRect = (instance, callback) =>
  observeElementRect(instance, (rect) =>
    callback(rect.height === 0 ? { ...rect, height: 800 } : rect),
  );
/**
 * A row can report a height of 0 while it is not laid out: the conversation sits in a hidden
 * branch, or a ResizeObserver delivers the row mid-reflow. Feeding that 0 through would tell the
 * virtualizer the row takes no space, so it falls back to a size. The estimate is only a safe
 * fallback for a row that has never been measured; using it for a row we *have* measured
 * replaces a true height (a wrapped Markdown body is easily 200px) with 160px, and the next
 * row's absolute offset then lands on top of this row's last lines — visible as messages
 * painting over each other, with the lower row's hover background clipping the text above it.
 * So keep the size already measured for this row and let the next real observation update it.
 */
const measureConversationElement: typeof measureElement = (element, entry, instance) => {
  const measured = measureElement(element, entry, instance);
  if (measured > 0) return measured;
  const key = instance.options.getItemKey(instance.indexFromElement(element));
  return instance.itemSizeCache.get(key) ?? instance.options.estimateSize(0);
};

export type DirectConversationView = {
  conversationId: string;
  senderMemberId: string;
  threadReadThrough?: Record<string, number>;
  hasOlder?: boolean;
  hasNewer?: boolean;
  agent: { id: string; name: string; displayName: string; deletedAt?: Date | null };
  /** The viewing user's `@handle`; powers the stronger "mentioned me" chip. Channels only. */
  viewerHandle?: string;
  /** The composer's @-completion source: every active member's public handle. Channels only. */
  mentionables?: Mentionable[];
  messages: Array<{
    id: string;
    sequence: number;
    threadRootId?: string;
    senderKind: "user" | "agent" | "system";
    senderMemberId?: string | null;
    senderName: string;
    /** The handle behind `senderName`: what you type to mention this sender. Absent for a
     * server-authored message. */
    senderHandle?: string;
    senderAgentId?: string;
    /** True when the sending Agent has since been deleted (ADR 0044). */
    senderDeleted?: boolean;
    senderAvatarUrl?: string | null;
    body: string;
    createdAt: Date | string;
    /** Resolved mention rows for the body's embedded `<@kind:uuid>` tokens (channels only). */
    mentions?: {
      kind: "user" | "agent";
      actorId: string;
      handle: string;
      label: string;
    }[];
    /** Always present, possibly empty; order matches send/upload order. */
    attachments: {
      id: string;
      fileName: string;
      contentType: string;
      sizeBytes: number;
      previewUrl?: string;
    }[];
  }>;
};

export type { OwnMessageIndexEntry };

type ConversationProps = {
  conversation: DirectConversationView;
  agentStatus?: "active" | "inactive";
  onSend: (
    body: string,
    requestId: string,
    attachmentIds?: string[],
    threadRootId?: string,
  ) => Promise<OwnMessageIndexEntry | void>;
  onLoadOlder?: () => Promise<void>;
  onLoadOwnMessages?: (beforeSequence?: number) => Promise<{
    messages: OwnMessageIndexEntry[];
    hasOlder: boolean;
  }>;
  onLoadMessageAround?: (messageId: string) => Promise<void>;
  onShowLatest?: () => Promise<void>;
  onReadThread?: (rootMessageId: string, throughSequence: number) => Promise<void>;
  tasks?: TaskView[];
  onCreateTask?: (title: string, requestId: string, attachmentId?: string) => Promise<void>;
  onShowTasks?: () => void;
  /** Opens the Agent profile panel from an Agent sender's avatar/name; absent where the
   * conversation route does not own that slot. See `features/agents/profile-panel/`. */
  onOpenAgentProfile?: (agentId: string) => void;
  /** The Agent profile panel's URL state, owned by the route (`profile`/`agentTab` search
   * params via `features/agents/profile-panel/`), not by this feature. `agentId` undefined means
   * the panel is closed. */
  agentProfile?: { agentId: string | undefined; tab: AgentProfileTab | undefined };
  onAgentProfileTabChange?: (tab: AgentProfileTab) => void;
  onCloseAgentProfile?: () => void;
};

export type ThreadedConversationProps = Omit<ConversationProps, "conversation" | "agentStatus"> & {
  conversation: Omit<DirectConversationView, "agent">;
  header: React.ReactNode;
  readOnlyNotice?: React.ReactNode;
  emptyState: { title: string; description: string; media: React.ReactNode };
  threadHeaderAction?: (rootMessageId: string) => React.ReactNode;
};

export function DirectConversationHeader({
  conversation,
  tasks,
  active,
  onShowChat,
  onShowTasks,
  onOpenAgentProfile,
}: {
  conversation: DirectConversationView;
  tasks?: TaskView[];
  active: "chat" | "tasks";
  onShowChat?: () => void;
  onShowTasks?: () => void;
  /** Opens the Agent profile panel from this DM's own Agent identity. */
  onOpenAgentProfile?: (agentId: string) => void;
}) {
  const activity = useAgentRecentActivity(conversation.agent.id);
  const display = useLiveAgent(conversation.agent.id)?.display;
  const timeZone = appRoute.useLoaderData().timeZone;
  const displayLabel = agentDisplay(display).label;
  // ADR 0044: a deleted Agent's DM stays readable, but offers no profile and no new messages.
  const deleted = Boolean(conversation.agent.deletedAt);
  const openProfile =
    onOpenAgentProfile && !deleted ? () => onOpenAgentProfile(conversation.agent.id) : undefined;
  return (
    <header className="shrink-0 border-b border-secondary px-3 sm:px-5">
      <div className="-mx-3 flex h-12 items-center gap-2 border-b border-secondary px-3 sm:-mx-5 sm:gap-3 sm:px-5">
        <ConversationListButton />
        <AgentActivityAvatar
          agent={conversation.agent}
          size="sm"
          display={display}
          deleted={deleted}
          timeZone={timeZone}
          onPress={openProfile}
          {...activity}
        />
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            {openProfile ? (
              <Button
                color="tertiary"
                noTextPadding
                onPress={openProfile}
                aria-label={m.agent_open_profile({ name: conversation.agent.displayName })}
                className="h-auto min-w-0 max-w-full rounded p-0 text-base font-semibold text-primary hover:bg-transparent hover:text-primary hover:underline"
              >
                <h1 className="truncate">{conversation.agent.displayName}</h1>
              </Button>
            ) : (
              <h1 className="truncate text-base font-semibold">{conversation.agent.displayName}</h1>
            )}
            {deleted && <DeletedAgentBadge />}
          </div>
          {/* A deleted Agent has no live status to report, so the header states the delete instead
              of the generic "Status unknown" an absent display would otherwise produce. */}
          {!deleted && (
            <p role="status" className="truncate text-xs text-tertiary">
              {displayLabel}
            </p>
          )}
        </div>
        <span className="hidden shrink-0 text-sm text-tertiary sm:block">
          @{conversation.agent.name}
        </span>
      </div>
      {(onShowChat || onShowTasks) && (
        <div className="-mx-3 flex h-11 items-center px-3 sm:-mx-5 sm:px-5">
          <ConversationTaskTabs
            active={active}
            taskCount={tasks?.length ?? 0}
            onShowChat={onShowChat}
            onShowTasks={onShowTasks}
          />
        </div>
      )}
    </header>
  );
}

export function DirectConversation(props: ConversationProps) {
  const { conversation } = props;
  // ADR 0044: a deleted Agent's DM stays readable, but nothing new can be sent to it.
  const deleted = Boolean(conversation.agent.deletedAt);
  return (
    <ThreadedConversation
      {...props}
      header={
        <DirectConversationHeader
          conversation={conversation}
          tasks={props.tasks}
          active="chat"
          onShowTasks={props.onShowTasks}
          onOpenAgentProfile={props.onOpenAgentProfile}
        />
      }
      readOnlyNotice={
        deleted ? (
          <div className="mx-4 mb-4 rounded-lg border border-secondary bg-secondary p-4 md:mx-6 md:mb-6">
            <p className="text-sm text-tertiary">{m.agent_deleted_conversation_notice()}</p>
          </div>
        ) : undefined
      }
      emptyState={{
        title: m.conversation_empty_title({ name: conversation.agent.displayName }),
        description: m.conversation_empty_description(),
        media: (
          <Avatar
            size="2xl"
            alt={conversation.agent.displayName}
            initials={avatarInitial(conversation.agent.displayName)}
            contentClassName={avatarToneClassName(conversation.agent.displayName)}
            className="ring-1 ring-secondary"
          />
        ),
      }}
    />
  );
}

export function ThreadedConversation(props: ThreadedConversationProps) {
  // Persisted panel sizes use localStorage; mount that UI only after hydration.
  return (
    <ClientOnly fallback={<ConversationPending />}>
      <ThreadedConversationContent {...props} />
    </ClientOnly>
  );
}

function ThreadedConversationContent(props: ThreadedConversationProps) {
  const {
    conversation,
    onReadThread,
    header,
    threadHeaderAction,
    agentProfile,
    onAgentProfileTabChange,
    onCloseAgentProfile,
    ...conversationProps
  } = props;
  const detailVisible = useConversationDetailVisible();
  const [selected, setSelected] = useState<string>();
  const [visited, setVisited] = useState<string[]>([]);
  const [readThrough, setReadThrough] = useState<Record<string, number>>({});
  const reading = useRef(false);
  const mainMessages = useMemo(
    () => conversation.messages.filter((message) => !message.threadRootId),
    [conversation.messages],
  );
  // Replies grouped once per message list, instead of a filter per rendered root.
  const repliesByRoot = useMemo(() => {
    const byRoot = new Map<string, DirectConversationView["messages"]>();
    for (const message of conversation.messages) {
      if (!message.threadRootId) continue;
      const replies = byRoot.get(message.threadRootId);
      if (replies) replies.push(message);
      else byRoot.set(message.threadRootId, [message]);
    }
    return byRoot;
  }, [conversation.messages]);
  const repliesOf = (rootId: string) => repliesByRoot.get(rootId) ?? [];
  const selectedSequence = selected ? (repliesOf(selected).at(-1)?.sequence ?? 0) : 0;

  // The conversation's shared right-hand slot: Thread (React state, above) and the Agent profile
  // panel (URL state, `agentProfile`) can both be "open" at once; whichever was opened most
  // recently is shown, the other keeps its own state. `lastOpened` only tracks fresh open actions
  // (`openThread` below, and a `profileAgentId` transition into "open"), not every re-render.
  const profileAgentId = agentProfile?.agentId;
  const [lastOpened, setLastOpened] = useState<"thread" | "profile">();
  const previousProfileAgentIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (profileAgentId && profileAgentId !== previousProfileAgentIdRef.current) {
      setLastOpened("profile");
    }
    previousProfileAgentIdRef.current = profileAgentId;
  }, [profileAgentId]);
  const visibleSlot = resolveVisibleConversationSlot({
    threadOpen: Boolean(selected),
    profileOpen: Boolean(profileAgentId),
    lastOpened,
  });
  const threadPaneVisible = (rootId: string) => visibleSlot === "thread" && selected === rootId;
  // The thread/profile pane's share of the width is the user's to set; remembered across visits,
  // and kept separate per slot (`react-resizable-panels` derives its storage key from `panelIds`,
  // so ["main","thread"] and ["main","profile"] never share or corrupt each other's saved size).
  const threadLayout = useDefaultLayout({
    id: "coforge-conversation",
    panelIds: visibleSlot ? ["main", visibleSlot] : ["main"],
    onlySaveAfterUserInteractions: true,
    storage: conversationLayoutStorage,
  });
  // Panels are flex items sized by the library's inline styles, so a narrow viewport cannot
  // collapse the split with CSS; unmount the resizable Group and stack full-width panes
  // instead. Both panes stay mounted so drafts and scroll survive, matching the desktop slot.
  const wideViewport = useBreakpoint("md");
  useEffect(() => {
    if (
      !detailVisible ||
      !selected ||
      !selectedSequence ||
      reading.current ||
      document.visibilityState === "hidden"
    )
      return;
    const boundary = Math.max(
      readThrough[selected] ?? 0,
      conversation.threadReadThrough?.[selected] ?? 0,
    );
    if (selectedSequence <= boundary) return;
    reading.current = true;
    void (onReadThread?.(selected, selectedSequence) ?? Promise.resolve())
      .then(() => {
        setReadThrough((previous) => ({
          ...previous,
          [selected]: selectedSequence,
        }));
      })
      .catch(() => {
        // Leave unread intact; the next poll can retry the read acknowledgement.
      })
      .finally(() => {
        reading.current = false;
      });
  }, [detailVisible, selected, selectedSequence, conversation, onReadThread, readThrough]);

  function openThread(rootMessageId: string) {
    setVisited((previous) =>
      previous.includes(rootMessageId) ? previous : [...previous, rootMessageId],
    );
    setSelected(rootMessageId);
    setLastOpened("thread");
  }
  useLayoutEffect(() => {
    const openAnchoredThread = () => {
      const rootMessageId = anchoredThreadRoot(conversation.messages);
      if (!rootMessageId || rootMessageId === selected) return;
      setVisited((previous) =>
        previous.includes(rootMessageId) ? previous : [...previous, rootMessageId],
      );
      setSelected(rootMessageId);
      setLastOpened("thread");
    };
    window.addEventListener("hashchange", openAnchoredThread);
    openAnchoredThread();
    return () => window.removeEventListener("hashchange", openAnchoredThread);
  }, [conversation.messages, selected]);
  const conversationMainPane = (
    <ConversationPane
      {...conversationProps}
      header={header}
      conversation={{ ...conversation, messages: mainMessages }}
      threadEntry={(message) => {
        const replies = repliesOf(message.id);
        const boundary = Math.max(
          readThrough[message.id] ?? 0,
          conversation.threadReadThrough?.[message.id] ?? 0,
        );
        const unread = replies.filter(
          (reply) => reply.senderKind === "agent" && reply.sequence > boundary,
        ).length;
        const label = m.conversation_thread_reply();
        const accessibleLabel = unread
          ? `${label} · ${m.conversation_thread_unread({ count: unread })}`
          : label;
        return (
          <span className="relative inline-flex">
            <Dropdown.Root>
              <ButtonUtility
                icon={DotsHorizontal}
                size="sm"
                color="tertiary"
                aria-label={m.conversation_message_actions()}
              />
              <Dropdown.Popover placement="bottom end">
                <Dropdown.Menu>
                  <Dropdown.Item
                    id="reply"
                    label={accessibleLabel}
                    icon={MessageSquare}
                    onAction={() => openThread(message.id)}
                  />
                </Dropdown.Menu>
              </Dropdown.Popover>
            </Dropdown.Root>
            {unread > 0 && (
              <span
                aria-hidden="true"
                className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-brand-solid"
              />
            )}
          </span>
        );
      }}
      threadPreview={(message) => {
        const threadReplies = repliesOf(message.id);
        if (!threadReplies.length) return null;
        const label =
          threadReplies.length === 1
            ? m.conversation_thread_one_reply()
            : m.conversation_thread_replies({
                count: threadReplies.length,
              });
        const lastReply = threadReplies.at(-1)!;
        // Carry each replier's deleted flag alongside its name so the preview stack greys a
        // deleted Agent (ADR 0044) instead of losing the distinction when it dedupes.
        // Dedupe on the handle, which is unique, rather than the display name, which is not:
        // two people may both be called "Alex" and must still both appear here.
        const repliers: { name: string; deleted: boolean }[] = [];
        const seenRepliers = new Set<string>();
        for (const reply of [...threadReplies].reverse()) {
          const key = reply.senderHandle ?? reply.senderName;
          if (seenRepliers.has(key)) continue;
          seenRepliers.add(key);
          repliers.push({ name: reply.senderName, deleted: Boolean(reply.senderDeleted) });
          if (repliers.length === 3) break;
        }
        return (
          <Button
            color="tertiary"
            size="sm"
            onPress={() => openThread(message.id)}
            noTextPadding
            className="h-auto w-fit min-w-0 justify-start gap-2 rounded-md px-1 py-1 text-left font-normal hover:bg-secondary focus-visible:outline-2 focus-visible:outline-brand"
          >
            <span className="flex shrink-0 -space-x-2">
              {repliers.map((replier) => (
                <Avatar
                  key={replier.name}
                  size="xs"
                  alt={replier.name}
                  initials={avatarInitial(replier.name)}
                  contentClassName={
                    replier.deleted ? DELETED_AGENT_AVATAR_CLASS : avatarToneClassName(replier.name)
                  }
                  className="ring-2 ring-primary"
                />
              ))}
            </span>
            <span className="text-xs font-medium text-brand-secondary">{label}</span>
            <RelativeTime
              value={lastReply.createdAt}
              plain
              className="text-xs whitespace-nowrap text-tertiary"
            />
          </Button>
        );
      }}
      messageFooter={(message) => {
        const task = props.tasks?.find((candidate) => candidate.messageId === message.id);
        return task ? <TaskBadge task={task} /> : null;
      }}
    />
  );
  const conversationSidePane = visibleSlot && (
    <>
      {visibleSlot === "profile" && profileAgentId && (
        <AgentProfilePanel
          agentId={profileAgentId}
          requestedTab={agentProfile?.tab}
          onTabChange={(tab) => onAgentProfileTabChange?.(tab)}
          onClose={() => onCloseAgentProfile?.()}
        />
      )}
      {/* Thread panes stay mounted under the profile so drafts and scroll survive. */}
      {visited.map((rootId) => {
        const root = mainMessages.find((message) => message.id === rootId);
        if (!root) return null;
        return (
          <section
            key={rootId}
            aria-label={m.conversation_thread()}
            hidden={!threadPaneVisible(rootId)}
            className={cn(
              "min-h-0 min-w-0 flex-1 flex-col",
              threadPaneVisible(rootId) ? "flex" : "hidden",
            )}
          >
            <ConversationPane
              {...conversationProps}
              root={root}
              onClose={() => setSelected(undefined)}
              emptyState={{
                title: m.conversation_thread_empty_title(),
                description: m.conversation_thread_empty(),
                media: <MessageSquare aria-hidden="true" className="size-6 text-tertiary" />,
              }}
              conversation={{ ...conversation, messages: repliesOf(rootId) }}
              onSend={(body, requestId, attachmentIds) =>
                conversationProps.onSend(body, requestId, attachmentIds, rootId)
              }
              threadHeaderAction={threadHeaderAction?.(rootId)}
            />
          </section>
        );
      })}
    </>
  );
  if (!wideViewport) {
    // Small screens have no room for a resizable split: the slot pane covers the main pane,
    // which stays mounted (hidden) so returning keeps its scroll, drafts and read state.
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", visibleSlot && "hidden")}>
          {conversationMainPane}
        </div>
        {conversationSidePane && (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">{conversationSidePane}</div>
        )}
      </div>
    );
  }
  return (
    <Group
      id="conversation"
      orientation="horizontal"
      defaultLayout={threadLayout.defaultLayout}
      onLayoutChanged={threadLayout.onLayoutChanged}
      className="flex min-h-0 min-w-0 flex-1"
    >
      <Panel
        id="main"
        // Strings are percentages of the group; numbers would be pixels.
        minSize="40"
        className="flex min-h-0 min-w-0 flex-col"
      >
        {conversationMainPane}
      </Panel>
      {visibleSlot && (
        <>
          <Separator
            aria-label={
              visibleSlot === "thread" ? m.conversation_thread() : m.agent_profile_resize()
            }
            className="hidden w-px shrink-0 bg-border-secondary transition-colors hover:bg-brand-solid data-[separator=active]:bg-brand-solid md:block"
          />
          <Panel
            id={visibleSlot}
            defaultSize="35"
            minSize="25"
            maxSize="60"
            className="flex min-h-0 min-w-0 flex-col"
          >
            {conversationSidePane}
          </Panel>
        </>
      )}
    </Group>
  );
}

/**
 * The own-messages index shows one derived filename per message, not the full attachment list.
 * With several attachments, this names the first (send order) and counts the rest, e.g.
 * `photo.png (+2 more)`. Mirrors `attachmentFileNameSummary` in
 * `conversation-history.server.ts` (duplicated rather than imported: that module is
 * server-only and this component renders in the browser).
 */
function attachmentFileNameSummary(attachments: { fileName: string }[]): string | undefined {
  const [first, ...rest] = attachments;
  if (!first) return undefined;
  return rest.length ? `${first.fileName} (+${rest.length} more)` : first.fileName;
}

function anchoredThreadRoot(messages: DirectConversationView["messages"]) {
  if (typeof window === "undefined" || !window.location.hash.startsWith("#message-")) return;
  const messageId = window.location.hash.slice("#message-".length);
  const message = messages.find((candidate) => candidate.id === messageId);
  return message?.threadRootId ?? message?.id;
}

export function ConversationPane({
  conversation,
  header,
  readOnlyNotice,
  emptyState,
  onSend,
  root,
  onClose,
  threadEntry,
  threadPreview,
  threadHeaderAction,
  messageFooter,
  onLoadOlder,
  onLoadOwnMessages,
  onLoadMessageAround,
  onShowLatest,
  onCreateTask,
  onOpenAgentProfile,
}: Omit<ConversationProps, "conversation" | "agentStatus"> & {
  conversation: Omit<DirectConversationView, "agent">;
  header?: React.ReactNode;
  readOnlyNotice?: React.ReactNode;
  emptyState: { title: string; description: string; media: React.ReactNode };
  root?: DirectConversationView["messages"][number];
  onClose?: () => void;
  threadEntry?: (message: DirectConversationView["messages"][number]) => React.ReactNode;
  threadPreview?: (message: DirectConversationView["messages"][number]) => React.ReactNode;
  threadHeaderAction?: React.ReactNode;
  messageFooter?: (message: DirectConversationView["messages"][number]) => React.ReactNode;
}) {
  const [dateLocale, setDateLocale] = useState<string>();
  useEffect(() => setDateLocale(getLocale()), []);
  const toast = useAppToast();
  const [newMessageCount, setNewMessageCount] = useState(0);
  const [followingLatest, followingLatestRef, setFollowingLatest] = useStateWithRef(true);
  const [loadingOlder, loadingOlderRef, setLoadingOlder] = useStateWithRef(false);
  const historyRef = useRef<HTMLDivElement>(null);
  const previousConversationIdRef = useRef<string | undefined>(undefined);
  const previousLastSequenceRef = useRef<number | undefined>(undefined);
  const olderScrollAnchorRef = useRef<{ height: number; top: number } | undefined>(undefined);
  const pendingMessageIdRef = useRef<string | undefined>(undefined);
  const pendingLatestRef = useRef(false);
  const lastSequence = conversation.messages.at(-1)?.sequence;
  const firstSequence = conversation.messages[0]?.sequence;
  // Handles that recently sent a message here, most-recent first: the mention completion popup
  // ranks these candidates ahead of alphabetical order within a match tier. Deduplicated by
  // handle so the same person's older messages don't push their own recent one down.
  const recentHandles = useMemo(() => {
    const handles: string[] = [];
    const seen = new Set<string>();
    for (const message of [...conversation.messages].sort(
      (left, right) => right.sequence - left.sequence,
    )) {
      if (message.senderKind === "system") continue;
      // The projection's own handle, not the displayed name: `senderName` is a display name now,
      // and `filterMentionables` matches recency against `Mentionable.handle`.
      const handle = message.senderHandle;
      if (!handle) continue;
      const key = handle.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      handles.push(handle);
    }
    return handles;
  }, [conversation.messages]);
  const isOwn = (message: DirectConversationView["messages"][number]) =>
    message.senderMemberId != null
      ? message.senderMemberId === conversation.senderMemberId
      : message.senderKind === "user";
  // Only derived from the loaded page when no indexed own-message source is wired up.
  const loadedOwnMessages = useMemo(
    () =>
      onLoadOwnMessages
        ? []
        : conversation.messages
            .filter(isOwn)
            .sort((left, right) => left.sequence - right.sequence)
            .map((message) => ({
              id: message.id,
              sequence: message.sequence,
              body: message.body,
              createdAt: message.createdAt,
              attachmentFileName: attachmentFileNameSummary(message.attachments),
            })),
    [conversation.messages, conversation.senderMemberId, onLoadOwnMessages],
  );
  const ownIndex = useOwnMessagesIndex({
    conversationId: conversation.conversationId,
    enabled: !root,
    onLoad: onLoadOwnMessages,
    fallback: loadedOwnMessages,
  });
  const ownMessages = ownIndex.messages;
  // The own-messages index shows the stored body, which spells a mention as its raw
  // `<@agent:uuid>` token. Resolve those to `@handle` the way the message list does, using the
  // conversation's known mentionables. Applies to channels too (both render through here).
  const formatIndexBody = useMemo(
    () => makeMentionBodyFormatter(conversation.mentionables ?? []),
    [conversation.mentionables],
  );
  /** The full-height sizer the rows' window sits in; its top is where row offsets start. */
  const listRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef(conversation.messages);
  messagesRef.current = conversation.messages;
  // Content above the list inside the scroll container (thread root, load-older control).
  const [scrollMargin, setScrollMargin] = useState(0);
  const getMessageKey = useCallback(
    (index: number) => conversation.messages[index]?.id ?? index,
    [conversation.messages],
  );
  const messageVirtualizer = useVirtualizer({
    count: conversation.messages.length,
    getScrollElement: () => historyRef.current,
    observeElementRect: observeConversationRect,
    getItemKey: getMessageKey,
    estimateSize: () => 160,
    measureElement: measureConversationElement,
    overscan: 6,
    initialRect: { width: 0, height: 800 },
    anchorTo: "end",
    followOnAppend: true,
    scrollEndThreshold: 48,
    useFlushSync: false,
    scrollMargin,
  });

  useLayoutEffect(() => {
    const history = historyRef.current;
    const list = listRef.current;
    if (!history || !list) return;
    const measure = () =>
      setScrollMargin(
        Math.max(
          0,
          Math.round(
            list.getBoundingClientRect().top -
              history.getBoundingClientRect().top +
              history.scrollTop,
          ),
        ),
      );
    measure();
    const observer = new ResizeObserver(measure);
    for (const child of history.children) if (child !== list) observer.observe(child);
    return () => observer.disconnect();
  }, [
    conversation.conversationId,
    root?.id,
    conversation.hasOlder,
    conversation.messages.length === 0,
  ]);

  useLayoutEffect(() => {
    const firstRender = previousConversationIdRef.current === undefined;
    const changedConversation =
      previousConversationIdRef.current !== undefined &&
      previousConversationIdRef.current !== conversation.conversationId;
    const previousLastSequence = previousLastSequenceRef.current;
    const receivedMessageCount =
      previousLastSequence === undefined
        ? 0
        : conversation.messages.filter(
            (message) => !isOwn(message) && message.sequence > previousLastSequence,
          ).length;
    previousConversationIdRef.current = conversation.conversationId;
    previousLastSequenceRef.current = lastSequence;

    if (firstRender || changedConversation || followingLatestRef.current) {
      scrollToLatest("instant");
      setNewMessageCount(0);
      setFollowingLatest(true);
    } else if (receivedMessageCount > 0) {
      setNewMessageCount((count) => count + receivedMessageCount);
    }
    return undefined;
  }, [conversation.conversationId, lastSequence]);

  useLayoutEffect(() => {
    const history = historyRef.current;
    if (!history) return;
    const observer = new ResizeObserver(() => {
      if (followingLatestRef.current) scrollToLatest("instant");
    });
    observer.observe(history);
    const messages = history.querySelector("ol");
    if (messages) observer.observe(messages);
    return () => observer.disconnect();
  }, [conversation.conversationId, conversation.messages.length === 0]);

  useLayoutEffect(() => {
    function scrollToMessageAnchor() {
      const anchor = window.location.hash.slice(1);
      if (!anchor.startsWith("message-")) return;
      const message = document.getElementById(anchor);
      if (message) {
        setFollowingLatest(false);
        message.scrollIntoView({ block: "center" });
        return;
      }
      const messageId = anchor.slice("message-".length);
      const index = messagesRef.current.findIndex((candidate) => candidate.id === messageId);
      if (index < 0) return;
      setFollowingLatest(false);
      messageVirtualizer.scrollToIndex(index, { align: "center" });
      // The row is positioned from an estimate until it mounts; settle on its measured box.
      requestAnimationFrame(() =>
        document.getElementById(anchor)?.scrollIntoView({ block: "center" }),
      );
    }
    scrollToMessageAnchor();
    window.addEventListener("hashchange", scrollToMessageAnchor);
    return () => window.removeEventListener("hashchange", scrollToMessageAnchor);
  }, [firstSequence]);

  useLayoutEffect(() => {
    const messageId = pendingMessageIdRef.current;
    if (!messageId) return;
    const index = conversation.messages.findIndex((message) => message.id === messageId);
    if (index < 0) return;
    messageVirtualizer.scrollToIndex(index, {
      align: "center",
      behavior: "smooth",
    });
    pendingMessageIdRef.current = undefined;
  }, [conversation.messages, messageVirtualizer]);

  useLayoutEffect(() => {
    if (!pendingLatestRef.current || conversation.hasNewer) return;
    const lastIndex = conversation.messages.length - 1;
    if (lastIndex >= 0) messageVirtualizer.scrollToIndex(lastIndex, { align: "end" });
    requestAnimationFrame(() => scrollToLatest("instant"));
    pendingLatestRef.current = false;
  }, [conversation.hasNewer, conversation.messages, messageVirtualizer]);

  function scrollToLatest(behavior: ScrollBehavior) {
    const history = historyRef.current;
    if (!history) return;
    history.scrollTo({ top: history.scrollHeight, behavior });
    history.scrollTop = history.scrollHeight;
  }

  function trackReadingPosition() {
    const history = historyRef.current;
    if (!history) return;
    if (history.scrollTop <= 80) void loadOlder();
    const followingLatest = history.scrollHeight - history.scrollTop - history.clientHeight <= 48;
    setFollowingLatest(followingLatest);
    if (followingLatest) setNewMessageCount(0);
  }

  async function loadOlder() {
    const history = historyRef.current;
    if (root || !history || !conversation.hasOlder || !onLoadOlder || loadingOlderRef.current)
      return;
    setLoadingOlder(true);
    olderScrollAnchorRef.current = {
      height: history.scrollHeight,
      top: history.scrollTop,
    };
    try {
      await onLoadOlder();
    } catch {
      olderScrollAnchorRef.current = undefined;
    } finally {
      setLoadingOlder(false);
    }
  }

  async function showLatestMessages() {
    setFollowingLatest(true);
    setNewMessageCount(0);
    if (conversation.hasNewer && onShowLatest) {
      pendingLatestRef.current = true;
      try {
        await onShowLatest();
      } catch (cause) {
        pendingLatestRef.current = false;
        setFollowingLatest(false);
        toast.error(m.conversation_history_load_error(), cause);
        return;
      }
    }
    scrollToLatest("smooth");
  }

  async function showMessage(messageId: string) {
    const index = conversation.messages.findIndex((message) => message.id === messageId);
    setFollowingLatest(false);
    if (index < 0) {
      if (!onLoadMessageAround) return;
      pendingMessageIdRef.current = messageId;
      try {
        await onLoadMessageAround(messageId);
      } catch (cause) {
        pendingMessageIdRef.current = undefined;
        toast.error(m.conversation_history_load_error(), cause);
      }
      return;
    }
    messageVirtualizer.scrollToIndex(index, { align: "center", behavior: "smooth" });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {root ? (
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-secondary px-3">
          <ButtonUtility
            icon={ArrowLeft}
            size="sm"
            color="tertiary"
            onClick={onClose}
            aria-label={m.conversation_thread_back()}
          />
          <h2 className="text-base font-semibold">{m.conversation_thread()}</h2>
          {threadHeaderAction}
        </header>
      ) : (
        header
      )}

      <div className="group/history relative min-h-0 flex-1">
        <div
          ref={historyRef}
          aria-label={root ? m.conversation_thread() : m.conversation_history()}
          onScroll={trackReadingPosition}
          className="h-full overflow-y-auto pb-6 [scrollbar-width:thin]"
        >
          {root && (
            <div
              aria-label={m.conversation_thread_root()}
              className="mt-4 flex gap-3 bg-secondary px-4 py-2 md:px-6"
            >
              <div className="flex w-9 shrink-0 items-start justify-center">
                <Avatar
                  size="sm"
                  alt={root.senderName}
                  src={root.senderAvatarUrl}
                  initials={avatarInitial(root.senderName)}
                  contentClassName={
                    root.senderDeleted
                      ? DELETED_AGENT_AVATAR_CLASS
                      : avatarToneClassName(root.senderName)
                  }
                />
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <p className="flex items-baseline gap-2">
                  <span className="text-sm font-semibold text-primary">
                    {isOwn(root) ? m.conversation_you() : root.senderName}
                  </span>
                  {root.senderDeleted && <DeletedAgentBadge />}
                  <time
                    dateTime={new Date(root.createdAt).toISOString()}
                    className="text-xs text-tertiary tabular-nums"
                  >
                    {clockLabel(root.createdAt, dateLocale)}
                  </time>
                </p>
                <div className="min-w-0 text-md leading-6 text-primary [overflow-wrap:anywhere]">
                  <MessageBody
                    body={root.body}
                    mentions={root.mentions}
                    viewerHandle={conversation.viewerHandle}
                  />
                </div>
                {root.attachments.map((attachment) => (
                  <AttachmentCard key={attachment.id} attachment={attachment} />
                ))}
              </div>
            </div>
          )}
          {!root && conversation.hasOlder && onLoadOlder && (
            <div className="flex justify-center px-4 pt-4 md:px-6">
              <Button
                color="tertiary"
                size="sm"
                isDisabled={loadingOlder}
                onPress={() => void loadOlder()}
              >
                {loadingOlder ? m.conversation_loading_older() : m.conversation_load_older()}
              </Button>
            </div>
          )}
          {conversation.messages.length === 0 ? (
            <Empty
              className={
                root
                  ? "px-4 py-8 md:px-6"
                  : "items-start px-4 pt-[clamp(2rem,10svh,5rem)] pb-8 text-left md:px-6"
              }
            >
              <EmptyHeader className={root ? "gap-2" : "w-full max-w-sm items-start gap-3"}>
                <EmptyMedia className="mb-1">{emptyState.media}</EmptyMedia>
                <EmptyTitle
                  role="heading"
                  aria-level={root ? 3 : 2}
                  className={cn(
                    "max-w-full [overflow-wrap:anywhere]",
                    root ? "text-sm" : "text-xl font-semibold",
                  )}
                >
                  {emptyState.title}
                </EmptyTitle>
                <EmptyDescription>{emptyState.description}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            // The sizer holds the scrollbar at the full virtual height; the rows themselves
            // live in one translated window below (see the `ol`).
            <div
              ref={listRef}
              className="relative"
              style={{ height: `${messageVirtualizer.getTotalSize() + 24}px` }}
            >
              {/* One window, positioned at the first rendered row's offset, with the rows in
                  normal flow inside it — rather than every row absolutely positioned at its own
                  offset. A row is measured after it renders, so until then the virtualizer only
                  has `estimateSize`; with per-row absolute offsets a row taller than the estimate
                  (a wrapped Markdown body is easily 200px against a 160px estimate) is drawn
                  straight over the row below it, which is the "messages cover each other" report.
                  In flow, a stale size can only shift this whole block — which end-anchoring
                  corrects on the next measurement — and never paints two rows on top of each
                  other. */}
              <ol
                className="absolute top-0 left-0 w-full"
                style={{
                  transform: `translateY(${(messageVirtualizer.getVirtualItems()[0]?.start ?? 0) - scrollMargin + 24}px)`,
                }}
              >
                {messageVirtualizer.getVirtualItems().map(({ index, key }) => {
                  const message = conversation.messages[index];
                  if (!message) return null;
                  const previous = conversation.messages[index - 1];
                  const own = isOwn(message);
                  const { dayChanged, grouped } = groupsWithPrevious(
                    message,
                    previous,
                    own,
                    previous ? isOwn(previous) : false,
                    dateLocale,
                  );
                  return (
                    <MessageRow
                      key={key}
                      message={message}
                      index={index}
                      own={own}
                      dayChanged={dayChanged}
                      grouped={grouped}
                      dateLocale={dateLocale}
                      measureRef={messageVirtualizer.measureElement}
                      threadEntry={threadEntry}
                      threadPreview={threadPreview}
                      messageFooter={messageFooter}
                      onOpenAgentProfile={onOpenAgentProfile}
                      viewerHandle={conversation.viewerHandle}
                    />
                  );
                })}
              </ol>
            </div>
          )}
        </div>
        {(ownMessages.length > 0 || !followingLatest) && (
          <div
            role="group"
            aria-label={m.conversation_message_navigation()}
            className={cn(
              "absolute right-4 bottom-3 z-10 inline-flex items-center gap-0.5 rounded-full border border-secondary bg-primary p-0.5 shadow-xs transition-opacity",
              followingLatest &&
                !ownIndex.open &&
                "pointer-events-none opacity-0 group-hover/history:pointer-events-auto group-hover/history:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100",
            )}
          >
            {ownMessages.length > 0 && (
              <OwnMessagesMenu
                messages={ownMessages}
                loading={ownIndex.loading}
                open={ownIndex.open}
                onOpenChange={ownIndex.setOpen}
                menuRef={ownIndex.menuRef}
                onLoadOlder={ownIndex.loadOlder}
                onSelect={(messageId) => void showMessage(messageId)}
                formatBody={formatIndexBody}
              />
            )}
            {ownMessages.length > 0 && !followingLatest && (
              <span aria-hidden="true" className="h-4 w-px bg-secondary" />
            )}
            {!followingLatest && (
              <span className="relative">
                <ButtonUtility
                  icon={ArrowDown}
                  size="xs"
                  color="tertiary"
                  onClick={() => void showLatestMessages()}
                  aria-label={
                    newMessageCount === 1
                      ? m.conversation_one_new_message()
                      : newMessageCount > 1
                        ? m.conversation_new_messages({ count: newMessageCount })
                        : m.conversation_back_to_bottom()
                  }
                  className="rounded-full"
                />
                {newMessageCount > 0 && (
                  <span
                    aria-hidden="true"
                    className="absolute -top-1 -right-1 size-2.5 rounded-full border border-primary bg-brand-solid"
                  />
                )}
              </span>
            )}
          </div>
        )}
      </div>

      {readOnlyNotice ?? (
        <MessageComposer
          conversationId={conversation.conversationId}
          inThread={Boolean(root)}
          mentionables={conversation.mentionables}
          recentHandles={recentHandles}
          onSend={onSend}
          onCreateTask={onCreateTask}
          onSent={ownIndex.add}
        />
      )}
    </div>
  );
}
