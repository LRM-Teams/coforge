import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import type { ViewerEvent } from "#src/features/conversations/conversation-realtime";
import type { ConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import { enrollGeneralChannel } from "#src/server/conversations/public-channels.server";
import {
  saveUserMessage,
  unsaveUserMessage,
} from "#src/server/conversations/saved-messages.server";

/**
 * Saving and unsaving tell the person's other pages their Saved list changed (Slack's
 * `star_added` / `star_removed`), against local PostgreSQL; a save that changes nothing says
 * nothing.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;

test.skipIf(!connectionString)(
  "a save or unsave tells the person's pages once, and a repeat says nothing",
  async () => {
    const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: connectionString! }) });
    const suffix = crypto.randomUUID().slice(0, 8);
    const ada = await db.user.create({ data: { username: `sve-ada-${suffix}` } });
    const workspace = await db.workspace.create({
      data: {
        slug: `sve-${suffix}`,
        name: "Saved events",
        members: { create: [{ userId: ada.id, role: "owner" }] },
      },
    });
    try {
      await enrollGeneralChannel(db, workspace.id);
      const general = await db.conversation.findFirstOrThrow({
        where: { workspaceId: workspace.id, channelName: "general" },
      });
      const member = await db.conversationMember.findFirstOrThrow({
        where: { conversationId: general.id, userId: ada.id },
      });
      const message = await db.message.create({
        data: {
          conversationId: general.id,
          workspaceId: workspace.id,
          senderMemberId: member.id,
          body: "keep this",
          sequence: 1,
        },
      });
      const announced: { userIds: readonly string[]; event: ViewerEvent }[] = [];
      const realtime: ConversationRealtime = {
        async messageAvailable() {},
        async memberChanged() {},
        async viewerChanged(input) {
          announced.push(input);
        },
      };
      const input = {
        workspaceId: workspace.id,
        conversationId: general.id,
        userId: ada.id,
        messageId: message.id,
      };
      const ids = { workspaceId: workspace.id, conversationId: general.id, messageId: message.id };

      await saveUserMessage(db, input, realtime);
      await saveUserMessage(db, input, realtime);
      await unsaveUserMessage(db, input, realtime);
      await unsaveUserMessage(db, input, realtime);
      expect(announced).toEqual([
        { userIds: [ada.id], event: { type: "saved.added.v1", ...ids } },
        { userIds: [ada.id], event: { type: "saved.removed.v1", ...ids } },
      ]);
    } finally {
      await db.workspace.delete({ where: { id: workspace.id } }).catch(() => {});
      await db.user.deleteMany({ where: { username: { endsWith: suffix } } }).catch(() => {});
      await db.$disconnect();
    }
  },
);
