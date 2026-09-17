export type PersistedDirectMessage = {
  id: string;
  body: string;
  createdAt: Date;
  sequence: number;
  /** Always present, possibly empty; order matches send/upload order. Not itself compared for
   * equality anywhere: a retried `requestId` returns this same persisted result verbatim
   * rather than recomputing or hashing it, so the array's order is preserved automatically by
   * round-tripping through storage. */
  attachments: {
    id: string;
    fileName: string;
    contentType: string;
    sizeBytes: number;
  }[];
  deliveryId?: string;
  workspaceId: string;
  agentId?: string;
  target?: string;
  latestSender?: string;
};

export type MessageRequestScope = {
  workspaceId: string;
  senderKind: "user" | "agent";
  senderId: string;
  requestId: string;
};

/** Short-lived duplicate suppression around canonical Message persistence. */
export interface MessageRequestIdempotency {
  execute(
    scope: MessageRequestScope,
    persist: () => Promise<PersistedDirectMessage>,
  ): Promise<PersistedDirectMessage>;
}

export class MessageRequestInProgressError extends Error {
  constructor() {
    super("message request is already processing; retry later");
    this.name = "MessageRequestInProgressError";
  }
}
