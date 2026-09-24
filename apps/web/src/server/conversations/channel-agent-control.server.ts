import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { CHANNEL_AGENT_GUIDANCE_MAX_LENGTH } from "#src/lib/channel-agent-guidance";
import type { AgentControl } from "#src/server/agents/agent-control.server";
import type { ComputerStatusCache } from "#src/server/centrifugo/computer-status.server";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import { ACTIVE_MEMBER_WHERE, VISIBLE_CONVERSATION_WHERE } from "./active-member.server";

/** The first turn of every Agent a member resumes in a channel. */
function resumePrompt(channelName: string, username: string, guidance: string) {
  return `[SOS] All Agents in #${channelName} were emergency-stopped because they were going off-track. Here is @${username}'s correction and new guidance:

${guidance}

Read this carefully, acknowledge the correction, and adjust your approach accordingly. Use \`coforge message check\` and \`coforge message read --target '#${channelName}'\` to understand the current state before taking any action.`;
}

/**
 * A channel's "Stop all Agents" and "Resume all": any member of a live (unarchived) channel
 * stops every Agent in it that is not already stopped (`AgentControl.stopMany`), and resumes the
 * stopped ones with their guidance as the first turn (`AgentControl.startMany`).
 *
 * An Agent whose stop is still being sent ("stopping") counts as not yet stopped, so stopping
 * again resends it. An Agent this Workspace cannot control (its Computer or owner is no longer in
 * the Workspace, which `AgentControlStore.get` also refuses) is left out rather than reported as
 * a failure every time. One query finds the channel, the actor's membership and the Agents.
 *
 * A stopped Agent whose Computer is offline is not resumed: its Daemon would get the Start only
 * from ready recovery, which never carries the guidance. It stays stopped and is counted as
 * `offline`, so resuming again once the Computer is back reaches it.
 */
export class ChannelAgentControl {
  constructor(
    private readonly db: PrismaClient,
    private readonly control: Pick<AgentControl, "stopMany" | "startMany">,
    private readonly presence: Pick<ComputerStatusCache, "get">,
  ) {}

  async stopAll(workspaceId: string, userId: string, channelId: string) {
    const { agents } = await this.channelAgents(workspaceId, userId, channelId, {
      OR: [{ stoppedAt: null }, { controlState: { path: ["phase"], equals: "stopping" } }],
    });
    const agentIds = agents.map(({ id }) => id);
    const { done, failed } = count(
      agentIds.length ? await this.control.stopMany({ userId, workspaceId, agentIds }) : [],
    );
    return { stopped: done, failed };
  }

  async resumeAll(workspaceId: string, userId: string, channelId: string, guidance: string) {
    const trimmed = guidance.trim();
    if (!trimmed || trimmed.length > CHANNEL_AGENT_GUIDANCE_MAX_LENGTH)
      throw new AppError("INVALID_INPUT");
    const { agents, channelName, username } = await this.channelAgents(
      workspaceId,
      userId,
      channelId,
      { stoppedAt: { not: null } },
    );
    // One presence read per Computer, however many of its Agents are in the channel.
    const computerIds = [...new Set(agents.map(({ computerId }) => computerId))];
    const online = new Set(
      (
        await Promise.all(
          computerIds.map(async (computerId) =>
            (await this.presence.get({ workspaceId, computerId })) ? [computerId] : [],
          ),
        )
      ).flat(),
    );
    const agentIds = agents.flatMap(({ id, computerId }) => (online.has(computerId) ? [id] : []));
    const { done, failed } = count(
      agentIds.length
        ? await this.control.startMany({
            userId,
            workspaceId,
            agentIds,
            resumePrompt: resumePrompt(channelName, username, trimmed),
          })
        : [],
    );
    return { resumed: done, failed, offline: agents.length - agentIds.length };
  }

  /** The channel's controllable Agents matching `agentWhere`, once the actor is found to be a
   * member of the live channel. */
  private async channelAgents(
    workspaceId: string,
    userId: string,
    channelId: string,
    agentWhere: Prisma.AgentWhereInput,
  ) {
    const channel = await this.db.conversation.findFirst({
      where: {
        id: channelId,
        workspaceId,
        channelName: { not: null },
        ...VISIBLE_CONVERSATION_WHERE,
      },
      select: {
        channelName: true,
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
                  ...agentWhere,
                },
              },
            ],
          },
          select: {
            agent: { select: { id: true, computerId: true } },
            user: { select: { id: true, username: true } },
          },
        },
      },
    });
    if (!channel) throw new AppError("NOT_FOUND");
    const actor = channel.members.find((member) => member.user?.id === userId)?.user;
    if (!actor) throw new AppError("ACCESS_DENIED");
    if (channel.archivedAt) throw new AppError("CONFLICT");
    return {
      channelName: channel.channelName!,
      username: actor.username,
      agents: channel.members.flatMap(({ agent }) =>
        agent?.computerId ? [{ id: agent.id, computerId: agent.computerId }] : [],
      ),
    };
  }
}

function count(results: readonly { done: boolean }[]) {
  const done = results.filter((result) => result.done).length;
  return { done, failed: results.length - done };
}
