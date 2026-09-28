import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import {
  agentOfDirectKey,
  isPeopleDirectKey,
  peopleDirectKeyPair,
} from "#src/features/conversations/direct-key";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { openPeopleDirectConversation } from "./user-direct-conversations.server";

/** Who is on the other side of a direct conversation, from the viewer's seat. */
export type DirectConversationTarget =
  | { kind: "agent"; agentId: string }
  | { kind: "people"; peerUserId: string };

/**
 * A viewer's direct conversations addressed by id, the way their pages are (`dm/<id>`): opening
 * one with an Agent or a member, and reading back who a conversation is with.
 */
export class DirectConversations {
  constructor(private readonly db: PrismaClient) {}

  /** The viewer's conversation with their own Agent or a member, started on first open. */
  async open(
    workspaceId: string,
    viewerId: string,
    peer: { agentId: string } | { userId: string },
  ): Promise<{ conversationId: string }> {
    if ("userId" in peer)
      return openPeopleDirectConversation(this.db, workspaceId, viewerId, peer.userId);
    // A DM with an Agent is its creator's alone, and never starts with a deleted one.
    const own = await this.db.agent.findFirst({
      where: { id: peer.agentId, workspaceId, ownerId: viewerId, ...ACTIVE_AGENT_WHERE },
      select: { id: true },
    });
    if (!own) throw new AppError("ACCESS_DENIED");
    const conversation = await new PrismaDirectConversationRepository(this.db).getOrCreateUserAgent(
      workspaceId,
      viewerId,
      peer.agentId,
    );
    return { conversationId: conversation.id };
  }

  /** Who a direct conversation of the viewer's is with; NOT_FOUND for anything else. */
  async target(
    workspaceId: string,
    viewerId: string,
    conversationId: string,
  ): Promise<DirectConversationTarget> {
    const conversation = await this.db.conversation.findFirst({
      where: {
        id: conversationId,
        workspaceId,
        directKey: { not: null },
        members: { some: { userId: viewerId } },
      },
      select: { directKey: true },
    });
    const directKey = conversation?.directKey ?? null;
    if (directKey && isPeopleDirectKey(directKey)) {
      const [first, second] = peopleDirectKeyPair(directKey);
      return { kind: "people", peerUserId: first === viewerId ? second : first };
    }
    const agentId = agentOfDirectKey(directKey);
    if (!agentId) throw new AppError("NOT_FOUND");
    return { kind: "agent", agentId };
  }
}
