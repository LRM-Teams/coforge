import type { ReactNode } from "react";
import type { TaskView } from "@lrm/coforge-sdk/internal";

import type { AgentProfileTab } from "#src/features/agents/profile-panel/profile-panel-search";
import type { ThreadFollow } from "./thread-pane-header";
import type { Mentionable } from "./mention-text";
import type { ChipMention } from "./message-markdown";
import type { OwnMessageIndexEntry } from "./own-messages-menu";
import type { ChannelSuggestion } from "./reference-completion";

/** The browser's projection of a direct conversation or a public channel. */
export type DirectConversationView = {
  conversationId: string;
  senderMemberId: string;
  /** The viewer's read cursor over this view's messages: the channel's member
   * cursor for a channel pane, that thread's `thread_reads` cursor for a thread pane. The
   * first message past it is the first unread; the initial view positions there and draws the
   * divider. Absent for a non-member, a fully-read fresh seed, or an unvisited thread. */
  readThroughSequence?: number;
  threadReadThrough?: Record<string, number>;
  hasOlder?: boolean;
  hasNewer?: boolean;
  agent: {
    id: string;
    name: string;
    displayName: string;
    deletedAt?: Date | null;
    avatarUrl?: string | null;
  };
  /** Whether the viewer may still send here: a private Agent's DM stays scoped to its
   * own creator, so an existing DM held by anyone else reads read-only once it goes private.
   * The server enforces the same rule on send; this only chooses the composer or the notice. */
  dmWritable?: boolean;
  /** The viewing user's `@handle`; powers the stronger "mentioned me" chip, and lets the composer
   * drop the viewer from its candidate list. Absent for a non-member. */
  viewerHandle?: string;
  /** The composer's @-completion source *and* the resolver for a body's `<@kind:uuid>` tokens:
   * every active member, the viewer included. Absent for a non-member. */
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
    /** True when the sending Agent has since been deleted. */
    senderDeleted?: boolean;
    senderAvatarUrl?: string | null;
    body: string;
    createdAt: Date | string;
    /** Resolved mention rows for the body's embedded `<@kind:uuid>` tokens. */
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

export type ConversationProps = {
  conversation: DirectConversationView;
  agentStatus?: "active" | "inactive";
  onSend: (
    body: string,
    requestId: string,
    attachmentIds?: string[],
    threadRootId?: string,
  ) => Promise<OwnMessageIndexEntry | void>;
  onLoadOlder?: () => Promise<void>;
  /** Fetch the next page towards the live end once the bounded window's oldest page has pushed the
   * tail out of the loaded pages. */
  onLoadNewer?: () => Promise<void>;
  onLoadOwnMessages?: (beforeSequence?: number) => Promise<{
    messages: OwnMessageIndexEntry[];
    hasOlder: boolean;
  }>;
  onLoadMessageAround?: (messageId: string) => Promise<void>;
  onShowLatest?: () => Promise<void>;
  onReadThread?: (rootMessageId: string, throughSequence: number) => Promise<void>;
  /**
   * The main pane reached the latest message by the user's own scrolling. Only the main pane
   * receives it (thread panes are separate `ConversationPane` instances and must never advance
   * the conversation cursor), and it is never fired by open positioning. Used by the
   * `newest-unread` open mode, where the cursor advances only through this callback.
   */
  onReadLatest?: (throughSequence: number) => void;
  tasks?: TaskView[];
  onCreateTask?: (title: string, requestId: string, attachmentId?: string) => Promise<void>;
  /** Toggles the viewer's own emoji reaction on a message; the route refreshes it. */
  onToggleReaction?: (messageId: string, emoji: string, active: boolean) => Promise<void>;
  onShowTasks?: () => void;
  onShowFiles?: () => void;
  /** Opens the Agent profile panel from an Agent sender's avatar/name; absent where the
   * conversation route does not own that slot. See `features/agents/profile-panel/`. */
  onOpenAgentProfile?: (agentId: string) => void;
  /** The Agent profile panel's URL state, owned by the route (`profile`/`agentTab` search
   * params via `features/agents/profile-panel/`), not by this feature. `agentId` undefined means
   * the panel is closed. */
  agentProfile?: { agentId: string | undefined; tab: AgentProfileTab | undefined };
  onAgentProfileTabChange?: (tab: AgentProfileTab) => void;
  onCloseAgentProfile?: () => void;
  /** The conversation's Tasks tab. When given it replaces the message stream in the main pane;
   * the Task popup and the thread/profile slot stay the conversation's, so a Task opened from
   * the board shows over it without leaving the tab. */
  tasksPane?: ReactNode;
};

export type ThreadedConversationProps = Omit<ConversationProps, "conversation" | "agentStatus"> & {
  conversation: Omit<DirectConversationView, "agent">;
  /** Plain-`@handle` display resolution for the stream (see `MessageBody`). Built by each
   * wrapper — the DM from its Agent counterpart, a channel from its member directory. */
  plainMentions?: Map<string, ChipMention>;
  header: ReactNode;
  readOnlyNotice?: ReactNode;
  emptyState: { title: string; description: string; media: ReactNode };
  threadHeaderAction?: (rootMessageId: string) => ReactNode;
  /** The viewer's follow state for a thread, where following is offered (channels). */
  threadFollow?: (rootMessageId: string) => ThreadFollow | undefined;
  /** `#channel` or the direct conversation's name, shown in the task popup's header. */
  conversationName: string;
  /** Where this conversation's threads live, named in each thread's header. */
  threadContext: string;
  /** Every channel of the Workspace, for a body's channel links and the composer's `#` list.
   * Under Chat it is read from the messages layout; a page outside Chat supplies it. */
  channels?: readonly ChannelSuggestion[];
  /** Shows only the Task popup (the Task and its thread), for a page other than the
   * conversation's own — the Tasks page — which opens and closes it through these controls
   * instead of the conversation's `task` search param. */
  taskPopup?: TaskPopupControls;
};

/** Which Task's popup is open, and how to open another or close it. */
export type TaskPopupControls = {
  openTaskNumber: number | undefined;
  openTask: (number: number) => void;
  closeTask: () => void;
};
