import {
  AGENT_MESSAGE_METHOD,
  WORKSPACE_PROTOCOL_MAJOR,
  encodeAgentMessageDelivery,
  isChannelMessageTarget,
} from "@coforge/protocol";
import type { CentrifugoServerApi } from "../centrifugo/server-api.server";
import { daemonControlChannel } from "../centrifugo/server-api.server";
import type { DirectConversationRepository } from "../db/repositories/direct-conversation.repositories.server";
import type { MessageRequestIdempotency } from "./message-request-idempotency.server";
import type { ConversationRealtime } from "./conversation-realtime.server";
import type { MessageNotifier } from "../notifications/web-push-composition.server";

export class ReadDirectMessages {
  constructor(private readonly conversations: DirectConversationRepository) {}

  async execute(input: { workspaceId: string; agentId: string; target: string }) {
    const userId = await this.conversations.userIdForUsername?.(input.target);
    if (!userId) throw new Error("target user not found");
    await this.conversations.getOrCreateUserAgent(input.workspaceId, userId, input.agentId);
    const messages = await this.conversations.readMessages?.(
      input.workspaceId,
      input.agentId,
      input.target,
    );
    if (!messages) throw new Error("message reading is unavailable");
    return messages;
  }
}

/** Persists a canonical User-Agent direct message before attempting transport publication. */
export class SendDirectMessage {
  constructor(
    private readonly conversations: DirectConversationRepository,
    private readonly idempotency: MessageRequestIdempotency,
    private readonly centrifugo: Pick<CentrifugoServerApi, "publish">,
    private readonly realtime?: ConversationRealtime,
    private readonly notifications?: MessageNotifier,
  ) {}

  async execute(input: {
    requestId: string;
    workspaceId: string;
    conversationId: string;
    senderMemberId: string;
    senderUserId: string;
    body: string;
    attachmentId?: string;
    threadRootId?: string;
  }) {
    if (!input.requestId || !input.body) throw new Error("invalid direct message");
    const message = await this.idempotency.execute(
      {
        workspaceId: input.workspaceId,
        senderKind: "user",
        senderId: input.senderUserId,
        requestId: input.requestId,
      },
      () =>
        this.conversations.sendMessage(
          input.conversationId,
          input.senderMemberId,
          input.senderUserId,
          input.body,
          input.attachmentId,
          input.threadRootId,
        ),
    );
    await this.publishBrowserEvent(message, input.conversationId);
    if (!message.agentId) throw new Error("message is not an Agent direct message");
    await this.publishUserMessageToAgent(input.requestId, input.conversationId, {
      ...message,
      agentId: message.agentId,
    });
    return message;
  }

  async executeFromAgent(input: {
    requestId: string;
    workspaceId: string;
    agentId: string;
    target: string;
    body: string;
  }) {
    if (
      !input.requestId ||
      !input.body ||
      (!input.target.startsWith("@") && !isChannelMessageTarget(input.target))
    )
      throw new Error("invalid agent direct message");
    const conversation = isChannelMessageTarget(input.target)
      ? await this.conversations.getAgentChannel?.(
          input.workspaceId,
          input.agentId,
          input.target.split(":")[0]!,
        )
      : await (async () => {
          const userId = await this.conversations.userIdForUsername?.(input.target);
          if (!userId) throw new Error("target user not found");
          return this.conversations.getOrCreateUserAgent(input.workspaceId, userId, input.agentId);
        })();
    if (!conversation) throw new Error("channel access is unavailable");
    const message = await this.idempotency.execute(
      {
        workspaceId: input.workspaceId,
        senderKind: "agent",
        senderId: input.agentId,
        requestId: input.requestId,
      },
      async () => {
        const persisted = await this.conversations.sendAgentMessage?.(
          conversation.id,
          input.agentId,
          input.body,
          undefined,
          input.target.split(":")[1],
        );
        if (!persisted) throw new Error("agent message persistence is unavailable");
        return persisted;
      },
    );
    await this.publishBrowserEvent(message, conversation.id);
    await this.notifications?.notifyMessage(message.id);
    return message;
  }

  private async publishBrowserEvent(
    message: { id: string; sequence: number },
    conversationId: string,
  ) {
    if (!this.realtime) return;
    try {
      await this.realtime.messageAvailable({
        conversationId,
        messageId: message.id,
        sequence: message.sequence,
      });
    } catch {
      // PostgreSQL remains canonical; browser reconciliation repairs a missed publication.
    }
  }

  private async publishUserMessageToAgent(
    requestId: string,
    conversationId: string,
    message: Awaited<ReturnType<DirectConversationRepository["sendMessage"]>>,
  ) {
    if (!message) throw new Error("message publication is unavailable");
    if (!message.deliveryId) throw new Error("message delivery is unavailable");
    if (
      !message.latestSender ||
      !/^@[a-z0-9](?:[a-z0-9_-]{1,30}[a-z0-9])?$/.test(message.latestSender)
    )
      throw new Error("message sender must be a public @username");
    if (!message.computerId) throw new Error("Agent is not assigned to a Computer");
    await this.centrifugo.publish(
      daemonControlChannel(message.workspaceId, message.computerId),
      encodeAgentMessageDelivery({
        protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
        requestId,
        messageId: message.id,
        deliveryId: message.deliveryId,
        sequence: message.sequence,
        workspaceId: message.workspaceId,
        conversationId,
        agentId: message.agentId,
        body: message.body,
        method: AGENT_MESSAGE_METHOD,
        target: message.deliveryTarget ?? message.latestSender,
        latestSender: message.latestSender,
      }),
    );
  }
}
