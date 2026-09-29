import type { Prisma } from "#src/generated/prisma/client";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";

/**
 * The direct conversations a viewer's Direct messages list holds, by `DirectConversations.authorize`'s
 * rule: one between members that names them, or their own DM with an Agent they created. A deleted
 * Agent's DM stays readable by its link but leaves the list. A pin drag reads exactly these.
 */
export function viewerDirectConversationWhere(userId: string) {
  return {
    OR: [
      { directKey: { startsWith: "user:", contains: `user:${userId}` } },
      {
        directKey: { endsWith: `|user:${userId}` },
        members: { some: { agent: { ownerId: userId, ...ACTIVE_AGENT_WHERE } } },
      },
    ],
  } satisfies Prisma.ConversationWhereInput;
}
