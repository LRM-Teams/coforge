import { Prisma, type PrismaClient } from "#src/generated/prisma/client";
import { peopleDirectPeerId } from "#src/features/conversations/direct-key";
import { AppError } from "#src/lib/app-error";
import { compareHumanLabels, humanLabel } from "#src/lib/human-label";
import type { WorkspaceMemberRole } from "./member-role.server";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import { agentAvatarUrl } from "#src/server/agents/agent-avatar.server";
import {
  visibleAgentWhere,
  type AgentVisibilityViewer,
} from "#src/server/agents/agent-visibility.server";
import { workspaceUserAvatarUrl } from "#src/server/db/repositories/user-profile.repositories.server";
import { CREATED_AGENT_FACES, MEMBER_PAGE_MAX } from "#src/features/workspaces/member-directory";

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

/** `humanLabel` as SQL over the `users` row aliased `alias`: the display name, else the full
 * name, else the username, a blank name counting as none. */
const personLabelSql = (alias: Prisma.Sql) =>
  Prisma.sql`COALESCE(NULLIF(btrim(${alias}."displayName"), ''), NULLIF(btrim(${alias}."fullName"), ''), ${alias}."username")`;

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
        owner: {
          select: {
            id: true,
            username: true,
            displayName: true,
            fullName: true,
            avatarObjectKey: true,
          },
        },
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
          displayName: humanLabel(agent.owner),
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
    const [people, agents, directs] = await Promise.all([
      this.db.user.findMany({
        where: { memberships: { some: { workspaceId } } },
        select: {
          id: true,
          username: true,
          displayName: true,
          fullName: true,
          avatarObjectKey: true,
        },
      }),
      this.db.agent.findMany({
        where: visibleAgents,
        select: { id: true, name: true, displayName: true, avatarObjectKey: true, ownerId: true },
        orderBy: [{ name: "asc" }, { id: "asc" }],
      }),
      // The viewer's own direct conversations, with Agents and with members, so a picker can open
      // the one that exists.
      this.db.conversationMember.findMany({
        where: { workspaceId, userId, leftAt: null, conversation: { directKey: { not: null } } },
        select: {
          conversationId: true,
          conversation: {
            select: {
              directKey: true,
              members: { where: { agentId: { not: null } }, select: { agentId: true } },
            },
          },
        },
      }),
    ]);
    const dmByAgent = new Map(
      directs.flatMap((row) =>
        row.conversation.members.map((member) => [member.agentId!, row.conversationId] as const),
      ),
    );
    const dmByPeer = new Map(
      directs.flatMap((row): [string, string][] => {
        const peerId = peopleDirectPeerId(row.conversation.directKey, userId);
        return peerId ? [[peerId, row.conversationId]] : [];
      }),
    );
    return {
      // Listed by the name they are shown by, which the database cannot order by.
      people: [...people].sort(compareHumanLabels).map((person) => ({
        id: person.id,
        name: humanLabel(person),
        /** The name behind `name` when a nickname replaced it, which a search still finds them
         * by. There is no username here: nothing shown or searched for a person is one. */
        fullName: person.fullName,
        avatarUrl: workspaceUserAvatarUrl(workspaceId, person.id, person.avatarObjectKey),
        /** The viewer's direct conversation with this member (`dm/<id>`; the viewer's own with
         * themself), once there is one. */
        dmId: dmByPeer.get(person.id) ?? null,
      })),
      agents: agents.map((agent) => ({
        id: agent.id,
        handle: agent.name,
        name: agent.displayName.trim() || agent.name,
        avatarUrl: agentAvatarUrl(workspaceId, agent.id, agent.avatarObjectKey),
        /** The Web opens an Agent's direct conversation only for its owner
         * (`DirectConversations.authorize`). */
        ownedByCurrentUser: agent.ownerId === userId,
        /** The viewer's direct conversation with this Agent (`dm/<id>`), once there is one. */
        dmId: dmByAgent.get(agent.id) ?? null,
      })),
    };
  }

  async peoplePage(workspaceId: string, userId: string, input: PeoplePageInput) {
    const { visibleAgents } = await this.viewer(workspaceId, userId);
    const limit = Math.min(Math.max(input.limit, 1), MEMBER_PAGE_MAX);
    const ids = await this.orderedPersonIds(workspaceId, input, limit + 1);
    const rows = await this.db.user.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        username: true,
        displayName: true,
        fullName: true,
        description: true,
        avatarObjectKey: true,
        // Visible Agents this person created. One list feeds the count and the faces: Prisma
        // pushes neither a nested `take` nor a page-scoped filtered `_count` into SQL.
        agents: {
          where: visibleAgents,
          select: { id: true, name: true, displayName: true, avatarObjectKey: true },
          orderBy: [{ name: "asc" }, { id: "asc" }],
        },
      },
    });
    const byId = new Map(rows.map((person) => [person.id, person]));
    const people = ids.flatMap((id) => byId.get(id) ?? []);
    return pageOf(
      people.map((person) => ({
        id: person.id,
        displayName: humanLabel(person),
        description: person.description,
        avatarUrl: workspaceUserAvatarUrl(workspaceId, person.id, person.avatarObjectKey),
        createdAgents: {
          total: person.agents.length,
          items: person.agents.slice(0, CREATED_AGENT_FACES).map((agent) => ({
            id: agent.id,
            displayName: agent.displayName.trim() || agent.name,
            avatarUrl: agentAvatarUrl(workspaceId, agent.id, agent.avatarObjectKey),
          })),
        },
      })),
      limit,
    );
  }

  /**
   * The ids of one page of the Workspace's people, in the order they are shown: by the name each
   * is shown by (`humanLabel`), case-insensitively, then by username so people shown alike keep
   * one order. Prisma cannot sort by that name, so the order and the cursor are SQL: the page
   * resumes after the (label, username) of the person the cursor names.
   */
  private async orderedPersonIds(
    workspaceId: string,
    input: PeoplePageInput,
    take: number,
  ): Promise<string[]> {
    const query = input.query.trim();
    const label = personLabelSql(Prisma.raw("u"));
    // The names a person is found by: the one they are shown by or the full name a nickname
    // replaced. A username is found only for a person with neither name, whom it labels.
    const matches = query
      ? Prisma.sql`AND (
          strpos(lower(u."displayName"), lower(${query})) > 0
          OR strpos(lower(u."fullName"), lower(${query})) > 0
          OR (NULLIF(btrim(u."displayName"), '') IS NULL AND NULLIF(btrim(u."fullName"), '') IS NULL
              AND strpos(lower(u."username"), lower(${query})) > 0)
        )`
      : Prisma.empty;
    const afterCursor = input.cursor
      ? Prisma.sql`AND (lower(${label}), u."username") > (
          SELECT lower(${personLabelSql(Prisma.raw("c"))}), c."username"
          FROM "users" c WHERE c."id" = ${input.cursor}::uuid
        )`
      : Prisma.empty;
    const rows = await this.db.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT u."id"
      FROM "users" u
      WHERE EXISTS (
        SELECT 1 FROM "workspace_memberships" m
        WHERE m."workspaceId" = ${workspaceId}::uuid AND m."userId" = u."id"
      )
      ${matches}
      ${afterCursor}
      ORDER BY lower(${label}), u."username"
      LIMIT ${take}`);
    return rows.map((row) => row.id);
  }
}
