import {
  agentReadableBody,
  deliveryMentionsAgent,
  type MessageMentionRef,
} from "./mentions.server";

declare const readable: unique symbol;

/**
 * A message body as an Agent reads it: every stored token read back as text. Only
 * `agentMessageView` makes one (its single cast), and `test/agent-delivery-choke-point.test.ts`
 * requires this type on the `body` of every Agent-facing read of the conversation repository.
 *
 * So a repository serializer fails to type-check when it ships a stored body (`body: row.body`),
 * overrides the projected body after spreading the view, or edits the projected body (any string
 * operation returns a plain `string`).
 *
 * What it cannot catch: another `as AgentReadableBody` cast (the choke-point scan allows it only
 * here), an Agent-facing reader outside `PrismaDirectConversationRepository` that the check does
 * not list, and port-typed values such as test fakes, whose `body` is a plain `string`.
 */
export type AgentReadableBody = string & { readonly [readable]: true };

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
 * - `body` reads every stored token (`<@agent:…>`, `<@task:N>`, `<@channel:…>`, `<@thread:…>`)
 *   back as text, so none reaches an Agent.
 * - An action card's current state is appended to the body, so an Agent never treats a card that
 *   has not been acted on as a committed resource.
 * - With a `readerAgentId`, `mentionsAgent: true` is present when the message personally mentions
 *   that Agent.
 */
export function agentMessageView(
  message: StoredAgentMessage,
  readerAgentId?: string,
): { body: AgentReadableBody; mentionsAgent?: true } {
  const text = agentReadableBody(message.body, message.mentions);
  const body = (
    message.actionCard ? `${text} [action card: ${message.actionCard.state}]` : text
  ) as AgentReadableBody;
  return readerAgentId && deliveryMentionsAgent(message.mentions, readerAgentId)
    ? { body, mentionsAgent: true }
    : { body };
}
