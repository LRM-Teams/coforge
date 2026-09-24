import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import type { AgentControl } from "#src/server/agents/agent-control.server";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import { ACTIVE_MEMBER_WHERE, VISIBLE_CONVERSATION_WHERE } from "./active-member.server";

/**
 * A channel's "Stop all Agents": any member of a live (unarchived) channel stops every Agent in
 * it that is not already stopped, through `AgentControl.stopMany`. An Agent whose stop is still
 * being sent ("stopping") counts as not yet stopped, so trying again resends it. An Agent this
 * Workspace cannot control (its Computer or owner is no longer in the Workspace, which
 * `AgentControlStore.get` also refuses) is left out rather than reported as a failure every time.
 * One query finds the channel, the actor's membership and the Agents to stop.
 */
export class ChannelAgentStop {
  constructor(
    private readonly db: PrismaClient,
    private readonly control: Pick<AgentControl, "stopMany">,
  ) {}

  async stopAll(workspaceId: string, userId: string, channelId: string) {
    const channel = await this.db.conversation.findFirst({
      where: {
        id: channelId,
        workspaceId,
        channelName: { not: null },
        ...VISIBLE_CONVERSATION_WHERE,
      },
      select: {
        archivedAt: true,
        members: {
          where: {
            ...ACTIVE_MEMBER_WHERE,
            OR: [
              { userId },
              {
                agent: {
                  ...ACTIVE_AGENT_WHERE,
                  computer: { workspaces: { some: { workspaceId } } },
                  owner: { memberships: { some: { workspaceId } } },
                  OR: [
                    { stoppedAt: null },
                    { controlState: { path: ["phase"], equals: "stopping" } },
                  ],
                },
              },
            ],
          },
          select: { userId: true, agentId: true },
        },
      },
    });
    if (!channel) throw new AppError("NOT_FOUND");
    if (!channel.members.some((member) => member.userId === userId))
      throw new AppError("ACCESS_DENIED");
    if (channel.archivedAt) throw new AppError("CONFLICT");
    const agentIds = channel.members.flatMap(({ agentId }) => (agentId ? [agentId] : []));
    if (agentIds.length === 0) return { stopped: 0, failed: 0 };
    const results = await this.control.stopMany({ userId, workspaceId, agentIds });
    const stopped = results.filter((result) => result.stopped).length;
    return { stopped, failed: results.length - stopped };
  }
}
