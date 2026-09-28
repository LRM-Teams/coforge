import {
  WORKSPACE_PROTOCOL_MAJOR,
  encodeAgentInboxPurge,
  type AgentInboxPurgeReason,
} from "@lrm/coforge-sdk/internal";

import type { PrismaClient } from "#src/generated/prisma/client";
import {
  createCentrifugoServerApi,
  daemonControlChannel,
  type CentrifugoServerApi,
} from "#src/server/centrifugo/server-api.server";
import { channelTarget } from "#src/server/conversations/agent-delivery.server";

export type AgentInboxPurgeRequest = {
  workspaceId: string;
  agentId: string;
  /** The channels the Agent just stopped belonging to. Non-channel ids are ignored. */
  conversationIds: readonly string[];
  reason: AgentInboxPurgeReason;
};

/**
 * Publishes one `AgentInboxPurge` on the Agent's daemon control channel once a channel
 * membership has ended: the Agent left, was removed, or went private. It resolves the Agent's
 * Computer and each channel's daemon target itself, so callers pass only ids.
 *
 * Best effort and fire-and-forget: an Agent on no Computer has no daemon to tell, and a failed
 * publication is logged, never thrown. The daemon `ready` replay separately skips channels the
 * Agent has left (`readPendingAgentDeliveries`), so a missed purge cannot bring the messages back
 * after a reconnect.
 *
 * Without an injected Centrifugo client it builds the production one per publication, so a
 * composition that forgot to wire it still purges.
 */
export class AgentInboxPurgePublisher {
  constructor(
    private readonly db: Pick<PrismaClient, "agent" | "conversation">,
    private readonly centrifugo?: Pick<CentrifugoServerApi, "publish">,
  ) {}

  /** Never rejects: the membership change has already committed. */
  async purge(request: AgentInboxPurgeRequest): Promise<void> {
    if (request.conversationIds.length === 0) return;
    try {
      const agent = await this.db.agent.findFirst({
        where: { id: request.agentId, workspaceId: request.workspaceId },
        select: { computerId: true },
      });
      if (!agent?.computerId) return;
      const rows = await this.db.conversation.findMany({
        where: {
          id: { in: [...request.conversationIds] },
          workspaceId: request.workspaceId,
          channelName: { not: null },
        },
        select: { id: true, channelName: true },
      });
      const nameById = new Map(rows.map((row) => [row.id, row.channelName!]));
      const channels = request.conversationIds.flatMap((id) => {
        const name = nameById.get(id);
        return name ? [{ id, target: channelTarget(name) }] : [];
      });
      if (channels.length === 0) return;
      await (this.centrifugo ?? createCentrifugoServerApi()).publish(
        daemonControlChannel(request.workspaceId, agent.computerId),
        encodeAgentInboxPurge({
          protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
          requestId: crypto.randomUUID(),
          workspaceId: request.workspaceId,
          computerId: agent.computerId,
          agentId: request.agentId,
          conversationIds: channels.map((channel) => channel.id),
          targets: channels.map((channel) => channel.target),
          reason: request.reason,
        }),
      );
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "agent_inbox_purge:publish_failed",
          workspace_id: request.workspaceId,
          agent_id: request.agentId,
          reason: request.reason,
          conversation_count: request.conversationIds.length,
          error_type: error instanceof Error ? error.name : typeof error,
        }),
      );
    }
  }
}
