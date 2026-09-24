import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "#src/generated/prisma/client";
import { PrismaWorkspaceCatalogStore } from "#src/server/workspaces/catalog.server";
import { PrismaWorkspaceEnrollmentStore } from "#src/server/workspaces/enrollment.server";
import { PrismaWorkspaceMemberDirectoryStore } from "#src/server/workspaces/member-directory-store.server";
import { PrismaAgentRepository } from "#src/server/db/repositories/agent.repositories.server";

/**
 * `#general` is the Workspace-wide channel: every human member and every public, live Agent is in
 * it from the moment they join the Workspace, and the migration that brings it back puts every
 * existing member in it too. Drives the real Prisma stores against local PostgreSQL.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;

const RUNTIME_CONFIG = {
  runtime: "pi" as const,
  provider: { kind: "default" as const },
  model: "",
  modelProvider: "",
  reasoning: "",
};

function connect() {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: connectionString! }) });
}

/** The active members of a Workspace's `#general`, as `user:<id>` / `agent:<id>` keys. */
async function generalMembers(db: Prisma.TransactionClient, workspaceId: string) {
  const general = await db.conversation.findUnique({
    where: { workspaceId_channelName: { workspaceId, channelName: "general" } },
    select: {
      archivedAt: true,
      members: {
        where: { leftAt: null },
        select: { userId: true, agentId: true, channelMuted: true },
      },
    },
  });
  if (!general) return undefined;
  return {
    archived: general.archivedAt !== null,
    members: general.members
      .map((row) => (row.userId ? `user:${row.userId}` : `agent:${row.agentId}`))
      .sort(),
    muted: general.members.filter((row) => row.channelMuted).length,
  };
}

test.skipIf(!connectionString)(
  "a new Workspace starts with #general, its creator in it, on both creation paths",
  async () => {
    const db = connect();
    const suffix = crypto.randomUUID().slice(0, 8);
    const alice = await db.user.create({ data: { username: `gen-alice-${suffix}` } });
    const bob = await db.user.create({ data: { username: `gen-bob-${suffix}` } });
    const created: string[] = [];
    try {
      const fromCatalog = await new PrismaWorkspaceCatalogStore(db).createForUser({
        slug: `gen-a-${suffix}`,
        name: "General A",
        userId: alice.id,
      });
      created.push(fromCatalog.id);
      const fromEnrollment = await new PrismaWorkspaceEnrollmentStore(db).createForUser({
        slug: `gen-b-${suffix}`,
        name: "General B",
        userId: bob.id,
      });
      created.push(fromEnrollment);

      expect(await generalMembers(db, fromCatalog.id)).toEqual({
        archived: false,
        members: [`user:${alice.id}`],
        muted: 0,
      });
      expect(await generalMembers(db, fromEnrollment)).toEqual({
        archived: false,
        members: [`user:${bob.id}`],
        muted: 0,
      });
    } finally {
      await db.workspace.deleteMany({ where: { id: { in: created } } });
      await db.user.deleteMany({ where: { id: { in: [alice.id, bob.id] } } });
      await db.$disconnect();
    }
  },
);

