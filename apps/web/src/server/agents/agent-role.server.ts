import type { PrismaClient } from "@/generated/prisma/client";
import { AppError } from "@/lib/app-error";
import { assertCanInvite, type WorkspaceMemberRole } from "@/server/workspaces/member-role.server";
import { ACTIVE_AGENT_WHERE } from "./active-agent.server";

export type SetAgentRoleInput = {
  workspaceId: string;
  /** The human performing the change; must be an admin-like Workspace member. */
  actorUserId: string;
  agentId: string;
  /** Never `"owner"`: `assertCanInvite` rejects it, mirroring invitation role assignment. */
  role: string;
};

/**
 * Changes an Agent's own server role (`Agent.role`), one of the two bases
 * `channel-authority.server.ts#resolveChannelAuthority` derives channel-admin authority from.
 * Gated the same way inviting a Workspace member at a role is: the
 * actor must be `owner`/`admin`, and the assigned role itself can only be `admin` or `member`.
 */
export async function setAgentRole(
  db: PrismaClient,
  input: SetAgentRoleInput,
): Promise<{ agentId: string; role: string }> {
  const membership = await db.workspaceMembership.findUnique({
    where: { workspaceId_userId: { workspaceId: input.workspaceId, userId: input.actorUserId } },
    select: { role: true },
  });
  if (!membership) throw new AppError("ACCESS_DENIED");
  const role = assertCanInvite(membership.role as WorkspaceMemberRole, input.role);
  const agent = await db.agent.findFirst({
    where: { id: input.agentId, workspaceId: input.workspaceId, ...ACTIVE_AGENT_WHERE },
    select: { id: true },
  });
  if (!agent) throw new AppError("NOT_FOUND");
  await db.agent.update({ where: { id: agent.id }, data: { role } });
  return { agentId: agent.id, role };
}
