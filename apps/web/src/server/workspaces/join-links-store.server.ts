import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { AGENT_VISIBILITY } from "#src/features/agents/agent-visibility";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import { isUniqueViolation } from "#src/server/db/unique-violation.server";
import {
  WorkspaceJoinLinks,
  type JoinLinkAdmission,
  type NewWorkspaceJoinLink,
  type WorkspaceJoinLinkStore,
} from "./join-links.server";
import { admitWorkspaceMember } from "./member-admission.server";
import { isWorkspaceMemberRole } from "./member-role.server";
import { workspaceIconUrl } from "./workspace-images.server";

const linkSelect = {
  id: true,
  workspaceId: true,
  token: true,
  maxUses: true,
  useCount: true,
  expiresAt: true,
  revokedAt: true,
  createdAt: true,
} as const;

/** Link writes of one Workspace take turns, so two created at once cannot both stay working. */
async function lockWorkspaceLinks(tx: Prisma.TransactionClient, workspaceId: string) {
  await tx.$queryRaw`SELECT "id" FROM "workspaces" WHERE "id" = ${workspaceId}::uuid FOR UPDATE`;
}

export class PrismaWorkspaceJoinLinkStore implements WorkspaceJoinLinkStore {
  constructor(private readonly db: PrismaClient) {}

  async findMemberRole(workspaceId: string, userId: string) {
    const row = await this.db.workspaceMembership.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { role: true },
    });
    return row && isWorkspaceMemberRole(row.role) ? row.role : null;
  }

  async findLatestActive(workspaceId: string, now: Date) {
    return this.db.workspaceJoinLink.findFirst({
      where: { workspaceId, ...this.activeWhere(now) },
      orderBy: { createdAt: "desc" },
      select: linkSelect,
    });
  }

  async create(input: NewWorkspaceJoinLink & { now: Date }) {
    const { now, ...next } = input;
    return this.db.$transaction(async (tx) => {
      await lockWorkspaceLinks(tx, next.workspaceId);
      await tx.workspaceJoinLink.updateMany({
        where: { workspaceId: next.workspaceId, revokedAt: null },
        data: { revokedAt: now },
      });
      return tx.workspaceJoinLink.create({ data: next, select: linkSelect });
    });
  }

  async replace(input: NewWorkspaceJoinLink & { linkId: string; now: Date }) {
    const { linkId, now, ...next } = input;
    return this.db.$transaction(async (tx) => {
      await lockWorkspaceLinks(tx, input.workspaceId);
      const revoked = await tx.workspaceJoinLink.updateMany({
        where: { id: linkId, workspaceId: input.workspaceId, revokedAt: null },
        data: { revokedAt: now },
      });
      if (revoked.count !== 1) return null;
      return tx.workspaceJoinLink.create({ data: next, select: linkSelect });
    });
  }

  async revoke(input: { workspaceId: string; linkId: string; now: Date }) {
    const revoked = await this.db.workspaceJoinLink.updateMany({
      where: { id: input.linkId, workspaceId: input.workspaceId, revokedAt: null },
      data: { revokedAt: input.now },
    });
    return revoked.count === 1;
  }

  async findByToken(token: string) {
    const row = await this.db.workspaceJoinLink.findUnique({
      where: { token },
      select: {
        ...linkSelect,
        workspace: { select: { id: true, slug: true, name: true, iconObjectKey: true } },
      },
    });
    if (!row) return null;
    const { workspace, ...link } = row;
    return {
      link,
      workspace: {
        id: workspace.id,
        slug: workspace.slug,
        name: workspace.name,
        iconUrl: workspaceIconUrl(workspace.id, workspace.iconObjectKey),
      },
    };
  }

  async countMembers(workspaceId: string) {
    const [memberCount, agentCount] = await Promise.all([
      this.db.workspaceMembership.count({ where: { workspaceId } }),
      this.db.agent.count({
        where: { workspaceId, visibility: AGENT_VISIBILITY.PUBLIC, ...ACTIVE_AGENT_WHERE },
      }),
    ]);
    return { memberCount, agentCount };
  }

  async admit(input: { linkId: string; userId: string; now: Date }): Promise<JoinLinkAdmission> {
    try {
      return await this.db.$transaction(async (tx) => {
        // Counting the use is the guard: of two joins racing for the last use, the second
        // re-reads the row after the first commits and matches nothing.
        const counted = await tx.workspaceJoinLink.updateMany({
          where: { id: input.linkId, ...this.activeWhere(input.now) },
          data: { useCount: { increment: 1 } },
        });
        if (counted.count !== 1) return { status: "inactive" as const };
        const link = await tx.workspaceJoinLink.findUniqueOrThrow({
          where: { id: input.linkId },
          select: { workspaceId: true },
        });
        const { joinedChannelIds } = await admitWorkspaceMember(tx, {
          workspaceId: link.workspaceId,
          userId: input.userId,
          role: "member",
        });
        return { status: "admitted" as const, joinedChannelIds };
      });
    } catch (error) {
      // They joined meanwhile (the same link opened twice at once): their membership stands and
      // this transaction, with its use, rolled back.
      if (isUniqueViolation(error)) return { status: "already-member" };
      throw error;
    }
  }

  /** `isJoinLinkActive` in SQL. */
  private activeWhere(now: Date): Prisma.WorkspaceJoinLinkWhereInput {
    return {
      revokedAt: null,
      AND: [
        { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        { OR: [{ maxUses: null }, { useCount: { lt: this.db.workspaceJoinLink.fields.maxUses } }] },
      ],
    };
  }
}

export function workspaceJoinLinks(db: PrismaClient) {
  return new WorkspaceJoinLinks(new PrismaWorkspaceJoinLinkStore(db));
}
