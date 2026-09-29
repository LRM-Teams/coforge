import {
  AGENT_MESSAGE_METHOD,
  WORKSPACE_PROTOCOL_MAJOR,
  encodeAgentMessageDelivery,
  type MentionDeliveryEnvelope,
} from "@lrm/coforge-sdk/internal";
import {
  daemonControlChannel,
  type CentrifugoServerApi,
} from "#src/server/centrifugo/server-api.server";
import type { PendingAgentDelivery } from "#src/server/db/repositories/direct-conversation.repositories.server";
import type { MentionDeliveryIssuer } from "./mention-deliveries.server";
import { agentReadableBody, type MessageMentionRef } from "./mentions.server";

type AgentMessageDelivery = Parameters<typeof encodeAgentMessageDelivery>[0];

/** The target an Agent's daemon knows a channel by: `#` and the channel name. */
export function channelTarget(channelName: string): string {
  return `#${channelName}`;
}

/**
 * The one way a message is encoded for an Agent's daemon. Its body always goes through
 * `agentReadableBody` here, with the message's mention rows, so no stored token (`<@agent:…>`,
 * `<@task:N>`, `<@channel:…>`, `<@thread:…>`) ever reaches a daemon, whichever path sends it. A body that is
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

/** One committed delivery to push, and the Computer its Agent is on (none: not pushed). */
export type AgentDeliveryPush = Omit<
  Parameters<typeof encodeAgentDelivery>[0],
  "workspaceId" | "mentionDelivery"
> & { computerId: string | null };

/**
 * Pushes committed deliveries to their Agents' daemons. The deliveries that personally mention
 * their Agent are issued as tracked mentions first, and a push to a running Agent carries its
 * envelope; a mention that could not be issued goes out untracked (`MentionDeliveryIssuer` logs
 * it). Every push is attempted; the caller decides what a failed one means.
 */
export class AgentDeliveryPublisher {
  constructor(
    private readonly api: Pick<CentrifugoServerApi, "publish">,
    private readonly mentions?: Pick<MentionDeliveryIssuer, "issue">,
  ) {}

  async publish(
    workspaceId: string,
    pushes: readonly AgentDeliveryPush[],
  ): Promise<PromiseSettledResult<void>[]> {
    if (!pushes.length) return [];
    const envelopes = await this.mentions?.issue(
      workspaceId,
      pushes.map((push) => ({
        deliveryId: push.deliveryId,
        agentId: push.agentId,
        mentionsAgent: push.mentionsAgent === true,
      })),
    );
    return Promise.allSettled(
      pushes.flatMap(({ computerId, ...push }) =>
        computerId
          ? [
              // Deferred so a synchronous publisher failure settles like an async one.
              Promise.resolve().then(() =>
                this.api.publish(
                  daemonControlChannel(workspaceId, computerId),
                  encodeAgentDelivery({
                    ...push,
                    workspaceId,
                    mentionDelivery: envelopes?.get(push.deliveryId),
                  }),
                ),
              ),
            ]
          : [],
      ),
    );
  }
}

/** Pushes a delivery the Agent has not received again, as the repository reads it back. */
export function publishPendingDelivery(
  api: Pick<CentrifugoServerApi, "publish">,
  scope: { workspaceId: string; computerId: string; agentId: string },
  delivery: PendingAgentDelivery,
  tracked?: { mentionDelivery?: MentionDeliveryEnvelope },
): Promise<void> {
  return api.publish(
    daemonControlChannel(scope.workspaceId, scope.computerId),
    encodeAgentDelivery({
      requestId: crypto.randomUUID(),
      workspaceId: scope.workspaceId,
      agentId: scope.agentId,
      ...delivery,
      // Pending deliveries are already read back as text; reading again is a no-op.
      mentions: [],
      // A tracked mention is re-sent as one, whatever its stored mention rows say.
      ...(tracked ? { mentionsAgent: true, mentionDelivery: tracked.mentionDelivery } : {}),
    }),
  );
}