test.skipIf(!connectionString)(
  "an accepted invitation and a new public Agent join #general; a private Agent does not",
  async () => {
    const db = connect();
    const suffix = crypto.randomUUID().slice(0, 8);
    const owner = await db.user.create({ data: { username: `gen-owner-${suffix}` } });
    const invitee = await db.user.create({ data: { username: `gen-invitee-${suffix}` } });
    const workspace = await new PrismaWorkspaceCatalogStore(db).createForUser({
      slug: `gen-c-${suffix}`,
      name: "General C",
      userId: owner.id,
    });
    try {
      // The invitee was in #general once before (their row is soft-left) and it has history.
      const general = await db.conversation.findUniqueOrThrow({
        where: { workspaceId_channelName: { workspaceId: workspace.id, channelName: "general" } },
      });
      const ownerRow = await db.conversationMember.findUniqueOrThrow({
        where: { conversationId_userId: { conversationId: general.id, userId: owner.id } },
      });
      await db.message.create({
        data: {
          workspaceId: workspace.id,
          conversationId: general.id,
          senderMemberId: ownerRow.id,
          sequence: 7,
          body: "Before the invitee came back",
        },
      });
      await db.conversationMember.create({
        data: {
          workspaceId: workspace.id,
          conversationId: general.id,
          userId: invitee.id,
          leftAt: new Date(),
        },
      });
      const invitation = await db.workspaceInvitation.create({
        data: {
          workspaceId: workspace.id,
          inviteeUserId: invitee.id,
          inviterUserId: owner.id,
          role: "member",
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      });
      await new PrismaWorkspaceMemberDirectoryStore(db).acceptInvitation({
        invitationId: invitation.id,
        userId: invitee.id,
      });

      const agents = new PrismaAgentRepository(db);
      const helper = await agents.create({
        workspaceId: workspace.id,
        name: `gen-helper-${suffix}`,
        displayName: "Helper",
        ownerId: owner.id,
        visibility: "public",
        runtimeConfig: RUNTIME_CONFIG,
      });
      const secret = await agents.create({
        workspaceId: workspace.id,
        name: `gen-secret-${suffix}`,
        displayName: "Secret",
        ownerId: owner.id,
        visibility: "private",
        runtimeConfig: RUNTIME_CONFIG,
      });

      const enrolled = await generalMembers(db, workspace.id);
      expect(enrolled?.members).toEqual(
        [`user:${owner.id}`, `user:${invitee.id}`, `agent:${helper.id}`].sort(),
      );
      expect(enrolled?.members).not.toContain(`agent:${secret.id}`);
      // Agents join unmuted, as their instructions say; ordinary chatter still does not wake them.
      expect(enrolled?.muted).toBe(0);
      // The returning invitee starts read through the history, like anyone joining.
      const inviteeRow = await db.conversationMember.findUniqueOrThrow({
        where: { conversationId_userId: { conversationId: general.id, userId: invitee.id } },
      });
      expect(inviteeRow.readThroughSequence).toBe(7);
    } finally {
      await db.workspace.delete({ where: { id: workspace.id } }).catch(() => {});
      await db.user.deleteMany({ where: { id: { in: [owner.id, invitee.id] } } });
      await db.$disconnect();
    }
  },
);

class Rollback extends Error {}

test.skipIf(!connectionString)(
  "the migration brings #general back: unarchived or created, with every human and public live Agent in it",
  async () => {
    const db = connect();
    const migrationDir = readdirSync(join(import.meta.dir, "../prisma/migrations")).find((name) =>
      name.endsWith("_restore_general_channel"),
    );
    expect(migrationDir).toBeDefined();
    const sql = readFileSync(
      join(import.meta.dir, "../prisma/migrations", migrationDir!, "migration.sql"),
      "utf8",
    );
    const suffix = crypto.randomUUID().slice(0, 8);
    try {
      await db.$transaction(async (tx) => {
        const owner = await tx.user.create({ data: { username: `mig-owner-${suffix}` } });
        const leaver = await tx.user.create({ data: { username: `mig-leaver-${suffix}` } });
        const other = await tx.user.create({ data: { username: `mig-other-${suffix}` } });
        // One Workspace kept its archived #general, with a human who had left it.
        const archived = await tx.workspace.create({
          data: {
            slug: `mig-a-${suffix}`,
            name: "Archived general",
            members: {
              create: [
                { userId: owner.id, role: "owner" },
                { userId: leaver.id, role: "member" },
              ],
            },
          },
        });
        const oldGeneral = await tx.conversation.create({
          data: { workspaceId: archived.id, channelName: "general", archivedAt: new Date() },
        });
        await tx.conversationMember.create({
          data: {
            workspaceId: archived.id,
            conversationId: oldGeneral.id,
            userId: leaver.id,
            leftAt: new Date(),
          },
        });
        const agentData = (name: string, visibility: string, deletedAt: Date | null = null) => ({
          workspaceId: archived.id,
          name: `${name}-${suffix}`,
          displayName: name,
          ownerId: owner.id,
          visibility,
          deletedAt,
          runtimeConfig: RUNTIME_CONFIG,
        });
        const liveAgent = await tx.agent.create({ data: agentData("live", "public") });
        const privateAgent = await tx.agent.create({ data: agentData("hidden", "private") });
        const deletedAgent = await tx.agent.create({
          data: agentData("gone", "public", new Date()),
        });
        // Another Workspace never had one.
        const fresh = await tx.workspace.create({
          data: {
            slug: `mig-b-${suffix}`,
            name: "No general",
            members: { create: [{ userId: other.id, role: "owner" }] },
          },
        });

        await tx.$executeRawUnsafe(sql);
        // Running it twice changes nothing more.
        await tx.$executeRawUnsafe(sql);

        const restored = await generalMembers(tx, archived.id);
        expect(restored).toEqual({
          archived: false,
          members: [`user:${owner.id}`, `user:${leaver.id}`, `agent:${liveAgent.id}`].sort(),
          muted: 0,
        });
        expect(restored?.members).not.toContain(`agent:${privateAgent.id}`);
        expect(restored?.members).not.toContain(`agent:${deletedAgent.id}`);
        // A human who comes back starts read through the history.
        const leaverRow = await tx.conversationMember.findUniqueOrThrow({
          where: { conversationId_userId: { conversationId: oldGeneral.id, userId: leaver.id } },
        });
        expect(leaverRow.readThroughSequence).toBe(0);
        // The restored channel is the same row, so its history stays with it.
        const same = await tx.conversation.findUnique({
          where: { workspaceId_channelName: { workspaceId: archived.id, channelName: "general" } },
          select: { id: true },
        });
        expect(same?.id).toBe(oldGeneral.id);
        expect(await generalMembers(tx, fresh.id)).toEqual({
          archived: false,
          members: [`user:${other.id}`],
          muted: 0,
        });
        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    } finally {
      await db.$disconnect();
    }
  },
);
