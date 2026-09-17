import type { MessageTaskMetadata } from "../internal/local-daemon";

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
  sender: string;
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
  requestId: string;
  messages: AgentMessage[];
  hasOlder: boolean;
  hasNewer: boolean;
  olderCursor?: string;
  newerCursor?: string;
};

/** Response for the dedicated search route (GET /api/agent/v1/messages/search). */
export type AgentSearchResponse = {
  protocolMajor: 1;
  requestId: string;
  results: AgentMessage[];
};

/** Response for the send route (POST /api/agent/v1/messages). */
export type AgentSendResponse = {
  protocolMajor: 1;
  requestId: string;
  state: "sent" | "held" | "denied";
  messageId?: string;
  holdToken?: string;
  /** True when a freshness hold was overridden with `continueAnyway`; the message still sent. */
  bypass?: boolean;
  anywayAllowed?: boolean;
  /** Held-context messages the Agent should review before resending; empty when `state` is `"sent"`. */
  context: AgentMessage[];
  freshnessContextMode?: "inline" | "withheld";
  withheldMessageCount?: number;
  /** Only for `state: "sent"`: pending messages bypassed via `continueAnyway`; empty otherwise. */
  recentUnread?: AgentMessage[];
};

/** Response for the resolve route (GET /api/agent/v1/messages/:id/resolve). */
export type AgentResolveResponse = {
  protocolMajor: 1;
  requestId: string;
  message: AgentMessage;
};

/** Response for the reaction routes (POST/DELETE /api/agent/v1/messages/:id/reactions). */
export type AgentReactionResponse = {
  protocolMajor: 1;
  requestId: string;
  messageId: string;
  emoji: string;
  active: boolean;
};

/** Response for the events drain route (GET /api/agent/v1/events); its own shape, not the shared message envelope. */
export type AgentEventsResponse = {
  protocolMajor: 1;
  requestId: string;
  events: AgentMessage[];
  hasMore: boolean;
};

/** Response for the channel mute/unmute routes. */
export type AgentChannelAttentionResponse = {
  protocolMajor: 1;
  requestId: string;
  target: string;
  muted: boolean;
};

/** Response for the thread unfollow route. */
export type AgentThreadAttentionResponse = {
  protocolMajor: 1;
  requestId: string;
  target: string;
  followed: false;
};
