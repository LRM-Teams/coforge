import type { AgentPendingMentionAction, MessageTaskMetadata } from "#src/internal/local-daemon";

export type { AgentPendingMentionAction };
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

/**
 * Which conversation a history read consumed (Raft 1.0.38's `consumption_scope`, whose `channel_id`
 * is CoForge's `conversationId`). Present for a direct conversation (`dm`) or a thread (`thread`),
 * whose target has more than one spelling; `target` is the spelling the server resolved it to.
 */
export type AgentHistoryConsumptionScope = {
  agentId: string;
  conversationId: string;
  channelType: "dm" | "thread";
  target: string;
};

/** Response for the read route (GET /api/agent/v1/messages, no `query`); its own shape, not the shared message envelope. */
export type AgentHistoryResponse = {
  idempotencyKey: string;
  messages: AgentMessage[];
  hasOlder: boolean;
  hasNewer: boolean;
  olderCursor?: string;
  newerCursor?: string;
  /** Raft 1.0.38's `model_seen_up_to_seq`: the newest sequence up to which the Agent has now seen
   * this target without a gap, or `null` when this page does not join what it had already read (an
   * anchored `around` read never does). */
  modelSeenUpToSeq: number | null;
  consumptionScope?: AgentHistoryConsumptionScope;
};

/** Response for the dedicated search route (GET /api/agent/v1/messages/search). */
export type AgentSearchResponse = {
  idempotencyKey: string;
  results: AgentMessage[];
};

/**
 * Response for the send route (POST /api/agent/v1/messages), Raft 1.0.38's send contract: a sent or
 * held send, or — for a `reconcileOnly` request — whether the idempotency key already committed.
 */
export type AgentSendResponse =
  | AgentSendDecisionResponse
  | AgentSendCommittedResponse
  | AgentSendNotFoundResponse;

/** The answer to a `reconcileOnly` request: whether this idempotency key already committed. */
export type AgentSendReconciliationResponse =
  | AgentSendCommittedResponse
  | AgentSendNotFoundResponse;

/** A `reconcileOnly` answer: this key's send was committed. Only the message id is known — the
 * original response is gone, so its delivery receipt (mention reports, recent unread) is not. */
export type AgentSendCommittedResponse = {
  idempotencyKey: string;
  state: "committed";
  reconciliation: true;
  receiptComplete: false;
  messageId: string;
};

/** A `reconcileOnly` answer: nothing was committed under this key, so replaying it is safe. */
export type AgentSendNotFoundResponse = {
  idempotencyKey: string;
  state: "not_found";
  reconciliation: true;
};

/** A send the server decided: sent, or held by the freshness check. */
export type AgentSendDecisionResponse = {
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
  /** Held: the boundary the Agent should treat as reviewed after this hold. Sent: the boundary the
   * server advanced over messages the Agent had already seen (Raft's consume effect), if any. */
  seenUpToSeq?: number;
  freshnessContextMode?: "inline" | "withheld";
  withheldMessageCount?: number;
  /** Sent only: pending messages a bypassed hold chose not to review; empty otherwise. */
  recentUnread?: AgentMessage[];
  /** Sent only: mentions of people outside the channel, which notified no one; the Agent acts on
   * them with `coforge mention`. */
  pendingMentionActions?: AgentPendingMentionAction[];
  /** Sent only: `@handle`s that name nobody the Agent can see. */
  unresolvedMentionHandles?: string[];
};

/** Response for the resolve route (GET /api/agent/v1/messages/:id/resolve). */
export type AgentResolveResponse = {
  idempotencyKey: string;
  message: AgentMessage;
};

/** Response for the reaction routes (POST/DELETE /api/agent/v1/messages/:id/reactions). */
export type AgentReactionResponse = {
  idempotencyKey: string;
  messageId: string;
  emoji: string;
  active: boolean;
};

/** Response for the events drain route (GET /api/agent/v1/events); its own shape, not the shared message envelope. */
export type AgentEventsResponse = {
  idempotencyKey: string;
  events: AgentMessage[];
  hasMore: boolean;
};

/** Response for the channel mute/unmute routes. */
export type AgentChannelAttentionResponse = {
  idempotencyKey: string;
  target: string;
  muted: boolean;
};

/** Response for the thread unfollow route. */
export type AgentThreadAttentionResponse = {
  idempotencyKey: string;
  target: string;
  followed: false;
};
