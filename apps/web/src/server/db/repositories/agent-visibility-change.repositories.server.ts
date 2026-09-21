import type { Prisma, PrismaClient } from "../../../../generated/client";
import { AGENT_VISIBILITY } from "../../../features/agents/agent-visibility";
import { ACTIVE_AGENT_WHERE } from "../../agents/active-agent.server";
import type { ChangeAgentVisibilityStore } from "../../agents/change-agent-visibility.server";

/**
 * The atomic visibility transition (ADR 0059 "Changing visibility, both directions"), scoped to a
 * still-live Agent (`ACTIVE_AGENT_WHERE`): a repeated call with the same visibility is a no-op
 * (`changed: false`) so a double submit never soft-leaves or re-joins twice.
 *
 * public → private soft-leaves every active channel membership including `#general` in one
 * `updateMany` — the same `leftAt` representation `softLeaveMember`/`AgentDeletion` use, just
 * applied to every channel row at once rather than one conversation at a time. Direct
 * conversations are never touched here: they become read-only through the DM send/open guards in
 * `direct-conversation.repositories.server.ts`, not by leaving anything.
 *
 * private → public re-joins `#general` only (ADR 0059 explicitly does not restore any other
 * channel membership): the row is upserted so a first-time membership and a re-join through a
 * soft-left row are the same write, and unrelated columns (read cursor, mute) survive a re-join
 * exactly as they do for a human (`ConversationMember.leftAt`'s own doc comment).
 */
export class PrismaChangeAgentVisibilityStore implements ChangeAgentVisibilityStore {
  constructor(private readonly db: PrismaClient) {}

  async apply(input: {
    agentId: string;
    workspaceId: string;
    visibility: string;
  }): Promise<{ changed: boolean }> {
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
      if (updated.count === 0) return { changed: false };
      if (input.visibility === AGENT_VISIBILITY.PRIVATE) {
        await tx.conversationMember.updateMany({
          where: {
            workspaceId: input.workspaceId,
            agentId: input.agentId,
            leftAt: null,
            conversation: { channelName: { not: null } },
          },
          data: { leftAt: new Date() },
        });
      } else {
        const general = await tx.conversation.upsert({
          where: {
            workspaceId_channelName: { workspaceId: input.workspaceId, channelName: "general" },
          },
          create: { workspaceId: input.workspaceId, channelName: "general" },
          update: {},
          select: { id: true },
        });
        await tx.conversationMember.upsert({
          where: { conversationId_agentId: { conversationId: general.id, agentId: input.agentId } },
          create: {
            workspaceId: input.workspaceId,
            conversationId: general.id,
            agentId: input.agentId,
          },
          update: { leftAt: null },
        });
      }
      return { changed: true };
    });
  }
}

export type AgentVisibilityChangePreview = {
  /** Names of the channels (including `#general`, unprefixed) a public→private change would
   * soft-leave; empty for an Agent already private or in no active channel. */
  channelNames: string[];
  /** Existing direct conversations that would become read-only: every DM the Agent has with
   * someone other than its own creator, who alone keeps write access to a private Agent's DM
   * (ADR 0059). Static for private→public (nothing becomes read-only), so the caller need not
   * call this for that direction. */
  readOnlyDirectMessageCount: number;
};

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
        leftAt: null,
        conversation: { channelName: { not: null } },
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
