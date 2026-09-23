import {
  AGENT_MESSAGE_METHOD,
  WORKSPACE_PROTOCOL_MAJOR,
  encodeAgentMessageDelivery,
} from "@lrm/coforge-sdk/internal";

import { agentReadableBody, type MessageMentionRef } from "./mentions.server";

type AgentMessageDelivery = Parameters<typeof encodeAgentMessageDelivery>[0];

/**
 * The one way a message is encoded for an Agent's daemon. Its body always goes through
 * `agentReadableBody` here, with the message's mention rows, so no stored token (`<@agent:…>`,
 * `<@task:N>`, `<@channel:…>`) ever reaches a daemon, whichever path sends it. A body that is
 * already readable reads back unchanged.
 */
export function encodeAgentDelivery(
  delivery: Omit<AgentMessageDelivery, "protocolMajor" | "method"> & {
    mentions: readonly MessageMentionRef[];
  },
): Uint8Array {
  const { mentions, body, ...rest } = delivery;
  return encodeAgentMessageDelivery({
    ...rest,
    protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
    method: AGENT_MESSAGE_METHOD,
    body: agentReadableBody(body, mentions),
  });
}
