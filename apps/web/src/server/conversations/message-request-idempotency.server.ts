export type PersistedDirectMessage = {
  id: string;
  body: string;
  createdAt: Date;
  sequence: number;
  deliveryId?: string;
  workspaceId: string;
  agentId: string;
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
