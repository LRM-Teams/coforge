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

export type AgentMessagesSendRequest = {
  target: string;
  body: string;
  sendDraft?: boolean;
  continueAnyway?: boolean;
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

export type AgentMessagesResponse = {
  requestId: string;
  accepted: boolean;
  messages: readonly AgentMessage[];
  attentionCount?: number;
  messageId?: string;
  sideEffectDecision?: "forward" | "hold" | "anyway_denied" | "anyway_accepted";
};

export type AgentMessage = {
  id: string;
  sequence: number;
  sender: string;
  target: string;
  body: string;
  createdAt: string;
  attachment?: {
    id: string;
    fileName: string;
    contentType: string;
    sizeBytes: number;
  };
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
