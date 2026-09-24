import { MENTION_TOKEN_PATTERN, readableBody } from "@lrm/coforge-sdk/internal";
import type { PrismaClient } from "#src/generated/prisma/client";
import { readMessageReferences } from "#src/lib/message-references";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import {
  agentVisibilityViewerForActor,
  visibleAgentWhere,
} from "#src/server/agents/agent-visibility.server";

/**
 * The `@handle`s a stored body still carries as text that name nobody the sender can see: no
 * human of the Workspace and no Agent visible to the sender. The send turned every mention of a
 * conversation member into a token, so an `@handle` still written as text reached no one; one
 * that names a Workspace human or a visible Agent is someone outside the conversation, which is
 * not "unresolved". Every mention token is dropped before the body is read (a resolved mention,
 * or one the sender typed out), and the other tokens read back as their text, so no token is ever
 * mistaken for a handle. The stored body is what a replay reads too; the people and Agents it is
 * checked against are read at the time of the call. A body with no such `@handle` costs no query.
 * First-appearance order, each handle once.
 */
export async function unresolvedMentionHandles(
  db: Pick<PrismaClient, "workspaceMembership" | "agent">,
  workspaceId: string,
  sender: { userId: string } | { agentId: string },
  storedBody: string,
): Promise<string[]> {
  const text = readableBody(storedBody.replace(MENTION_TOKEN_PATTERN, ""), {
    mention: () => undefined,
  });
  const { handles } = readMessageReferences(text).candidates;
  if (!handles.length) return [];
  const humans = await db.workspaceMembership.findMany({
    where: { workspaceId, user: { username: { in: handles } } },
    select: { user: { select: { username: true } } },
  });
  const known = new Set(humans.map((membership) => membership.user.username));
  const rest = handles.filter((handle) => !known.has(handle));
  if (!rest.length) return [];
  const agents = await db.agent.findMany({
    where: {
      workspaceId,
      name: { in: rest },
      ...ACTIVE_AGENT_WHERE,
      ...visibleAgentWhere(await agentVisibilityViewerForActor(db, workspaceId, sender)),
    },
    select: { name: true },
  });
  for (const agent of agents) known.add(agent.name);
  return handles.filter((handle) => !known.has(handle));
}
