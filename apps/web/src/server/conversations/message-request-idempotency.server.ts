import type { LatestSenderFields } from "#src/server/db/repositories/direct-conversation.repositories.server";

export type PersistedDirectMessage = {
  id: string;
  body: string;
  createdAt: Date;
  sequence: number;
  /** The message's thread anchor, or null for a top-level message. Carried so the browser
   * signal can exclude thread replies from channel unread. Round-trips through
   * Redis with the rest of the persisted result on idempotent retries. */
  threadRootId: string | null;
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
} & Partial<LatestSenderFields>;

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
