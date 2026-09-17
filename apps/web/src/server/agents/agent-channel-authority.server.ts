import type { PrismaClient } from "../../../generated/client";
import { isAdminLike, isWorkspaceMemberRole } from "../workspaces/member-role.server";

/**
 * An Agent's management authority for channel lifecycle/roster operations comes from the
 * Agent's OWN server role (`Agent.role`), matching Raft's `serverRole` model — not from its
 * owning User's Workspace role. See ADR 0024.
 */
export async function agentHasAdminAuthority(
  db: PrismaClient,
  workspaceId: string,
  agentId: string,
): Promise<boolean> {
  const agent = await db.agent.findFirst({
    where: { id: agentId, workspaceId },
    select: { role: true },
  });
  if (!agent || !isWorkspaceMemberRole(agent.role)) return false;
  return isAdminLike(agent.role);
}
