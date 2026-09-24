import type { MessageTaskMetadata } from "#src/internal/local-daemon";
import type { MessageSenderKind } from "#src/internal/message-sender";

export type AgentMessageOperation = "read" | "search" | "send";

export type AgentMessagesReadRequest = {
  target: string;
  before?: string;
  after?: string;
  around?: string;
  limit?: number;
};

export type AgentMessagesSearchRequest = {
  query: string;
  target?: string;
  sender?: string;
  sort?: "relevance" | "recent";
  /** Only messages sent before this ISO time. */
  before?: string;
  /** Only messages sent after this ISO time. */
  after?: string;
  offset?: number;
  limit?: number;
};

export type AgentMentionSelector = { type: "user" | "agent"; id: string; name: string };

export type AgentMessagesSendRequest = {
  target: string;
  body: string;
  sendDraft?: boolean;
  continueAnyway?: boolean;
  freshnessContextMode?: "inline" | "withheld";
  /** Attachments already uploaded to this conversation, unlinked to any message, in send order.
   * Max 10, unique, each a UUID; enforced server-side. */
  attachmentIds?: string[];
  /** Structured @mention bindings; each bound handle must also appear as `@handle` in `body`. */
  mentions?: AgentMentionSelector[];
};

export type AgentMessagesResolveRequest = {
  messageId: string;
};

export type AgentEventsGetRequest = {
  limit?: number;
};

export type AgentMessagesReactionRequest = {
  messageId: string;
  emoji: string;
};

export type AgentMessage = {
  id: string;
  sequence: number;
  senderKind: MessageSenderKind;
  /** Public handle without a leading "@"; required for "human"/"agent", empty for "system". */
  senderHandle: string;
  /** The sender's role text; empty when there is none. */
  senderDescription: string;
  target: string;
  body: string;
  createdAt: string;
  /** Always present, possibly empty; order matches send/upload order. */
  attachments: {
    id: string;
    fileName: string;
    contentType: string;
    sizeBytes: number;
  }[];
  task?: MessageTaskMetadata;
};

/** Response for the read route (GET /api/agent/v1/messages, no `query`); its own shape, not the shared message envelope. */
export type AgentHistoryResponse = {
  protocolMajor: 1;
  idempotencyKey: string;
  messages: AgentMessage[];
  hasOlder: boolean;
  hasNewer: boolean;
  olderCursor?: string;
  newerCursor?: string;
};

/** Response for the dedicated search route (GET /api/agent/v1/messages/search). */
export type AgentSearchResponse = {
  protocolMajor: 1;
  idempotencyKey: string;
  results: AgentMessage[];
};

/** Response for the send route (POST /api/agent/v1/messages); Raft 1.0.32's own send contract. */
export type AgentSendResponse = {
  protocolMajor: 1;
  idempotencyKey: string;
  state: "sent" | "held";
  decision: "forward" | "bypass" | "local_hold" | "syncing_hold";
  reason?: string;
  producerFactId?: string;
  messageId?: string;
  /** Held only: Raft's `available_actions` — `check_messages`, `send_draft`, `send_anyway`. */
  availableActions?: string[];
  /** Held only: an already-re-held draft may be forced with `--send-draft --anyway`. */
  continueAnywaySuggested?: boolean;
  /** Held only: the held context window, oldest to newest; empty when `state` is `"sent"`. */
  heldMessages?: AgentMessage[];
  newMessageCount?: number;
  shownMessageCount?: number;
  omittedMessageCount?: number;
  /** Held only: the boundary the Agent should treat as reviewed after this hold. */
  seenUpToSeq?: number;
  freshnessContextMode?: "inline" | "withheld";
  withheldMessageCount?: number;
  /** Sent only: pending messages a bypassed hold chose not to review; empty otherwise. */
  recentUnread?: AgentMessage[];
};

/** Response for the resolve route (GET /api/agent/v1/messages/:id/resolve). */
export type AgentResolveResponse = {
  protocolMajor: 1;
  idempotencyKey: string;
  message: AgentMessage;
};

/** Response for the reaction routes (POST/DELETE /api/agent/v1/messages/:id/reactions). */
export type AgentReactionResponse = {
  protocolMajor: 1;
  idempotencyKey: string;
  messageId: string;
  emoji: string;
  active: boolean;
};

/** Response for the events drain route (GET /api/agent/v1/events); its own shape, not the shared message envelope. */
export type AgentEventsResponse = {
  protocolMajor: 1;
  idempotencyKey: string;
  events: AgentMessage[];
  hasMore: boolean;
};

/** Response for the channel mute/unmute routes. */
export type AgentChannelAttentionResponse = {
  protocolMajor: 1;
  idempotencyKey: string;
  target: string;
  muted: boolean;
};

/** Response for the thread unfollow route. */
export type AgentThreadAttentionResponse = {
  protocolMajor: 1;
  idempotencyKey: string;
  target: string;
  followed: false;
};
