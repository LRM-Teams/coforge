import type { PrismaClient } from "../../../generated/client";
import { AppError } from "../../lib/app-error";

export class WorkspaceMembers {
  constructor(private readonly db: PrismaClient) {}

  async list(workspaceId: string, userId: string) {
    const membership = await this.db.workspaceMembership.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { userId: true },
    });
    if (!membership) throw new AppError("ACCESS_DENIED");

    const [people, agents] = await Promise.all([
      this.db.user.findMany({
        where: { memberships: { some: { workspaceId } } },
        select: { id: true, username: true, displayName: true, description: true },
        orderBy: [{ username: "asc" }, { id: "asc" }],
      }),
      this.db.agent.findMany({
        where: { workspaceId },
        select: {
          id: true,
          name: true,
          displayName: true,
          description: true,
          computer: {
            select: {
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
      people: people.map((person) => ({
        id: person.id,
        name: person.username,
        displayName: person.displayName?.trim() || person.username,
        description: person.description,
      })),
      agents: agents.map((agent) => ({
        id: agent.id,
        name: agent.name,
        displayName: agent.displayName.trim() || agent.name,
        description: agent.description,
        computerName: agent.computer?.workspaces.length
          ? agent.computer.displayName.trim() || agent.computer.name.trim()
          : null,
      })),
    };
  }
}
