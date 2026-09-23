import type { PrismaClient } from "../../../generated/client";
import { AppError } from "../../lib/app-error";
import type { WorkspaceMemberRole } from "./member-role.server";
import { ACTIVE_AGENT_WHERE } from "../agents/active-agent.server";
import { agentAvatarUrl } from "../agents/agent-avatar.server";
import { visibleAgentWhere, type AgentVisibilityViewer } from "../agents/agent-visibility.server";
import { workspaceUserAvatarUrl } from "../db/repositories/user-profile.repositories.server";

/** The actor's Workspace role; ACCESS_DENIED when the user is not a member. */
export async function workspaceMemberRole(
  db: Pick<PrismaClient, "workspaceMembership">,
  workspaceId: string,
  userId: string,
): Promise<WorkspaceMemberRole> {
  const membership = await db.workspaceMembership.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { role: true },
  });
  if (!membership) throw new AppError("ACCESS_DENIED");
  return membership.role as WorkspaceMemberRole;
}

export class WorkspaceMembers {
  constructor(private readonly db: PrismaClient) {}

  async list(workspaceId: string, userId: string) {
    const membership = await this.db.workspaceMembership.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { userId: true, role: true },
    });
    if (!membership) throw new AppError("ACCESS_DENIED");
    // ADR 0059: the same seam every Agent list applies, built from the membership role this
    // method already fetched above — never a second role lookup.
    const viewer: AgentVisibilityViewer = { kind: "user", userId, role: membership.role };

    const [people, agents] = await Promise.all([
      this.db.user.findMany({
        where: { memberships: { some: { workspaceId } } },
        select: {
          id: true,
          username: true,
          displayName: true,
          description: true,
          avatarObjectKey: true,
        },
        orderBy: [{ username: "asc" }, { id: "asc" }],
      }),
      this.db.agent.findMany({
        where: { workspaceId, ...ACTIVE_AGENT_WHERE, ...visibleAgentWhere(viewer) },
        select: {
          id: true,
          name: true,
          displayName: true,
          description: true,
          avatarObjectKey: true,
          createdAt: true,
          owner: { select: { id: true, username: true, displayName: true, avatarObjectKey: true } },
          weeklyReportAssistant: { select: { id: true } },
          computer: {
            select: {
              id: true,
              name: true,
              displayName: true,
              workspaces: {
                where: { workspaceId },
                select: { id: true },
                take: 1,
              },
            },
          },
        },
        orderBy: [{ name: "asc" }, { id: "asc" }],
      }),
    ]);

    return {
      actorRole: membership.role,
      viewerId: userId,
      people: people.map((person) => ({
        id: person.id,
        name: person.username,
        displayName: person.displayName?.trim() || person.username,
        description: person.description,
        avatarUrl: workspaceUserAvatarUrl(workspaceId, person.id, person.avatarObjectKey),
      })),
      agents: agents.map((agent) => ({
        id: agent.id,
        name: agent.name,
        displayName: agent.displayName.trim() || agent.name,
        description: agent.description,
        avatarUrl: agentAvatarUrl(workspaceId, agent.id, agent.avatarObjectKey),
        computerId: agent.computer?.workspaces.length ? agent.computer.id : null,
        computerName: agent.computer?.workspaces.length
          ? agent.computer.displayName.trim() || agent.computer.name.trim()
          : null,
        createdAt: agent.createdAt,
        owner: {
          id: agent.owner.id,
          displayName: agent.owner.displayName?.trim() || agent.owner.username,
          avatarUrl: workspaceUserAvatarUrl(
            workspaceId,
            agent.owner.id,
            agent.owner.avatarObjectKey,
          ),
        },
        // A weekly-report assistant is protected from deletion (AgentDeletion refuses it), so the
        // directory never offers a Delete that is certain to fail.
        deletable: !agent.weeklyReportAssistant,
      })),
    };
  }
}
