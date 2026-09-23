import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/client";
import { ChangeAgentVisibility } from "../src/server/agents/change-agent-visibility.server";
import {
  PrismaChangeAgentVisibilityStore,
  previewAgentVisibilityChange,
} from "../src/server/db/repositories/agent-visibility-change.repositories.server";
import { PrismaAgentRepository } from "../src/server/db/repositories/agent.repositories.server";
import { PrismaDirectConversationRepository } from "../src/server/db/repositories/direct-conversation.repositories.server";
import { PublicChannels } from "../src/server/conversations/public-channels.server";
import { workspaceMemberRole } from "../src/server/workspaces/members.server";

/**
 * End-to-end visibility change against local PostgreSQL. Drives the real
 * `ChangeAgentVisibility` + `PrismaChangeAgentVisibilityStore` and the real DM repository
 * enforcement, then asserts through the other live-view seams (channel membership, an existing
 * DM's read/write behavior, the preview query) — the same shape as
 * `agent-deletion.integration.test.ts`.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;

async function setup() {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: connectionString! }) });
  const suffix = crypto.randomUUID().slice(0, 8);
  const owner = await db.user.create({ data: { username: `vis-owner-${suffix}` } });
  const admin = await db.user.create({ data: { username: `vis-admin-${suffix}` } });
  const member = await db.user.create({ data: { username: `vis-member-${suffix}` } });
  const workspace = await db.workspace.create({
    data: {
      slug: `vis-${suffix}`,
      name: "Agent visibility",
      members: {
        create: [
          { userId: owner.id, role: "owner" },
          { userId: admin.id, role: "admin" },
          { userId: member.id, role: "member" },
        ],
      },
    },
  });
  const agent = await db.agent.create({
    data: {
      workspaceId: workspace.id,
      name: `keeper-${suffix}`,
      displayName: "Keeper",
      ownerId: owner.id,
      runtimeConfig: {
        runtime: "pi",
        provider: { kind: "default" },
        model: "",
        modelProvider: "",
        reasoning: "",
      },
    },
  });
  const channels = new PublicChannels(db);
  const team = await channels.create(workspace.id, owner.id, "team");
  await channels.addMembers(workspace.id, { userId: owner.id }, team.id, {
    userIds: [],
    agentIds: [agent.id],
  });
  return { db, workspace, owner, admin, member, agent };
}

async function teardown(db: PrismaClient, workspaceId: string, userIds: string[]) {
  await db.workspace.delete({ where: { id: workspaceId } }).catch(() => {});
  await db.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  await db.$disconnect();
}

test.skipIf(!connectionString)(
  "public->private soft-leaves channels and read-onlys other members' DMs; private->public does not restore channels",
  async () => {
    const { db, workspace, owner, admin, member, agent } = await setup();
    try {
      const conversations = new PrismaDirectConversationRepository(db);
      const changeVisibility = new ChangeAgentVisibility(
        new PrismaAgentRepository(db),
        new PrismaChangeAgentVisibilityStore(db),
        async () => {},
      );

      // The member starts a DM with the (still public) Agent and can send.
      const memberDm = await conversations.getOrCreateUserAgent(workspace.id, member.id, agent.id);
      const memberDmMember = await db.conversationMember.findUniqueOrThrow({
        where: { conversationId_userId: { conversationId: memberDm.id, userId: member.id } },
        select: { id: true },
      });
      await conversations.sendMessage(
        memberDm.id,
        memberDmMember.id,
        member.id,
        "hello while public",
      );

      // The preview lists #team and counts the member's DM as one that would become read-only
      // (the member is not the creator).
      const previewBefore = await previewAgentVisibilityChange(db, {
        workspaceId: workspace.id,
        agentId: agent.id,
      });
      expect(previewBefore.channelNames).toEqual(["team"]);
      expect(previewBefore.readOnlyDirectMessageCount).toBe(1);

      // The owner (creator) makes the Agent private.
      const result = await changeVisibility.execute(
        {
          userId: owner.id,
          workspaceId: workspace.id,
          role: await workspaceMemberRole(db, workspace.id, owner.id),
        },
        { agentId: agent.id, visibility: "private" },
      );
      expect(result).toEqual({ visibility: "private", changed: true });
      expect((await db.agent.findUniqueOrThrow({ where: { id: agent.id } })).visibility).toBe(
        "private",
      );

      // Every active channel membership is soft-left.
      const memberships = await db.conversationMember.findMany({
        where: {
          workspaceId: workspace.id,
          agentId: agent.id,
          conversation: { channelName: { not: null } },
        },
        select: { leftAt: true, conversation: { select: { channelName: true } } },
      });
      expect(memberships).toHaveLength(1);
      expect(memberships.every((m) => m.leftAt !== null)).toBe(true);

      // The member's existing DM stays readable...
      const reopened = await conversations.getOrCreateUserAgent(workspace.id, member.id, agent.id);
      expect(reopened.id).toBe(memberDm.id);
      const page = await conversations.openForUser(workspace.id, member.id, agent.id);
      expect(page.messages.some((m) => m.body === "hello while public")).toBe(true);
      expect(page.dmWritable).toBe(false);
      // ...but the member can no longer send into it.
      await expect(
        conversations.sendMessage(memberDm.id, memberDmMember.id, member.id, "still there?"),
      ).rejects.toMatchObject({ code: "AGENT_DM_RESTRICTED" });

      // A stranger who never had a DM cannot start one at all.
      const stranger = await db.user.create({
        data: { username: `vis-stranger-${crypto.randomUUID().slice(0, 8)}` },
        select: { id: true },
      });
      await db.workspaceMembership.create({
        data: { workspaceId: workspace.id, userId: stranger.id, role: "member" },
      });
      await expect(
        conversations.getOrCreateUserAgent(workspace.id, stranger.id, agent.id),
      ).rejects.toMatchObject({ code: "AGENT_DM_RESTRICTED" });

      // The creator can still open and send.
      const ownerDm = await conversations.getOrCreateUserAgent(workspace.id, owner.id, agent.id);
      const ownerDmMember = await db.conversationMember.findUniqueOrThrow({
        where: { conversationId_userId: { conversationId: ownerDm.id, userId: owner.id } },
        select: { id: true },
      });
      await expect(
        conversations.sendMessage(ownerDm.id, ownerDmMember.id, owner.id, "still mine to send"),
      ).resolves.toBeDefined();

      // A Workspace admin (not the creator) may flip it back to public.
      const backToPublic = await changeVisibility.execute(
        {
          userId: admin.id,
          workspaceId: workspace.id,
          role: await workspaceMemberRole(db, workspace.id, admin.id),
        },
        { agentId: agent.id, visibility: "public" },
      );
      expect(backToPublic).toEqual({ visibility: "public", changed: true });

      // No channel membership is automatically restored.
      const membershipsAfter = await db.conversationMember.findMany({
        where: {
          workspaceId: workspace.id,
          agentId: agent.id,
          conversation: { channelName: { not: null } },
        },
        select: { leftAt: true, conversation: { select: { channelName: true } } },
      });
      const teamAfter = membershipsAfter.find((m) => m.conversation.channelName === "team");
      expect(teamAfter?.leftAt).not.toBeNull();

      // The member can send again now that the Agent is public.
      await expect(
        conversations.sendMessage(memberDm.id, memberDmMember.id, member.id, "welcome back"),
      ).resolves.toBeDefined();

      // Setting the same visibility again is a no-op.
      const noop = await changeVisibility.execute(
        {
          userId: owner.id,
          workspaceId: workspace.id,
          role: await workspaceMemberRole(db, workspace.id, owner.id),
        },
        { agentId: agent.id, visibility: "public" },
      );
      expect(noop).toEqual({ visibility: "public", changed: false });

      await db.user.delete({ where: { id: stranger.id } }).catch(() => {});
    } finally {
      await teardown(db, workspace.id, [owner.id, admin.id, member.id]);
    }
  },
);
