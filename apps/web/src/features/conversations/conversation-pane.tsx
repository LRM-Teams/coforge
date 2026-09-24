import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLatestCallback } from "#src/hooks/use-latest-callback";
import { ProgressBar } from "react-aria-components";
import { ArrowDown, Loading02 } from "@untitledui/icons";

import { useStateWithRef } from "#src/hooks/use-state-with-ref";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { useAppToast } from "#src/components/ui/toast";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#src/components/ui/empty";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";
import { useLiveAgents } from "#src/features/agents/workspace-agents-realtime";

import { useConversationOpenMode, useSavedMessages } from "./conversation-navigation";
import { conversationOpenPosition, unreadBoundary } from "./conversation-open-position";
import { latestTopLevelSequence } from "./conversation-unread";
import { streamState, type StreamRead } from "./stream-state";
import { MessageComposer } from "./message-composer";
import { ThreadPaneHeader, type ThreadFollow } from "./thread-pane-header";
import { makeReferenceBodyFormatter } from "./mention-text";
import type { ChipMention } from "./message-markdown";
import type { ChannelSuggestion } from "./reference-completion";
import {
  GROUPING_WINDOW_MS,
  MessageRow,
  dayLabel,
  groupsWithPrevious,
  type MessageThreadEntry,
} from "./message-row";
import { optimisticSavedEntry } from "./saved-messages-collection";
import { composerDraftKey } from "./composer-draft";
import { OutboxMessageRow } from "./outbox-message-row";
import { SystemMessageGroup } from "./system-message-group";
import { groupSystemMessages } from "./system-message-groups";
import { useMessageOutbox, useOutboxEntries } from "./use-message-outbox";
import { OwnMessagesMenu, useOwnMessagesIndex } from "./own-messages-menu";
import { positionJumpDecision } from "./conversation-thread-search";
import { replyCountLabel } from "./conversation-labels";
import type { ConversationProps, DirectConversationView } from "./conversation-types";
import { MESSAGE_COLUMN_CLASS } from "#src/features/settings/message-width";

/** How close to the bottom the pane must be for a content-resize to re-pin it (see the pinning
 * ResizeObserver). Tight on purpose: the reading position itself uses a wider tolerance. */
const PIN_TOLERANCE_PX = 4;
/** How long a landed position jump keeps its highlight. The hash deep link leans on `:target`,
 * which lasts until the hash moves; the saved jump has no hash to lean on, so it needs a bound.
 * 2.5s hold + the row's 500ms transition out = the ~3s window the ruling settled on (2026-09-23:
 * "2.5–3s 合适的窗口，符合我们的 design" — bg-tertiary wash + brand ring, fading to normal). */
const JUMP_HIGHLIGHT_MS = 2500;

/** The gap left above a row the pane scrolls to (`applyOpenPosition`). */
const ROW_TOP_GAP_PX = 12;

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

