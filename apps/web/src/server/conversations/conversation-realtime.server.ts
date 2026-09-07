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
  }): Promise<void>;
};

export class CentrifugoConversationRealtime implements ConversationRealtime {
  constructor(private readonly centrifugo: CentrifugoServerApi) {}

  async messageAvailable(input: { conversationId: string; messageId: string; sequence: number }) {
    const event: MessageAvailableEvent = {
      type: "message.available.v1",
      ...input,
    };
    await this.centrifugo.publishJson(
      conversationRealtimeChannel(input.conversationId),
      event,
      input.messageId,
    );
  }
}
