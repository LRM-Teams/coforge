import {
  AGENT_MESSAGE_METHOD,
  WORKSPACE_PROTOCOL_MAJOR,
  encodeAgentMessageDelivery,
  isChannelMessageTarget,
  isPrintableSenderHandle,
} from "@lrm/coforge-sdk/internal";
import type { CentrifugoServerApi } from "../centrifugo/server-api.server";
import { daemonControlChannel } from "../centrifugo/server-api.server";
import type {
  DirectConversationRepository,
  LatestSenderFields,
} from "../db/repositories/direct-conversation.repositories.server";
import type { MessageRequestIdempotency } from "./message-request-idempotency.server";
import type { ConversationRealtime } from "./conversation-realtime.server";
import { agentReadableBody, deliveryMentionsAgent } from "./mentions";
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
    attachmentIds?: string[];
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
          input.attachmentIds,
          input.threadRootId,
        ),
    );
    // The sender's own message never bumps their own badge (the server's count excludes
    // self-authored messages), so a human-authored DM fans out to the conversation channel
    // only: the human is the only badge owner for this DM.
    await this.publishBrowserEvent(message, input.conversationId, {}, input.requestId);
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
    attachmentIds?: string[];
    mentions?: readonly { type: "user" | "agent"; id: string; name: string }[];
  }) {
    if (
      !input.requestId ||
      !input.body ||
      (!input.target.startsWith("@") && !isChannelMessageTarget(input.target))
    )
      throw new Error("invalid agent direct message");
    const isChannel = isChannelMessageTarget(input.target);
    const dmUserId = isChannel
      ? undefined
      : await (async () => {
          const userId = await this.conversations.userIdForUsername?.(input.target);
          if (!userId) throw new Error("target user not found");
          return userId;
        })();
    const conversation = isChannel
      ? await this.conversations.getAgentChannel?.(
          input.workspaceId,
          input.agentId,
          input.target.split(":")[0]!,
        )
      : await this.conversations.getOrCreateUserAgent(input.workspaceId, dmUserId!, input.agentId);
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
          input.attachmentIds,
          input.target.split(":")[1],
          input.mentions,
        );
        if (!persisted) throw new Error("agent message persistence is unavailable");
        return persisted;
      },
    );
    // A channel message fans out to the Workspace; a DM goes only to its human viewer, naming
    // the sending Agent's badge so the browser needs no conversation alias (ADR 0046).
    await this.publishBrowserEvent(
      message,
      conversation.id,
      isChannel
        ? { workspaceId: input.workspaceId }
        : { userId: dmUserId!, agentId: input.agentId },
    );
    await this.notifications?.notifyMessage(message.id);
    await this.publishAgentMentionDeliveries(input.requestId, conversation.id, message);
    return message;
  }

  /**
   * Push a committed channel Message to every other Agent it @mentions. Best effort: attention
   * is volatile, the canonical Message/read boundary recovers a missed publication, and a
   * publish failure must not reject a send the database already accepted.
   */
  private async publishAgentMentionDeliveries(
    requestId: string,
    conversationId: string,
    message: {
      id: string;
      sequence: number;
      body: string;
      workspaceId: string;
      target?: string;
      mentions?: { kind: string; actorId: string; handle: string }[];
      deliveries?: { deliveryId: string; agentId: string; computerId: string | null }[];
    } & Partial<LatestSenderFields>,
  ) {
    if (!message.deliveries?.length) return;
    // Agents read plain `@handle` text; the stored body keeps mentions as embedded-UUID tokens.
    const body = agentReadableBody(message.body, message.mentions ?? []);
    await Promise.allSettled(
      message.deliveries.flatMap((delivery) =>
        delivery.computerId
          ? [
              Promise.resolve().then(() =>
                this.centrifugo.publish(
                  daemonControlChannel(message.workspaceId, delivery.computerId!),
                  encodeAgentMessageDelivery({
                    protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
                    method: AGENT_MESSAGE_METHOD,
                    requestId,
                    workspaceId: message.workspaceId,
                    conversationId,
                    agentId: delivery.agentId,
                    messageId: message.id,
                    deliveryId: delivery.deliveryId,
                    sequence: message.sequence,
                    body,
                    target: message.target ?? "",
                    latestSenderKind: message.latestSenderKind,
                    latestSenderHandle: message.latestSenderHandle,
                    latestSenderDescription: message.latestSenderDescription,
                    mentionsAgent: deliveryMentionsAgent(message.mentions, delivery.agentId),
                  }),
                ),
              ),
            ]
          : [],
      ),
    );
  }

  private async publishBrowserEvent(
    message: { id: string; sequence: number; threadRootId?: string | null },
    conversationId: string,
    scope: { workspaceId?: string; userId?: string; agentId?: string },
    /** A person's send only: lets the sender's page match its pending copy. */
    requestId?: string,
  ) {
    if (!this.realtime) return;
    try {
      await this.realtime.messageAvailable({
        conversationId,
        messageId: message.id,
        sequence: message.sequence,
        ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}),
        ...(scope.userId ? { userId: scope.userId } : {}),
        ...(scope.agentId ? { agentId: scope.agentId } : {}),
        ...(message.threadRootId ? { threadRootId: message.threadRootId } : {}),
        ...(requestId ? { requestId } : {}),
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
    // This path only ever carries a human sender (a browser-authored direct message). The shared
    // `agentMessageSender` projection already failed loudly upstream if the handle could not be
    // resolved, but this guard checks something that projection cannot: that the resolved sender
    // is specifically `human` on this human-only send path (never `agent`, never absent), and
    // that the handle is well-formed. `encodeAgentMessageDelivery`'s own boundary check does not
    // cover an entirely absent `latestSenderKind`, so this stays the one place that does.
    if (
      message.latestSenderKind !== "human" ||
      !message.latestSenderHandle ||
      !isPrintableSenderHandle(message.latestSenderHandle)
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
        target: message.deliveryTarget ?? `@${message.latestSenderHandle}`,
        latestSenderKind: message.latestSenderKind,
        latestSenderHandle: message.latestSenderHandle,
        latestSenderDescription: message.latestSenderDescription,
      }),
    );
  }
}
