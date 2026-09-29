import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import type {
  ConversationRealtime,
  ConversationRealtimeMessage,
} from "#src/server/conversations/conversation-realtime.server";
import { enrollGeneralChannel } from "#src/server/conversations/public-channels.server";
import { TaskBoard } from "#src/server/tasks/task-board.server";

/**
 * An assignment receipt is a server notice: nobody counts it unread, so its signal goes only to
 * the conversation's own channel, never to a sidebar's badge channel; a person assigned hears of
 * their Activity mention through `activity.changed.v1` instead.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;

test.skipIf(!connectionString)(
  "a Task assigned to a person tells the conversation and the assignee's Activity, not the sidebars",
  async () => {
    const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: connectionString! }) });
    const suffix = crypto.randomUUID().slice(0, 8);
    const ada = await db.user.create({ data: { username: `ars-ada-${suffix}` } });
    const bob = await db.user.create({ data: { username: `ars-bob-${suffix}` } });
    const workspace = await db.workspace.create({
      data: {
        slug: `ars-${suffix}`,
        name: "Assignment receipt signal",
        members: {
          create: [
            { userId: ada.id, role: "owner" },
            { userId: bob.id, role: "member" },
          ],
        },
      },
    });
    try {
      await enrollGeneralChannel(db, workspace.id);
      const general = await db.conversation.findFirstOrThrow({
        where: { workspaceId: workspace.id, channelName: "general" },
      });
      const messages: ConversationRealtimeMessage[] = [];
      const activity: { workspaceId: string; userId: string }[] = [];
      const realtime: ConversationRealtime = {
        async messageAvailable(input) {
          messages.push(input);
        },
        async memberChanged() {},
        async activityChanged(input) {
          activity.push(input);
        },
      };
      const board = new TaskBoard(db, { realtime });
      const asAda = { workspaceId: workspace.id, userId: ada.id };
      await board.execute(asAda, {
        operation: "create",
        idempotencyKey: crypto.randomUUID(),
        conversationId: general.id,
        title: "Review the plan",
        assignee: `@${bob.username}`,
      });
      const receipt = await db.message.findFirstOrThrow({
        where: { conversationId: general.id, senderMemberId: null, mentions: { some: {} } },
      });
      const receiptSignals = messages.filter((message) => message.messageId === receipt.id);
      expect(receiptSignals).toEqual([
        { conversationId: general.id, messageId: receipt.id, sequence: receipt.sequence },
      ]);
      expect(activity).toEqual([{ workspaceId: workspace.id, userId: bob.id }]);

      // Assigning later tells the person the same way; an Agent assignee has no Activity to tell.
      const agent = await db.agent.create({
        data: {
          workspaceId: workspace.id,
          name: `ars-agent-${suffix}`,
          displayName: "Helper",
          ownerId: ada.id,
          runtimeConfig: {
            runtime: "pi",
            provider: { kind: "default" },
            model: "",
            modelProvider: "",
            reasoning: "",
          },
        },
      });
      await db.conversationMember.create({
        data: { conversationId: general.id, workspaceId: workspace.id, agentId: agent.id },
      });
      const later = await board.execute(asAda, {
        operation: "create",
        idempotencyKey: crypto.randomUUID(),
        conversationId: general.id,
        title: "Draft the notes",
      });
      const assign = (assignee: string) =>
        board.execute(asAda, {
          operation: "assign",
          idempotencyKey: crypto.randomUUID(),
          conversationId: general.id,
          number: later.tasks[0]!.number,
          assignee,
        });
      activity.length = 0;
      await assign(`@${agent.name}`);
      expect(activity).toEqual([]);
      await assign(`@${bob.username}`);
      expect(activity).toEqual([{ workspaceId: workspace.id, userId: bob.id }]);
      const receipts = await db.message.findMany({
        where: { conversationId: general.id, senderMemberId: null, mentions: { some: {} } },
        select: { id: true },
      });
      expect(receipts).toHaveLength(3);
      for (const { id } of receipts)
        expect(messages.filter((message) => message.messageId === id)).toEqual([
          expect.not.objectContaining({ workspaceId: expect.anything() }),
        ]);
    } finally {
      await db.workspace.delete({ where: { id: workspace.id } }).catch(() => {});
      await db.user.deleteMany({ where: { username: { endsWith: suffix } } }).catch(() => {});
      await db.$disconnect();
    }
  },
);
