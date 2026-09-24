import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { isAppError } from "#src/lib/app-error";
import { PublicChannels } from "#src/server/conversations/public-channels.server";
import type { ConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import type { AgentInboxPurgeRequest } from "#src/server/agents/agent-inbox-purge.server";
import type { FileStorage } from "#src/server/files/file-storage.server";
import { PrismaWorkspaceCatalogStore } from "#src/server/workspaces/catalog.server";
import { TaskBoard } from "#src/server/tasks/task-board.server";

/**
 * A Workspace owner or admin deletes a channel for good: the channel and everything in it — its
 * messages, Tasks, files and memberships — go, Reminders aimed at it are canceled, its Agents'
 * daemons drop what they hold for it, and every open page hears so. Nobody else may, not even the
 * channel's own admin, and #general is never deleted. Drives the real services against local
 * PostgreSQL.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;

async function errorOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (isAppError(error)) return error.code;
    throw error;
  }
  return undefined;
}

test.skipIf(!connectionString)(
  "a Workspace owner deletes a channel and everything in it; members, the channel's admin and #general are refused",
  async () => {
    const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: connectionString! }) });
    const suffix = crypto.randomUUID().slice(0, 8);
    const owner = await db.user.create({ data: { username: `del-owner-${suffix}` } });
    const creator = await db.user.create({ data: { username: `del-creator-${suffix}` } });
    const workspace = await new PrismaWorkspaceCatalogStore(db).createForUser({
      slug: `del-${suffix}`,
      name: "Delete channel",
      userId: owner.id,
    });
    const updated: string[] = [];
    const tasksDeleted: { conversationId: string; deleted: string[] }[] = [];
    const purged: AgentInboxPurgeRequest[] = [];
    const removed: string[] = [];
    const realtime: ConversationRealtime = {
      async messageAvailable() {},
      async memberChanged() {},
      async channelUpdated(input) {
        updated.push(input.conversationId);
      },
      async taskChanged(input) {
        if (input.deleted.length > 0)
          tasksDeleted.push({ conversationId: input.conversationId, deleted: input.deleted });
      },
    };
    const storage = async () =>
      ({
        async remove(objectKey: string) {
          removed.push(objectKey);
        },
      }) as unknown as FileStorage;
    try {
      await db.workspaceMembership.create({
        data: { workspaceId: workspace.id, userId: creator.id, role: "member" },
      });
      const computer = await db.computer.create({
        data: { ownerId: owner.id, machineId: crypto.randomUUID() },
      });
      await db.workspaceComputer.create({
        data: { workspaceId: workspace.id, computerId: computer.id },
      });
      const agent = await db.agent.create({
        data: {
          workspaceId: workspace.id,
          name: `del-agent-${suffix}`,
          displayName: "Helper",
          ownerId: owner.id,
          computerId: computer.id,
          runtimeConfig: {
            runtime: "pi",
            provider: { kind: "default" },
            model: "",
            modelProvider: "",
            reasoning: "",
          },
        },
      });
      const channels = new PublicChannels(db, undefined, undefined, undefined, realtime, {
        async purge(request) {
          purged.push(request);
        },
      });
      const team = await channels.create(workspace.id, creator.id, `team-${suffix}`);
      const other = await channels.create(workspace.id, creator.id, `other-${suffix}`);
      await channels.addMembers(workspace.id, { userId: creator.id }, team.id, {
        userIds: [],
        agentIds: [agent.id],
      });
      const creatorRow = await db.conversationMember.findUniqueOrThrow({
        where: { conversationId_userId: { conversationId: team.id, userId: creator.id } },
      });
      const message = await db.message.create({
        data: {
          workspaceId: workspace.id,
          conversationId: team.id,
          senderMemberId: creatorRow.id,
          sequence: 1,
          body: "soon gone",
        },
      });
      await db.message.create({
        data: {
          workspaceId: workspace.id,
          conversationId: team.id,
          senderMemberId: creatorRow.id,
          sequence: 2,
          body: "a reply",
          threadRootId: message.id,
        },
      });
      const task = await new TaskBoard(db).execute(
        { workspaceId: workspace.id, userId: creator.id },
        {
          operation: "create",
          conversationId: team.id,
          title: "a task",
          idempotencyKey: crypto.randomUUID(),
          assignee: `@${creator.username}`,
        },
      );
      const attachmentKey = `workspaces/${workspace.id}/attachments/${crypto.randomUUID()}/original`;
      await db.attachment.create({
        data: {
          workspaceId: workspace.id,
          conversationId: team.id,
          messageId: message.id,
          fileName: "notes.txt",
          contentType: "text/plain",
          sizeBytes: 4,
          objectKey: attachmentKey,
        },
      });
      const reminder = (target: string) =>
        db.reminder.create({
          data: {
            workspaceId: workspace.id,
            ownerAgentId: agent.id,
            computerId: computer.id,
            title: "ping",
            target,
            messageId: message.id,
            fireAt: new Date(Date.now() + 3_600_000),
          },
        });
      const inChannel = await reminder(`#team-${suffix}`);
      const inThread = await reminder(`#team-${suffix}:${message.id.slice(0, 8)}`);
      const elsewhere = await reminder(`#other-${suffix}`);
      const general = await db.conversation.findUniqueOrThrow({
        where: { workspaceId_channelName: { workspaceId: workspace.id, channelName: "general" } },
      });

      // Only a Workspace owner or admin deletes: not a member, not the channel's own admin.
      expect((await channels.open(workspace.id, owner.id, team.id)).canDelete).toBe(true);
      expect((await channels.open(workspace.id, creator.id, team.id)).canDelete).toBe(false);
      expect((await channels.open(workspace.id, owner.id, general.id)).canDelete).toBe(false);
      expect(
        await errorOf(channels.deleteChannel(workspace.id, creator.id, team.id, storage)),
      ).toBe("ACCESS_DENIED");
      expect(
        await errorOf(channels.deleteChannel(workspace.id, owner.id, general.id, storage)),
      ).toBe("CONFLICT");

      await channels.deleteChannel(workspace.id, owner.id, team.id, storage);

      expect(await db.conversation.findUnique({ where: { id: team.id } })).toBeNull();
      expect(await db.message.count({ where: { conversationId: team.id } })).toBe(0);
      expect(await db.task.count({ where: { conversationId: team.id } })).toBe(0);
      expect(await db.attachment.count({ where: { conversationId: team.id } })).toBe(0);
      expect(await db.conversationMember.count({ where: { conversationId: team.id } })).toBe(0);
      expect(removed).toEqual([attachmentKey]);
      const status = async (id: string) =>
        (await db.reminder.findUniqueOrThrow({ where: { id } })).status;
      expect(await status(inChannel.id)).toBe("canceled");
      expect(await status(inThread.id)).toBe("canceled");
      expect(await status(elsewhere.id)).toBe("scheduled");
      expect(purged).toEqual([
        {
          workspaceId: workspace.id,
          agentId: agent.id,
          conversationIds: [team.id],
          reason: "member_removed",
        },
      ]);
      expect(updated).toEqual([team.id]);
      // Open Tasks pages drop the channel's Tasks.
      expect(tasksDeleted).toEqual([
        { conversationId: team.id, deleted: task.tasks.map(({ messageId }) => messageId) },
      ]);
      expect(await db.conversation.findUnique({ where: { id: other.id } })).not.toBeNull();
      expect(await errorOf(channels.deleteChannel(workspace.id, owner.id, team.id, storage))).toBe(
        "NOT_FOUND",
      );
    } finally {
      await db.workspace.delete({ where: { id: workspace.id } }).catch(() => {});
      await db.computer.deleteMany({ where: { ownerId: owner.id } });
      await db.user.deleteMany({ where: { id: { in: [owner.id, creator.id] } } });
      await db.$disconnect();
    }
  },
);
