import type { PrismaClient } from "#src/generated/prisma/client";
import { readMessageReferences } from "#src/lib/message-references";
import { agentReadableBody, type MessageMentionRef } from "./mentions.server";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import {
  agentVisibilityViewerForActor,
  visibleAgentWhere,
} from "#src/server/agents/agent-visibility.server";

/**
 * The `@handle`s a stored message still carries as text that name nobody the sender can see: no
 * human of the Workspace and no Agent visible to the sender. The send turned every mention of a
 * conversation member into a token with a mention row, so any other `@handle` reached no one; one
 * that names a Workspace human or a visible Agent is someone outside the conversation, which is
 * not "unresolved". The body is read as plain text first, so a stored token is never mistaken for
 * a handle. Reading the stored message (not the request) lets an idempotent replay report exactly
 * what the first send did. A body with no such `@handle` costs no query. First-appearance order,
 * each handle once.
 */
export async function unresolvedMentionHandles(
  db: Pick<PrismaClient, "workspaceMembership" | "agent">,
  workspaceId: string,
  sender: { userId: string } | { agentId: string },
  message: { body: string; mentions: readonly MessageMentionRef[] },
): Promise<string[]> {
  const mentioned = new Set(message.mentions.map((mention) => mention.handle));
  const handles = readMessageReferences(
    agentReadableBody(message.body, message.mentions),
  ).candidates.handles.filter((handle) => !mentioned.has(handle));
  if (!handles.length) return [];
  const viewer = await agentVisibilityViewerForActor(db, workspaceId, sender);
  const [humans, agents] = await Promise.all([
    db.workspaceMembership.findMany({
      where: { workspaceId, user: { username: { in: handles } } },
      select: { user: { select: { username: true } } },
    }),
    db.agent.findMany({
      where: {
        workspaceId,
        name: { in: handles },
        ...ACTIVE_AGENT_WHERE,
        ...visibleAgentWhere(viewer),
      },
      select: { name: true },
    }),
  ]);
  const known = new Set([
    ...humans.map((membership) => membership.user.username),
    ...agents.map((agent) => agent.name),
  ]);
  return handles.filter((handle) => !known.has(handle));
}
