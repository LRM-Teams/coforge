import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import type { CentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import type { MessageRequestIdempotency } from "#src/server/conversations/message-request-idempotency.server";
import type {
  ConversationRealtime,
  ConversationRealtimeMessage,
} from "#src/server/conversations/conversation-realtime.server";
import {
  PublicChannels,
  enrollGeneralChannel,
} from "#src/server/conversations/public-channels.server";

/**
 * A person's channel message names them on its signal (Slack's `message.user`), so their own
 * pages on other tabs and devices never count it unread.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;

test.skipIf(!connectionString)("a person's channel message names its sender", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: connectionString! }) });
  const suffix = crypto.randomUUID().slice(0, 8);
  const ada = await db.user.create({ data: { username: `oms-ada-${suffix}` } });
  const workspace = await db.workspace.create({
    data: {
      slug: `oms-${suffix}`,
      name: "Own message signal",
      members: { create: [{ userId: ada.id, role: "owner" }] },
    },
  });
  try {
    await enrollGeneralChannel(db, workspace.id);
    const general = await db.conversation.findFirstOrThrow({
      where: { workspaceId: workspace.id, channelName: "general" },
    });
    const announced: ConversationRealtimeMessage[] = [];
    const realtime: ConversationRealtime = {
      async messageAvailable(input) {
        announced.push(input);
      },
      async memberChanged() {},
    };
    // No Agent is in the channel, so nothing is pushed to a daemon.
    const publisher = {
      async publish() {},
      async publishJson() {},
    } as unknown as CentrifugoServerApi;
    // Each send is stored once without Redis.
    const idempotency: MessageRequestIdempotency = { execute: (_scope, persist) => persist() };
    const channels = new PublicChannels(db, idempotency, publisher, undefined, realtime);
    const sent = await channels.send({
      workspaceId: workspace.id,
      userId: ada.id,
      channelId: general.id,
      requestId: crypto.randomUUID(),
      body: "my own words",
    });
    expect(announced).toEqual([
      expect.objectContaining({ messageId: sent.id, senderUserId: ada.id }),
    ]);
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } }).catch(() => {});
    await db.user.deleteMany({ where: { username: { endsWith: suffix } } }).catch(() => {});
    await db.$disconnect();
  }
});
