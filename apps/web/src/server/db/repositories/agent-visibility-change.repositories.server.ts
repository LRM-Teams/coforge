import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { AGENT_VISIBILITY } from "#src/features/agents/agent-visibility";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import { ACTIVE_CHANNEL_MEMBER_WHERE } from "#src/server/conversations/active-member.server";
import type {
  AgentVisibilityChangePreview,
  ChangeAgentVisibilityStore,
} from "#src/server/agents/change-agent-visibility.server";

/**
 * The atomic visibility transition, scoped to a
 * still-live Agent (`ACTIVE_AGENT_WHERE`): a repeated call with the same visibility is a no-op
 * (`changed: false`) so a double submit never soft-leaves or re-joins twice.
 *
 * public → private soft-leaves every active channel membership in one `updateMany` — the same
 * `leftAt` representation `softLeaveMember`/`AgentDeletion` use, just
 * applied to every channel row at once rather than one conversation at a time. Direct
 * conversations are never touched here: they become read-only through the DM send/open guards in
 * `direct-conversation.repositories.server.ts`, not by leaving anything.
 *
 * private → public does not restore any channel membership. The Agent can be added to channels
 * explicitly later; DMs are unaffected by the channel visibility transition.
 */
export class PrismaChangeAgentVisibilityStore implements ChangeAgentVisibilityStore {
  constructor(private readonly db: PrismaClient) {}

  async apply(input: {
    agentId: string;
    workspaceId: string;
    visibility: string;
  }): Promise<{ changed: boolean; leftChannelIds: string[] }> {
    return this.db.$transaction(async (tx) => {
      const updated = await tx.agent.updateMany({
        where: {
          id: input.agentId,
          workspaceId: input.workspaceId,
          visibility: { not: input.visibility },
          ...ACTIVE_AGENT_WHERE,
        },
        data: { visibility: input.visibility },
      });
      if (updated.count === 0) return { changed: false, leftChannelIds: [] };
      if (input.visibility !== AGENT_VISIBILITY.PRIVATE)
        return { changed: true, leftChannelIds: [] };
      const left = await tx.conversationMember.updateManyAndReturn({
        where: {
          workspaceId: input.workspaceId,
          agentId: input.agentId,
          ...ACTIVE_CHANNEL_MEMBER_WHERE,
        },
        data: { leftAt: new Date() },
        select: { conversationId: true },
      });
      return { changed: true, leftChannelIds: left.map((row) => row.conversationId) };
    });
  }

  preview(input: { agentId: string; workspaceId: string }): Promise<AgentVisibilityChangePreview> {
    return previewAgentVisibilityChange(this.db, input);
  }
}

/**
 * The confirmation dialog's preview for a public→private change: which channels the Agent will
 * leave and how many existing direct conversations will stop accepting new messages. Read-only;
 * never mutates. Answers `{ channelNames: [], readOnlyDirectMessageCount: 0 }` for an Agent with
 * no channel or DM footprint, rather than failing.
 */
export async function previewAgentVisibilityChange(
  db: Pick<PrismaClient, "agent" | "conversationMember" | "conversation">,
  input: { workspaceId: string; agentId: string },
): Promise<AgentVisibilityChangePreview> {
  const agent = await db.agent.findFirst({
    where: { id: input.agentId, workspaceId: input.workspaceId },
    select: { ownerId: true },
  });
  if (!agent) return { channelNames: [], readOnlyDirectMessageCount: 0 };
  const [channelMemberships, readOnlyDirectMessageCount] = await Promise.all([
    db.conversationMember.findMany({
      where: {
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        ...ACTIVE_CHANNEL_MEMBER_WHERE,
      },
      select: { conversation: { select: { channelName: true } } },
    }),
    db.conversation.count({
      where: {
        workspaceId: input.workspaceId,
        directKey: { not: null },
        members: { some: { agentId: input.agentId } },
        NOT: { members: { some: { userId: agent.ownerId } } },
      } satisfies Prisma.ConversationWhereInput,
    }),
  ]);
  return {
    channelNames: channelMemberships
      .map((member) => member.conversation.channelName)
      .filter((name): name is string => name !== null),
    readOnlyDirectMessageCount,
  };
}
