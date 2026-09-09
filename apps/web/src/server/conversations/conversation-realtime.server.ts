import {
  conversationRealtimeChannel,
  type MessageAvailableEvent,
} from "../../features/conversations/conversation-realtime";
import type { CentrifugoServerApi } from "../centrifugo/server-api.server";

export type ConversationRealtime = {
  messageAvailable(input: {
    conversationId: string;
    messageId: string;
    sequence: number;
    publicationId?: string;
  }): Promise<void>;
};

export class CentrifugoConversationRealtime implements ConversationRealtime {
  constructor(private readonly centrifugo: CentrifugoServerApi) {}

  async messageAvailable(input: {
    conversationId: string;
    messageId: string;
    sequence: number;
    publicationId?: string;
  }) {
    const { publicationId, ...message } = input;
    const event: MessageAvailableEvent = {
      type: "message.available.v1",
      ...message,
    };
    await this.centrifugo.publishJson(
      conversationRealtimeChannel(input.conversationId),
      event,
      publicationId ?? input.messageId,
    );
  }
}
