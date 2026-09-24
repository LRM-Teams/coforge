import {
  agentReadableBody,
  deliveryMentionsAgent,
  type MessageMentionRef,
} from "./mentions.server";

declare const projected: unique symbol;

/**
 * Marks, in the type only, a record built by spreading `agentMessageView`. It carries no runtime
 * field. `test/agent-delivery-choke-point.test.ts` requires it on every Agent-facing read of the
 * conversation repository, so a serializer that fills `body` itself fails to type-check.
 */
export type AgentMessageViewMark = { readonly [projected]?: true };

/** A stored message as the Agent projection needs it: its body and the mention rows that resolve
 * the body's mention tokens, plus an action card's state when the reader shows one. */
type StoredAgentMessage = {
  body: string;
  mentions: readonly MessageMentionRef[];
  actionCard?: { state: string } | null;
};

/**
 * The one projection of a stored message onto every Agent-facing record: the Agent HTTP reads
 * (read, search, resolve, events, pending and recent context) and the daemon's recovery and
 * pending deliveries. Daemon pushes go through `encodeAgentDelivery` instead. Spread it into the
 * record.
 *
 * - `body` reads every stored token (`<@agent:…>`, `<@task:N>`, `<@channel:…>`) back as text, so
 *   none reaches an Agent.
 * - An action card's current state is appended to the body, so an Agent never treats a card that
 *   has not been acted on as a committed resource.
 * - With a `readerAgentId`, `mentionsAgent: true` is present when the message personally mentions
 *   that Agent.
 */
export function agentMessageView(
  message: StoredAgentMessage,
  readerAgentId?: string,
): { body: string; mentionsAgent?: true } & AgentMessageViewMark {
  const text = agentReadableBody(message.body, message.mentions);
  const body = message.actionCard ? `${text} [action card: ${message.actionCard.state}]` : text;
  return readerAgentId && deliveryMentionsAgent(message.mentions, readerAgentId)
    ? { body, mentionsAgent: true }
    : { body };
}
