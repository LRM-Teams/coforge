import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import type { WorkspaceMemberRole } from "./member-role.server";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import { agentAvatarUrl } from "#src/server/agents/agent-avatar.server";
import {
  visibleAgentWhere,
  type AgentVisibilityViewer,
} from "#src/server/agents/agent-visibility.server";
import { workspaceUserAvatarUrl } from "#src/server/db/repositories/user-profile.repositories.server";
import { MEMBER_PAGE_MAX } from "#src/features/workspaces/member-directory";

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

export type AgentOwnerFilter = "all" | "mine";

export type AgentPageInput = {
  owner: AgentOwnerFilter;
  query: string;
  cursor?: string;
  limit: number;
};

export type PeoplePageInput = { query: string; cursor?: string; limit: number };

const contains = (query: string) => ({ contains: query, mode: "insensitive" as const });

/** Take one extra row to learn whether another page exists; the cursor is the last row's id. */
function pageOf<T extends { id: string }>(rows: T[], limit: number) {
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? (items.at(-1)?.id ?? null) : null };
}

export class WorkspaceMembers {
  constructor(private readonly db: PrismaClient) {}

  /** The viewer's role, or ACCESS_DENIED when they are not a member of the Workspace. */
  private async viewer(workspaceId: string, userId: string) {
    const membership = await this.db.workspaceMembership.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { userId: true, role: true },
    });
    if (!membership) throw new AppError("ACCESS_DENIED");
    // The same seam every Agent list applies, built from the membership role fetched
    // here — never a second role lookup.
    const visibility: AgentVisibilityViewer = { kind: "user", userId, role: membership.role };
    return { role: membership.role, visibleAgents: this.visibleAgents(workspaceId, visibility) };
  }

  private visibleAgents(workspaceId: string, viewer: AgentVisibilityViewer) {
    return { workspaceId, ...ACTIVE_AGENT_WHERE, ...visibleAgentWhere(viewer) };
  }

  /** Tab totals; unaffected by any filter or search. */
  async summary(workspaceId: string, userId: string) {
    const { role, visibleAgents } = await this.viewer(workspaceId, userId);
    const [agentCount, peopleCount] = await Promise.all([
      this.db.agent.count({ where: visibleAgents }),
      this.db.workspaceMembership.count({ where: { workspaceId } }),
    ]);
    return { workspaceId, actorRole: role, viewerId: userId, agentCount, peopleCount };
  }

  async agentPage(workspaceId: string, userId: string, input: AgentPageInput) {
    const { visibleAgents } = await this.viewer(workspaceId, userId);
    const query = input.query.trim();
    const limit = Math.min(Math.max(input.limit, 1), MEMBER_PAGE_MAX);
    const agents = await this.db.agent.findMany({
      where: {
        AND: [
          visibleAgents,
          input.owner === "mine" ? { ownerId: userId } : {},
          query
            ? {
                OR: [
                  { name: contains(query) },
                  { displayName: contains(query) },
                  {
                    computer: {
                      workspaces: { some: { workspaceId } },
                      OR: [{ name: contains(query) }, { displayName: contains(query) }],
                    },
                  },
                ],
              }
            : {},
        ],
      },
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
            workspaces: { where: { workspaceId }, select: { id: true }, take: 1 },
          },
        },
      },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      take: limit + 1,
    });
    return pageOf(
      agents.map((agent) => ({
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
      limit,
    );
  }

  /**
   * Every human member and every Agent the viewer may see, in one compact list each: what a
   * picker needs to offer and to name a chosen person. Unpaginated, like the other
   * whole-Workspace pickers; the Members page keeps its paged reads.
   */
  async directory(workspaceId: string, userId: string) {
    const { visibleAgents } = await this.viewer(workspaceId, userId);
    const [people, agents] = await Promise.all([
      this.db.user.findMany({
        where: { memberships: { some: { workspaceId } } },
        select: { id: true, username: true, displayName: true, avatarObjectKey: true },
        orderBy: [{ username: "asc" }, { id: "asc" }],
      }),
      this.db.agent.findMany({
        where: visibleAgents,
        select: { id: true, name: true, displayName: true, avatarObjectKey: true, ownerId: true },
        orderBy: [{ name: "asc" }, { id: "asc" }],
      }),
    ]);
    return {
      people: people.map((person) => ({
        id: person.id,
        handle: person.username,
        name: person.displayName?.trim() || person.username,
        avatarUrl: workspaceUserAvatarUrl(workspaceId, person.id, person.avatarObjectKey),
      })),
      agents: agents.map((agent) => ({
        id: agent.id,
        handle: agent.name,
        name: agent.displayName.trim() || agent.name,
        avatarUrl: agentAvatarUrl(workspaceId, agent.id, agent.avatarObjectKey),
        /** The Web opens an Agent's direct conversation only for its owner (`ownedConversations`
         * in `features/conversations/conversations.functions.ts`). */
        ownedByCurrentUser: agent.ownerId === userId,
      })),
    };
  }

  async peoplePage(workspaceId: string, userId: string, input: PeoplePageInput) {
    await this.viewer(workspaceId, userId);
    const query = input.query.trim();
    const limit = Math.min(Math.max(input.limit, 1), MEMBER_PAGE_MAX);
    const people = await this.db.user.findMany({
      where: {
        memberships: { some: { workspaceId } },
        ...(query ? { OR: [{ username: contains(query) }, { displayName: contains(query) }] } : {}),
      },
      select: {
        id: true,
        username: true,
        displayName: true,
        description: true,
        avatarObjectKey: true,
      },
      orderBy: [{ username: "asc" }, { id: "asc" }],
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      take: limit + 1,
    });
    return pageOf(
      people.map((person) => ({
        id: person.id,
        name: person.username,
        displayName: person.displayName?.trim() || person.username,
        description: person.description,
        avatarUrl: workspaceUserAvatarUrl(workspaceId, person.id, person.avatarObjectKey),
      })),
      limit,
    );
  }
}
