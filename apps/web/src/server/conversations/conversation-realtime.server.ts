import {
  conversationRealtimeChannel,
  workspaceConversationChannel,
  type MessageAvailableEvent,
} from "../../features/conversations/conversation-realtime";
import type { CentrifugoServerApi } from "../centrifugo/server-api.server";

export type ConversationRealtimeMessage = {
  conversationId: string;
  messageId: string;
  sequence: number;
  /** The message's Workspace; scopes the workspace-level signal fan-out. */
  workspaceId?: string;
  /** Present only for a thread reply (channel unread never counts thread replies). */
  threadRootId?: string;
};

export type ConversationRealtime = {
  messageAvailable(input: ConversationRealtimeMessage & { publicationId?: string }): Promise<void>;
};

export class CentrifugoConversationRealtime implements ConversationRealtime {
  constructor(private readonly centrifugo: CentrifugoServerApi) {}

  async messageAvailable(input: ConversationRealtimeMessage & { publicationId?: string }) {
    const { publicationId, ...message } = input;
    const event: MessageAvailableEvent = {
      type: "message.available.v1",
      ...message,
    };
    const idempotencyKey = publicationId ?? input.messageId;
    // The per-conversation channel drives the open conversation's reconciliation; the
    // workspace channel drives the sidebar's unread counts for every other channel.
    await Promise.all([
      this.centrifugo.publishJson(
        conversationRealtimeChannel(input.conversationId),
        event,
        idempotencyKey,
      ),
      input.workspaceId
        ? this.centrifugo.publishJson(
            workspaceConversationChannel(input.workspaceId),
            event,
            idempotencyKey,
          )
        : Promise.resolve(),
    ]);
  }
}
