import type { PrismaClient } from "../../../generated/client";
import { AppError } from "../../lib/app-error";
import type { WorkspaceMemberRole } from "./member-role.server";
import { ACTIVE_AGENT_WHERE } from "../agents/active-agent.server";
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
        where: { workspaceId, ...ACTIVE_AGENT_WHERE },
        select: {
          id: true,
          name: true,
          displayName: true,
          description: true,
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
        computerId: agent.computer?.workspaces.length ? agent.computer.id : null,
        computerName: agent.computer?.workspaces.length
          ? agent.computer.displayName.trim() || agent.computer.name.trim()
          : null,
      })),
    };
  }
}
