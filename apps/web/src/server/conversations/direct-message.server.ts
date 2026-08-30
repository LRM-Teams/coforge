import {
  AGENT_MESSAGE_METHOD,
  WORKSPACE_PROTOCOL_MAJOR,
  encodeAgentMessageDelivery,
} from "@coforge/protocol";
import type { CentrifugoServerApi } from "../centrifugo/server-api.server";
import { workspaceAgentChannel } from "../centrifugo/server-api.server";
import type { DirectConversationRepository } from "../db/repositories/direct-conversation.repositories.server";
import type { MessageRequestIdempotency } from "./message-request-idempotency.server";

/** Persists a canonical User-Agent direct message before attempting transport publication. */
export class SendDirectMessage {
  constructor(
    private readonly conversations: DirectConversationRepository,
    private readonly idempotency: MessageRequestIdempotency,
    private readonly centrifugo: CentrifugoServerApi,
  ) {}

  async execute(input: {
    requestId: string;
    workspaceId: string;
    conversationId: string;
    senderMemberId: string;
    senderUserId: string;
    body: string;
    attachmentId?: string;
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
        ),
    );
    await this.publishUserMessageToAgent(input.requestId, input.conversationId, message);
    return message;
  }

  /**
   * Agent messages are canonical history only for now. There is no formal
   * user conversation publication channel, so do not fake one with the Agent
   * delivery channel.
   */
  async executeFromAgent(input: {
    requestId: string;
    workspaceId: string;
    agentId: string;
    target: string;
    body: string;
  }) {
    if (!input.requestId || !input.body || !input.target.startsWith("@"))
      throw new Error("invalid agent direct message");
    const userId = await this.conversations.userIdForUsername?.(input.target);
    if (!userId) throw new Error("target user not found");
    const conversation = await this.conversations.getOrCreateUserAgent(
      input.workspaceId,
      userId,
      input.agentId,
    );
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
        );
        if (!persisted) throw new Error("agent message persistence is unavailable");
        return persisted;
      },
    );
    return message;
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
    await this.centrifugo.publish(
      workspaceAgentChannel(message.workspaceId),
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
        target: message.latestSender,
        latestSender: message.latestSender,
      }),
    );
  }
}