export function ConversationPane({
  conversation,
  header,
  readOnlyNotice,
  emptyState,
  streamRead = "settled",
  onSend,
  root,
  rootSlot,
  openAtTop,
  onClose,
  threadContext,
  onViewInConversation,
  threadFollow,
  threadEntry,
  threadPreview,
  threadHeaderAction,
  messageFooter,
  onLoadOlder,
  onLoadNewer,
  onLoadOwnMessages,
  onLoadMessageAround,
  onShowLatest,
  onReadLatest,
  onCreateTask,
  onToggleReaction,
  onOpenAgentProfile,
  plainMentions,
  taskReferences,
  onOpenTask,
  channelNames,
  channels,
  jumpMessage,
  onJumpMessageConsumed,
}: Omit<ConversationProps, "conversation" | "agentStatus"> & {
  conversation: Omit<DirectConversationView, "agent">;
  header?: React.ReactNode;
  readOnlyNotice?: React.ReactNode;
  emptyState: { title: string; description: string; media: React.ReactNode };
  /** Whether this stream's read has completed - see `stream-state.ts`. */
  streamRead?: StreamRead;
  root?: DirectConversationView["messages"][number];
  /** Shown in place of a thread's header and root row, scrolling with its replies — the task
   * popup puts the task there. */
  rootSlot?: React.ReactNode;
  /** Opens at the top instead of the viewer's open position — the task popup's thread opens on
   * the task, not its latest reply. */
  openAtTop?: boolean;
  onClose?: () => void;
  /** Where a thread lives, named after "Thread" in its header: `#channel` or `@name`. */
  threadContext?: string;
  /** Leaves the thread for its root message in the conversation's stream. */
  onViewInConversation?: () => void;
  /** The viewer's follow state for this thread, where following is offered (channels). */
  threadFollow?: ThreadFollow;
  threadEntry?: (message: DirectConversationView["messages"][number]) => MessageThreadEntry;
  threadPreview?: (message: DirectConversationView["messages"][number]) => React.ReactNode;
  /** Shown in the thread header before its actions menu (the Agents following the thread). */
  threadHeaderAction?: React.ReactNode;
  messageFooter?: (message: DirectConversationView["messages"][number]) => React.ReactNode;
  /** Plain-`@handle` display resolution for the stream (see `MessageBody`). Built by each
   * wrapper — the DM from its Agent counterpart, a channel from its member directory. */
  plainMentions?: Map<string, ChipMention>;
  /** The task numbers a body's `task #N` references resolve to in this conversation, and the
   * handler that opens one's detail popup. Owned by `ThreadedConversationContent`, which reads
   * them from the conversation's task list. */
  taskReferences?: ReadonlySet<number>;
  onOpenTask?: (number: number) => void;
  /** Channel id → current name, for the channel links in a body (see `MessageBody`). Owned by
   * `ThreadedConversationContent`, which reads the viewer's channel list. */
  channelNames?: ReadonlyMap<string, string>;
  /** Every channel of the Workspace, for the composer's `#` list. Owned by
   * `ThreadedConversationContent`, which reads it from the messages layout. */
  channels?: readonly ChannelSuggestion[];
  /** The Saved view's position-only jump anchor (`?message=<uuid>`; see
   * `useConversationPositionJump`). Supplied only by the main pane's wrapper — the router
   * read lives there so this pane keeps no router hooks. */
  jumpMessage?: string;
  /** Called exactly once per consumed jump, to strip the param one-shot like a hash. */
  onJumpMessageConsumed?: () => void;
}) {
  const openMode = useConversationOpenMode();
  // The candidate list keeps every member, the viewer included, because it is also what *resolves*
  // a mention of the viewer in a body or preview. Offering the viewer to the viewer is a different
  // question, and the composer answers it with its own rule: you never mention yourself.
  const mentionCandidates = useMemo(
    () =>
      conversation.mentionables?.filter((mention) => mention.handle !== conversation.viewerHandle),
    [conversation.mentionables, conversation.viewerHandle],
  );
  const [dateLocale, setDateLocale] = useState<string>();
  useEffect(() => setDateLocale(getLocale()), []);
  const toast = useAppToast();
  const [newMessageCount, setNewMessageCount] = useState(0);
  // Reply-to-selection: the row hands over a finished quote, the composer puts it in the draft.
  // The counter (never the text) is the identity of an insertion, so highlighting the same words
  // twice inserts twice.
  const [quotedDraft, setQuotedDraft] = useState<{ id: number; text: string } | undefined>();
  const quoteSequenceRef = useRef(0);
  // A read-only pane (a preview, an archived channel) offers nothing that writes a message.
  const canCompose = !readOnlyNotice;
  const quoteSelection = useCallback((text: string) => {
    if (!text) return;
    quoteSequenceRef.current += 1;
    setQuotedDraft({ id: quoteSequenceRef.current, text });
  }, []);
  // Row event handlers keep one identity across renders (`useLatestCallback`), so the memoized
  // rows skip a pane render that did not change them.
  const toggleReaction = useLatestCallback(
    onToggleReaction
      ? (messageId: string, emoji: string, active: boolean) => {
          void onToggleReaction(messageId, emoji, active).catch(() => {
            toast.error(m.conversation_reaction_error());
          });
        }
      : undefined,
  );
  const openAgentProfile = useLatestCallback(onOpenAgentProfile);
  const openTaskReference = useLatestCallback(onOpenTask);
  // Saving (#127) is viewer-global state with a conversation-scoped write: the pane owns the
  // conversation id, the Chat page's Saved context owns the list every star (and the Saved view)
  // reads. Membership-gated exactly like the channel gates its row actions; outside the Chat
  // page there is no context, so the rows simply offer no save.
  const savedMessages = useSavedMessages();
  const onToggleSave = useLatestCallback(
    savedMessages && conversation.senderMemberId
      ? async (messageId: string, saved: boolean) => {
          if (!saved) return savedMessages.unsave(messageId);
          const message =
            conversation.messages.find((candidate) => candidate.id === messageId) ??
            (root?.id === messageId ? root : undefined);
          if (!message) return;
          await savedMessages.save(optimisticSavedEntry(message, conversation.conversationId));
        }
      : undefined,
  );
  const [followingLatest, followingLatestRef, setFollowingLatest] = useStateWithRef(true);
  const [loadingOlder, loadingOlderRef, setLoadingOlder] = useStateWithRef(false);
  const [, loadingNewerRef, setLoadingNewer] = useStateWithRef(false);
  const historyRef = useRef<HTMLDivElement>(null);
  const messageListRef = useRef<HTMLOListElement>(null);
  /** Distance from the bottom as of the last scroll. The pinning observer decides from this
   * rather than from a fresh measurement, because by the time it runs the resize is already in
   * `scrollHeight`. */
  const bottomDistanceRef = useRef(0);
  /** The sentinel above the oldest loaded message and the one below the newest. Coming into view
   * is what asks for the next page of history or for the evicted tail — the reader never has to
   * press anything. */
  const olderSentinelRef = useRef<HTMLDivElement>(null);
  const newerSentinelRef = useRef<HTMLDivElement>(null);
  /** The current `loadOlder`/`loadNewer`, so a sentinel's observer never calls a stale one. */
  const loadOlderRef = useRef<() => Promise<void>>(async () => {});
  const loadNewerRef = useRef<() => Promise<void>>(async () => {});
  const previousConversationIdRef = useRef<string | undefined>(undefined);
  const previousLastSequenceRef = useRef<number | undefined>(undefined);
  /** The reading position to restore after a load changes the list's height at either end:
   * the row at the top of the viewport and its content's offset, before the change. See the
   * layout effect below for why a raw height delta is not enough once eviction is in play. */
  const historyScrollAnchorRef = useRef<
    { rowId?: string; offset: number; height: number; top: number } | undefined
  >(undefined);
  const pendingMessageIdRef = useRef<string | undefined>(undefined);
  // The row a position jump just landed on, highlighted for a moment: `?message=` deliberately
  // carries no hash (#713), so the landed row has no `:target` to take the anchor highlight from
  // (message-row.tsx renders both treatments with the same classes).
  const [jumpHighlightId, setJumpHighlightId] = useState<string | undefined>(undefined);
  const jumpHighlightTimer = useRef<number | undefined>(undefined);
  const flashMessageRow = useCallback((messageId: string) => {
    setJumpHighlightId(messageId);
    window.clearTimeout(jumpHighlightTimer.current);
    jumpHighlightTimer.current = window.setTimeout(() => {
      setJumpHighlightId((current) => (current === messageId ? undefined : current));
    }, JUMP_HIGHLIGHT_MS);
  }, []);
  useEffect(() => () => window.clearTimeout(jumpHighlightTimer.current), []);
  // The row the pane still owes an open scroll. Rows are all in the DOM, so this is only held
  // when the container had no height to scroll within yet (a hidden branch); the pinning
  // observer retries it once the pane is laid out.
  const pendingOpenMessageIdRef = useRef<string | undefined>(undefined);
  const pendingLatestRef = useRef(false);
  // The initial-position decision is made once per conversation open: with unread messages,
  // Slack's default lands on the first one and draws the divider; otherwise at the latest.
  // Consumed by the mount effect below (open positioning) and by the divider snapshot, and
  // never re-read on later updates.
  const firstUnread = useMemo(
    () => unreadBoundary(conversation.messages, conversation.readThroughSequence),
    [conversation.conversationId, root?.id],
  );
  // The divider is frozen at the boundary seen at open, so the mark-read effect (which
  // advances the cursor server-side) never makes it jump or vanish mid-visit. Captured once,
  // by the first render's state initializer: a ref written during render could be left set by
  // a render React then discards, showing a divider for a conversation never opened.
  const [openBoundary] = useState(firstUnread);
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
  // The viewer's messages the server has not confirmed yet (or failed to take), shown greyed at the
  // foot of the stream until the real message replaces them (see `composer-outbox.ts`).
  const outboxDraftKey = composerDraftKey(conversation.conversationId, root?.id);
  const outbox = useMessageOutbox({
    draftKey: outboxDraftKey,
    onSend,
    onCreateTask,
    onSent: ownIndex.add,
  });
  const outboxEntries = useOutboxEntries(outboxDraftKey);
  const loadedMessageIds = useMemo(
    () => new Set(conversation.messages.map((message) => message.id)),
    [conversation.messages],
  );
  // A delivered message leaves the outbox once the real one is on screen, never before, so the
  // row never blinks out between the two. A pending row belongs at the foot of the conversation,
  // which the main pane's window reaches only when no newer page is waiting; a failure is shown
  // regardless, so it cannot go unseen. A thread pane always holds its whole reply list.
  const windowAtLatest = Boolean(root) || !conversation.hasNewer;
  const shownOutbox = outboxEntries.filter((entry) =>
    entry.state === "unsent"
      ? true
      : windowAtLatest && (entry.state === "sending" || !loadedMessageIds.has(entry.messageId)),
  );
  // The side pane's replies marker (the task popup puts the task in place of the root, so it has
  // none). Pending replies count: the marker is there from the first send, not after it lands.
  const threadMarker =
    Boolean(root) && !rootSlot && conversation.messages.length + shownOutbox.length > 0;
  useEffect(() => {
    for (const entry of outboxEntries)
      if (entry.state === "delivered" && loadedMessageIds.has(entry.messageId))
        outbox.discard(entry);
  }, [outboxEntries, loadedMessageIds]);
  // Sending takes the reader to the latest messages, where the new one appears. Entries already
  // there when the pane opens are not a new send: the open position stands. A thread pane only
  // scrolls itself; asking for the main window's latest page could unload the thread's root.
  const knownOutboxIdsRef = useRef<ReadonlySet<string> | undefined>(undefined);
  useEffect(() => {
    const known = knownOutboxIdsRef.current;
    knownOutboxIdsRef.current = new Set(outboxEntries.map((entry) => entry.localId));
    if (!known) return;
    if (!outboxEntries.some((entry) => entry.state === "sending" && !known.has(entry.localId)))
      return;
    if (root) {
      setFollowingLatest(true);
      scrollToLatest("smooth");
    } else void showLatestMessages();
  }, [outboxEntries]);
  // The first pending row continues the viewer's run of messages right above it, as a sent one would.
  const lastMessage = conversation.messages.at(-1);
  const outboxContinuesRun =
    lastMessage !== undefined &&
    isOwn(lastMessage) &&
    dayLabel(lastMessage.createdAt, dateLocale) === dayLabel(new Date(), dateLocale) &&
    Date.now() - new Date(lastMessage.createdAt).getTime() <= GROUPING_WINDOW_MS;
  // The own-messages index shows the stored body, which spells a mention as its raw
  // `<@agent:uuid>` token. Resolve those to `@handle` the way the message list does, using the
  // conversation's known mentionables. Applies to channels too (both render through here).
  const formatIndexBody = useMemo(
    () => makeReferenceBodyFormatter(conversation.mentionables ?? [], channelNames),
    [conversation.mentionables, channelNames],
  );
  // Agent presence for the stream's avatars: one lookup built from the app shell's single
  // subscription, rather than each row subscribing for itself.
  const liveAgents = useLiveAgents();
  const agentDisplayById = useMemo(
    () => new Map(liveAgents.map((agent) => [agent.id, agent.display])),
    [liveAgents],
  );
  const agentDisplayFor = useCallback(
    (agentId: string) => agentDisplayById.get(agentId),
    [agentDisplayById],
  );
  /** Message ids whose very long body the reader has opened in full. Kept here rather than in the
   * row: a row is skipped and laid out again as it leaves and re-enters the viewport, and an
   * expanded message must not re-collapse behind the reader. */
  const [expandedMessages, setExpandedMessages] = useState<ReadonlySet<string>>(new Set());
  const collapsible = conversation.collapseLongMessages !== false;
  const toggleExpandedMessage = useCallback((messageId: string) => {
    setExpandedMessages((current) => {
      const next = new Set(current);
      if (!next.delete(messageId)) next.add(messageId);
      return next;
    });
  }, []);
  // Runs of consecutive system messages fold into one summary line (system-message-groups.ts). A
  // run never crosses a day divider or the unread divider, so both stay drawn, and the message the
  // pane opens on (the unread boundary) is always a group's first message or a row of its own.
  const streamItems = useMemo(
    () =>
      groupSystemMessages(
        conversation.messages,
        (message, previous) =>
          message.sequence === openBoundary?.sequence ||
          dayLabel(message.createdAt, dateLocale) !== dayLabel(previous.createdAt, dateLocale),
      ),
    [conversation.messages, openBoundary, dateLocale],
  );
  /** System message ids whose folded group is open. A group is open while any of its messages is
   * here, so a group that grows (a new notice, older history) stays open for the reader. */
  const [openedSystemMessages, setOpenedSystemMessages] = useState<ReadonlySet<string>>(new Set());
  const toggleSystemGroup = useCallback((messages: readonly { id: string }[]) => {
    setOpenedSystemMessages((current) => {
      const next = new Set(current);
      const open = messages.some((message) => next.has(message.id));
      for (const message of messages) {
        if (open) next.delete(message.id);
        else next.add(message.id);
      }
      return next;
    });
  }, []);
  /** Opens the folded group hiding a message a jump is heading for. True when it did, i.e. the
   * row exists only from the next render on; false when the message is not folded away. */
  function revealSystemMessage(messageId: string): boolean {
    const group = streamItems.find(
      (item) =>
        item.type === "systemGroup" && item.messages.some((message) => message.id === messageId),
    );
    if (
      group?.type !== "systemGroup" ||
      group.messages.some((message) => openedSystemMessages.has(message.id))
    )
      return false;
    setOpenedSystemMessages((current) => new Set(current).add(messageId));
    return true;
  }
  const revealSystemMessageRef = useRef(revealSystemMessage);
  revealSystemMessageRef.current = revealSystemMessage;
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
    if (openAtTop && firstRender) {
      // Stays at the top; it still follows new replies when everything already fits, since a
      // pane that cannot scroll never reports a reading position.
      const history = historyRef.current;
      setFollowingLatest(
        Boolean(history) && history!.scrollHeight - history!.clientHeight <= PIN_TOLERANCE_PX,
      );
      return undefined;
    }

    if (firstRender || changedConversation || followingLatestRef.current) {
      setNewMessageCount(0);
      // The user's "When I view a conversation" preference decides the open position:
      // - first-unread: land on the oldest unread (divider above it).
      // - newest-read / newest-unread: land at the latest. `newest-unread` differs only in
      //   when the cursor advances: it waits for `onReadLatest` below, never for the open.
      // A message hash (deep link, task jump) still wins over both — the anchor effect
      // handles it and has already cleared `followingLatest` by the time this runs.
      // Only an actual open positions on unread. Reaching the latest again later in the same
      // conversation (`followingLatest`) keeps following it.
      const openMessageId =
        firstRender || changedConversation
          ? conversationOpenPosition(openMode, firstUnread)
          : undefined;
      if (openMessageId && !window.location.hash) {
        if (conversation.messages.some((message) => message.id === openMessageId)) {
          setFollowingLatest(false);
          pendingOpenMessageIdRef.current = openMessageId;
          applyOpenPosition();
          return undefined;
        }
      }
      setFollowingLatest(true);
      scrollTwice(() => {
        if (followingLatestRef.current) scrollToLatest("instant");
      });
    } else if (receivedMessageCount > 0) {
      setNewMessageCount((count) => count + receivedMessageCount);
    }
    return undefined;
  }, [conversation.conversationId, lastSequence]);

  useLayoutEffect(() => {
    const history = historyRef.current;
    if (!history) return;
    const observer = new ResizeObserver(() => {
      // An open position the pane could not apply yet (a hidden branch has no height to scroll
      // within) gets its chance here.
      if (pendingOpenMessageIdRef.current) {
        applyOpenPosition();
        return;
      }
      // Whether to re-pin is decided from where the reader stood BEFORE this resize. A
      // ResizeObserver callback runs after layout, so `scrollHeight` already includes the growth:
      // judging "at the bottom" from it would refuse to re-pin in exactly the case the pin exists
      // for — an attachment at the bottom finishing and pushing the latest message out of view.
      const wasAtBottom = bottomDistanceRef.current <= PIN_TOLERANCE_PX;
      bottomDistanceRef.current = history.scrollHeight - history.scrollTop - history.clientHeight;
      // Only a reader genuinely AT the bottom is carried along, never one within the 48px "near
      // enough" tolerance the reading position uses: re-pinning from 48px fought a reader who had
      // scrolled up a little, and every deliberate scroll-up must stand.
      if (!followingLatestRef.current || !wasAtBottom) return;
      scrollToLatest("instant");
      bottomDistanceRef.current = 0;
    });
    observer.observe(history);
    if (messageListRef.current) observer.observe(messageListRef.current);
    return () => observer.disconnect();
  }, [conversation.conversationId, conversation.messages.length === 0]);

  // A load changes the list's height at one end *and*, once the window is full, removes a page at
  // the other: paging up prepends history and evicts the newest page; paging down appends the tail
  // and evicts the oldest. A raw `scrollHeight` delta would then move the reader by the evicted
  // page's height too, which is not where they were reading. So the anchor is the row at the top of
  // the viewport and its offset; restoring that row to the same offset keeps the reading position
  // whatever moved at either end. The offset is measured on the row's content (`scrollAnchorOf`),
  // not its edges: a load changes what surrounds the text — the window's first row carries the day
  // divider until an older page takes it, a same-sender message before a row drops its header and
  // padding — while an image or reaction settling below the text changes the bottom. The height
  // delta stays as the fallback for the one case the row cannot cover: the anchor row itself was
  // evicted.
  useLayoutEffect(() => {
    const anchor = historyScrollAnchorRef.current;
    const history = historyRef.current;
    if (!anchor || !history) return;
    historyScrollAnchorRef.current = undefined;
    if (anchor.rowId) {
      // A folded system group is one row for all its notices, and its row id is its first notice:
      // a page that extends the group backwards gives it a new first notice. The group that still
      // holds the anchored notice is the same row the reader was looking at. A notice's own row
      // comes first: an open group lists the notices it shows and shares its first one's id.
      const id = CSS.escape(anchor.rowId);
      const row =
        history.querySelector<HTMLElement>(
          `li[data-message-id="${id}"]:not([data-system-group])`,
        ) ?? history.querySelector<HTMLElement>(`li[data-system-group-members~="${id}"]`);
      if (row) {
        const containerTop = history.getBoundingClientRect().top;
        const delta =
          scrollAnchorOf(row).getBoundingClientRect().top - (containerTop + anchor.offset);
        if (delta) history.scrollTop += delta;
        return;
      }
    }
    history.scrollTop = anchor.top + (history.scrollHeight - anchor.height);
  }, [conversation.messages]);

  // Asking for the next page when the sentinel comes into view, rather than from a scroll
  // handler: an IntersectionObserver also fires when the pane is laid out already showing the
  // top, which a scroll handler never sees. The margin starts the load a screenful early, so the
  // history is usually there before the reader reaches it.
  useEffect(() => {
    const sentinel = olderSentinelRef.current;
    const history = historyRef.current;
    if (!sentinel || !history) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadOlderRef.current();
      },
      { root: history, rootMargin: "600px 0px 0px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [conversation.conversationId, conversation.hasOlder]);

  // The mirror sentinel below the newest row: once the bounded window has slid up into history and
  // evicted the tail, scrolling back to the bottom asks for the page that brings it back. It re-runs
  // on every message change so a fetch that leaves the sentinel still in view keeps going until the
  // tail is loaded (an IntersectionObserver only fires on a crossing, not while it stays visible).
  useEffect(() => {
    const sentinel = newerSentinelRef.current;
    const history = historyRef.current;
    if (!sentinel || !history) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadNewerRef.current();
      },
      { root: history, rootMargin: "0px 0px 600px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [conversation.conversationId, conversation.hasNewer, conversation.messages.length]);

  useLayoutEffect(() => {
    function scrollToMessageAnchor() {
      const anchor = window.location.hash.slice(1);
      if (!anchor.startsWith("message-")) return;
      // Every loaded row is in the DOM and in normal flow, so the anchored row's own box is the
      // only thing to measure — there is no estimate to settle on. The second pass covers the
      // router's own scroll restoration, which runs after this effect.
      const scroll = () => {
        const message = document.getElementById(anchor);
        if (!message) {
          // A notice folded into a system group: open the group, and let the pending-jump pass
          // below scroll to the row once it exists.
          const messageId = anchor.slice("message-".length);
          if (revealSystemMessageRef.current(messageId)) {
            setFollowingLatest(false);
            pendingMessageIdRef.current = messageId;
          }
          return;
        }
        setFollowingLatest(false);
        message.scrollIntoView({ block: "center" });
      };
      scroll();
      requestAnimationFrame(scroll);
    }
    scrollToMessageAnchor();
    window.addEventListener("hashchange", scrollToMessageAnchor);
    return () => window.removeEventListener("hashchange", scrollToMessageAnchor);
  }, [firstSequence]);

  useLayoutEffect(() => {
    const messageId = pendingMessageIdRef.current;
    if (!messageId) return;
    const message = document.getElementById(`message-${messageId}`);
    if (!message) {
      // Loaded but folded into a system group: open it; this pass runs again once it is open.
      revealSystemMessage(messageId);
      return;
    }
    pendingMessageIdRef.current = undefined;
    message.scrollIntoView({ block: "center", behavior: "smooth" });
    flashMessageRow(messageId);
  }, [conversation.messages, openedSystemMessages, flashMessageRow]);

  useLayoutEffect(() => {
    if (!pendingLatestRef.current || conversation.hasNewer) return;
    scrollTwice(() => scrollToLatest("instant"));
    pendingLatestRef.current = false;
  }, [conversation.hasNewer, conversation.messages]);

  /**
   * Runs a scroll now and again on the next frame. The router's scroll restoration
   * (`scrollRestoration: true` in `router.tsx`) rewrites this container's scrollTop in its
   * `onRendered` pass, which runs after this child's layout effect, so a single pass can be
   * overwritten by the entry cached for this pane. `data-scroll-restoration-id` below keeps
   * another conversation's offset from reaching this pane in the first place.
   */
  function scrollTwice(scroll: () => void) {
    scroll();
    requestAnimationFrame(scroll);
  }

  /** Scrolls to the row the pane opens on — the oldest unread, or the latest. Runs once per open;
   * the pinning observer retries it if the pane had no height to scroll within yet. */
  function applyOpenPosition() {
    const messageId = pendingOpenMessageIdRef.current;
    if (messageId === undefined) return;
    const history = historyRef.current;
    // The whole row, not the message body inside it: the unread divider and the day divider are
    // drawn at the top of the row, and anchoring on the body would scroll them off the top —
    // Slack's default is to open on the first unread *and* show its divider.
    const row = history?.querySelector(`li[data-message-id="${CSS.escape(messageId)}"]`);
    if (!history || !row || history.clientHeight === 0) return;
    pendingOpenMessageIdRef.current = undefined;
    scrollTwice(() => {
      // The row's own offset, straight from layout: every row is in normal flow and laid out at
      // its real height, so this is exact — there is no estimate to correct later.
      const offset =
        row.getBoundingClientRect().top - history.getBoundingClientRect().top + history.scrollTop;
      history.scrollTo({ top: Math.max(0, offset - ROW_TOP_GAP_PX) });
    });
  }

  function scrollToLatest(behavior: ScrollBehavior) {
    // Going to the latest retires any open position still owed.
    pendingOpenMessageIdRef.current = undefined;
    const history = historyRef.current;
    if (!history) return;
    history.scrollTo({ top: history.scrollHeight, behavior });
    history.scrollTop = history.scrollHeight;
  }

  loadOlderRef.current = () => loadOlder();
  loadNewerRef.current = () => loadNewer();

  /** Snapshot the reading position before a load changes the list: the row at the top of the
   * viewport and its content's offset, plus the raw height/scrollTop as a fallback. */
  function captureScrollAnchor(history: HTMLDivElement) {
    const containerTop = history.getBoundingClientRect().top;
    let rowId: string | undefined;
    let offset = 0;
    for (const row of history.querySelectorAll<HTMLElement>("li[data-message-id]")) {
      const rect = row.getBoundingClientRect();
      // The first row that is not entirely above the container's top edge is the one the reader
      // is looking at; the ones before it are already scrolled off.
      if (rect.bottom <= containerTop) continue;
      rowId = row.dataset.messageId;
      offset = scrollAnchorOf(row).getBoundingClientRect().top - containerTop;
      break;
    }
    return { rowId, offset, height: history.scrollHeight, top: history.scrollTop };
  }

  function trackReadingPosition() {
    const history = historyRef.current;
    if (!history) return;
    // Loading older history is the top sentinel's job (see its IntersectionObserver), not this
    // scroll handler's.
    const distance = history.scrollHeight - history.scrollTop - history.clientHeight;
    bottomDistanceRef.current = distance;
    const followingLatest = distance <= 48;
    const wasFollowingLatest = followingLatestRef.current;
    setFollowingLatest(followingLatest);
    if (followingLatest) setNewMessageCount(0);
    // A genuine scroll transition into the latest run is the only signal that the user read
    // it. Open positioning sets `followingLatest` directly and never passes through here, so
    // it cannot mark a conversation read (the `newest-unread` mode).
    if (followingLatest && !wasFollowingLatest && !root) {
      const through = latestTopLevelSequence(conversation.messages);
      if (through > 0) onReadLatest?.(through);
    }
  }

  async function loadOlder() {
    const history = historyRef.current;
    if (root || !history || !conversation.hasOlder || !onLoadOlder || loadingOlderRef.current)
      return;
    setLoadingOlder(true);
    historyScrollAnchorRef.current = captureScrollAnchor(history);
    try {
      await onLoadOlder();
    } catch {
      historyScrollAnchorRef.current = undefined;
    } finally {
      setLoadingOlder(false);
    }
  }

  async function loadNewer() {
    const history = historyRef.current;
    if (root || !history || !conversation.hasNewer || !onLoadNewer || loadingNewerRef.current)
      return;
    setLoadingNewer(true);
    historyScrollAnchorRef.current = captureScrollAnchor(history);
    try {
      await onLoadNewer();
    } catch {
      historyScrollAnchorRef.current = undefined;
    } finally {
      setLoadingNewer(false);
    }
  }

  async function showLatestMessages() {
    setFollowingLatest(true);
    setNewMessageCount(0);
    if (conversation.hasNewer && onShowLatest) {
      pendingLatestRef.current = true;
      try {
        await onShowLatest();
      } catch {
        pendingLatestRef.current = false;
        setFollowingLatest(false);
        toast.error(m.conversation_history_load_error());
        return;
      }
    }
    scrollToLatest("smooth");
  }

  async function showMessage(messageId: string) {
    const loaded = conversation.messages.some((message) => message.id === messageId);
    setFollowingLatest(false);
    if (!loaded) {
      if (!onLoadMessageAround) return;
      pendingMessageIdRef.current = messageId;
      try {
        await onLoadMessageAround(messageId);
      } catch {
        pendingMessageIdRef.current = undefined;
        toast.error(m.conversation_history_load_error());
      }
      return;
    }
    if (revealSystemMessage(messageId)) {
      pendingMessageIdRef.current = messageId;
      return;
    }
    document
      .getElementById(`message-${messageId}`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
    flashMessageRow(messageId);
  }

  // The Saved view's `?message=<uuid>` jump (#127 follow-up): position-only by design. The
  // hash deep-link path above auto-promotes to the thread pane (`openThreadFromHash`), which
  // a saved card must never trigger — the ruling is "land at the message's row in the
  // stream, never in the thread". The wrapper owns the router read (this pane stays free of
  // router hooks so the thread-root tests can render it standalone); this consumes the param
  // exactly once — load the window around the anchor + scroll through the same `showMessage`
  // machinery (its pending-ref pass scrolls after the window swap, so an old reply lands
  // correctly) — and strips the param one-shot, like a hash, so a later sidebar navigation
  // can't inherit a foreign message id. A notification's hash wins outright: two landing
  // mechanisms never run together — the rules themselves are the pure `positionJumpDecision`
  // table (conversation-thread-search.ts), pinned by unit tests for a pane this suite only
  // renders server-side.
  const attemptedJumpRef = useRef<string | undefined>(undefined);
  const showMessageRef = useRef(showMessage);
  showMessageRef.current = showMessage;
  useEffect(() => {
    const decision = positionJumpDecision(
      jumpMessage,
      window.location.hash,
      attemptedJumpRef.current,
    );
    if (decision.action === "idle") {
      attemptedJumpRef.current = undefined;
      return;
    }
    if (decision.action === "ignore") return;
    attemptedJumpRef.current = decision.id;
    if (decision.action === "show") void showMessageRef.current(decision.id);
    onJumpMessageConsumed?.();
  }, [jumpMessage, onJumpMessageConsumed]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {rootSlot ? null : root ? (
        <ThreadPaneHeader
          context={threadContext}
          onScrollToTop={() => historyRef.current?.scrollTo({ top: 0, behavior: "smooth" })}
          onClose={onClose}
          onViewInConversation={onViewInConversation}
          follow={threadFollow}
          action={threadHeaderAction}
        />
      ) : (
        header
      )}

      <div className="group/history relative min-h-0 flex-1">
        <div
          ref={historyRef}
          // The router matches restored scroll targets by a structural selector unless the
          // element names itself, and every conversation renders the same structure — so
          // without this the previous conversation's offset is applied to this one.
          data-scroll-restoration-id={`conversation-${conversation.conversationId}${root ? `-thread-${root.id}` : ""}`}
          aria-label={root ? m.conversation_thread() : m.conversation_history()}
          onScroll={trackReadingPosition}
          className="h-full overflow-y-auto pb-6 [scrollbar-width:thin]"
        >
          {/* The side room sits inside the scroller, so the scrollbar stays on the pane edge. A
              thread pane is already narrow and keeps none. */}
          <div className={root ? undefined : MESSAGE_COLUMN_CLASS}>
            {rootSlot}
            {root && !rootSlot && (
              <div
                aria-label={m.conversation_thread_root()}
                className="border-b border-secondary py-3"
              >
                {/* The root is an ordinary message row so it keeps every message affordance
                  (hover toolbar on wide shells, tap action sheet below `lg`, reactions, action
                  cards, quote-selection) instead of being a bespoke display-only block. Only the
                  thread entry is held back: this pane already is that message's thread. The one-
                  item list keeps the li valid; the rule under it separates the root from its
                  replies. */}
                <ol className="flex flex-col">
                  <MessageRow
                    message={root}
                    own={isOwn(root)}
                    dayChanged={false}
                    grouped={false}
                    unreadStartsHere={false}
                    expanded={expandedMessages.has(root.id)}
                    onToggleExpanded={toggleExpandedMessage}
                    collapsible={collapsible}
                    agentDisplay={agentDisplayFor}
                    dateLocale={dateLocale}
                    messageFooter={messageFooter}
                    onToggleReaction={toggleReaction}
                    onToggleSave={onToggleSave}
                    onOpenAgentProfile={openAgentProfile}
                    viewerHandle={conversation.viewerHandle}
                    plainMentions={plainMentions}
                    taskReferences={taskReferences}
                    onOpenTask={openTaskReference}
                    channelNames={channelNames}
                    onQuoteSelection={canCompose ? quoteSelection : undefined}
                  />
                </ol>
              </div>
            )}
            {threadMarker && (
              // Where the replies begin and how many there are; notices count, since they are
              // replies in this thread too. The pane always holds the whole thread, so this is
              // the top of the replies, never a load-older point.
              <div className="px-4 pt-2 text-center text-sm text-tertiary md:px-6">
                <p className="pb-1">{m.conversation_thread_beginning()}</p>
                <p className="border-b border-secondary pb-2">
                  {replyCountLabel(conversation.messages.length + shownOutbox.length)}
                </p>
              </div>
            )}
            {!root && conversation.hasOlder && onLoadOlder && (
              <div
                ref={olderSentinelRef}
                aria-live="polite"
                className="flex h-8 items-center justify-center px-4 pt-4 text-xs text-tertiary md:px-6"
              >
                {loadingOlder && m.conversation_loading_older()}
              </div>
            )}
            {streamState(conversation.messages.length, streamRead) === "loading" ? (
              // A window replacement is in flight (an "around" read): no messages yet, but that is not
              // an empty conversation. Only a settled read may say so (stream-state.ts, #112/#113).
              <div
                role="status"
                className={cn(
                  "flex items-center justify-center text-tertiary",
                  root ? "px-4 py-8 md:px-6" : "px-4 pt-[clamp(2rem,10svh,5rem)] pb-8 md:px-6",
                )}
              >
                <ProgressBar
                  isIndeterminate
                  aria-label={m.conversation_loading()}
                  className="inline-flex shrink-0 size-4"
                >
                  <Loading02 aria-hidden className="size-full motion-safe:animate-spin" />
                </ProgressBar>
              </div>
            ) : conversation.messages.length === 0 && shownOutbox.length === 0 ? (
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
              // Every loaded row is rendered, in normal flow. Nothing here computes a row's position
              // or its height, so no measurement can shift a row under the reader and no scroll
              // correction is needed while you read; the scrollbar is the real content height.
              <ol
                ref={messageListRef}
                className={cn("flex flex-col", threadMarker ? "pt-2" : "pt-6")}
              >
                {streamItems.map((item, index) => {
                  // The message just above this item: the previous item's last message.
                  const before = streamItems[index - 1];
                  // A thread's first reply opens under the replies marker, which stands in for the
                  // day divider there; later day changes in the thread still get theirs.
                  const opensThread = threadMarker && index === 0;
                  const previous =
                    before?.type === "systemGroup" ? before.messages.at(-1) : before?.message;
                  const first = item.type === "systemGroup" ? item.messages[0]! : item.message;
                  // The unread divider is anchored to the snapshot taken at open: once the
                  // mark-read effect has advanced the cursor, the divider must not jump.
                  const unreadStartsHere = openBoundary?.sequence === first.sequence;
                  if (item.type === "systemGroup") {
                    const groupOpen = item.messages.some((message) =>
                      openedSystemMessages.has(message.id),
                    );
                    return (
                      <SystemMessageGroup
                        key={first.id}
                        id={item.id}
                        messages={item.messages}
                        expanded={groupOpen}
                        onToggleExpanded={() => toggleSystemGroup(item.messages)}
                        dayChanged={
                          !opensThread &&
                          groupsWithPrevious(first, previous, false, false, dateLocale).dayChanged
                        }
                        unreadStartsHere={unreadStartsHere}
                        dateLocale={dateLocale}
                      >
                        {groupOpen &&
                          item.messages.map((message) => (
                            <MessageRow
                              key={message.id}
                              message={message}
                              own={false}
                              dayChanged={false}
                              grouped={false}
                              highlighted={message.id === jumpHighlightId}
                              expanded={false}
                              onToggleExpanded={toggleExpandedMessage}
                              collapsible={collapsible}
                              dateLocale={dateLocale}
                            />
                          ))}
                      </SystemMessageGroup>
                    );
                  }
                  const message = item.message;
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
                      key={message.id}
                      message={message}
                      own={own}
                      dayChanged={dayChanged && !opensThread}
                      grouped={grouped}
                      unreadStartsHere={unreadStartsHere}
                      highlighted={message.id === jumpHighlightId}
                      expanded={expandedMessages.has(message.id)}
                      onToggleExpanded={toggleExpandedMessage}
                      collapsible={collapsible}
                      agentDisplay={agentDisplayFor}
                      dateLocale={dateLocale}
                      threadEntry={threadEntry}
                      threadPreview={threadPreview}
                      messageFooter={messageFooter}
                      onToggleReaction={toggleReaction}
                      onToggleSave={onToggleSave}
                      onOpenAgentProfile={openAgentProfile}
                      viewerHandle={conversation.viewerHandle}
                      plainMentions={plainMentions}
                      taskReferences={taskReferences}
                      onOpenTask={openTaskReference}
                      channelNames={channelNames}
                      onQuoteSelection={canCompose ? quoteSelection : undefined}
                    />
                  );
                })}
                {shownOutbox.map((entry, index) => (
                  <OutboxMessageRow
                    key={entry.localId}
                    entry={entry}
                    grouped={index > 0 || outboxContinuesRun}
                    composerShown={canCompose}
                    plainMentions={plainMentions}
                    viewerHandle={conversation.viewerHandle}
                    taskReferences={taskReferences}
                    onOpenTask={openTaskReference}
                    onRetry={() => outbox.retry(entry)}
                    onEdit={() => outbox.edit(entry)}
                    onDiscard={() => outbox.remove(entry)}
                  />
                ))}
              </ol>
            )}
            {!root &&
              conversation.hasNewer &&
              onLoadNewer && (
                // An empty sentinel below the newest row: coming into view asks for the page that
                // restores the evicted tail. Nothing is shown for it — the reader reached the bottom
                // and the tail is on its way.
                <div ref={newerSentinelRef} aria-hidden="true" className="h-8" />
              )}
          </div>
        </div>
        {(ownMessages.length > 0 || !followingLatest) && (
          // Anchored to the composer's top-right corner: the overlay repeats the composer's column
          // and side margins, so the group sits right above the composer's edge at any width
          // rather than at the far pane edge beside the scrollbar.
          <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10">
            <div
              className={cn(
                root ? undefined : MESSAGE_COLUMN_CLASS,
                "flex justify-end px-4 md:px-6",
              )}
            >
              <div
                role="group"
                aria-label={m.conversation_message_navigation()}
                className={cn(
                  "pointer-events-auto inline-flex items-center gap-0.5 rounded-full border border-secondary bg-primary p-0.5 shadow-xs transition-opacity",
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
            </div>
          </div>
        )}
      </div>

      <div className={root ? undefined : MESSAGE_COLUMN_CLASS}>
        {readOnlyNotice ?? (
          <MessageComposer
            conversationId={conversation.conversationId}
            threadRootId={root?.id}
            inThread={Boolean(root)}
            mentionables={mentionCandidates}
            mentionOutsiders={conversation.mentionOutsiders}
            recentHandles={recentHandles}
            channels={channels}
            onSend={onSend}
            onCreateTask={onCreateTask}
            onSent={ownIndex.add}
            quotedDraft={quotedDraft}
          />
        )}
      </div>
    </div>
  );
}

/** The part of a row the reading position holds still: its text (`data-scroll-anchor`), or the
 * row itself for a row that marks none. A folded group's summary comes before any of its rows. */
function scrollAnchorOf(row: HTMLElement): HTMLElement {
  return row.querySelector<HTMLElement>("[data-scroll-anchor]") ?? row;
}
