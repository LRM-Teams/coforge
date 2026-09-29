import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import type { ViewerEvent } from "#src/features/conversations/conversation-realtime";
import type { ConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import { DirectConversations } from "#src/server/conversations/direct-conversations.server";

/**
 * The events a person's own pages hear about their place in a DM (`ViewerEvent`), from the real
 * `DirectConversations` writes against local PostgreSQL: who hears each one, and that a write
 * which changed nothing announces nothing.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;

async function setup() {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: connectionString! }) });
  const suffix = crypto.randomUUID().slice(0, 8);
  const ada = await db.user.create({ data: { username: `dve-ada-${suffix}` } });
  const bob = await db.user.create({ data: { username: `dve-bob-${suffix}` } });
  const workspace = await db.workspace.create({
    data: {
      slug: `dve-${suffix}`,
      name: "DM viewer events",
      members: {
        create: [
          { userId: ada.id, role: "owner" },
          { userId: bob.id, role: "member" },
        ],
      },
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
  const dms = new DirectConversations(db, realtime);
  /** Posts a top-level message into the DM as `userId`, the way a send stores it. */
  const post = async (conversationId: string, userId: string) => {
    const member = await db.conversationMember.findFirstOrThrow({
      where: { conversationId, userId },
    });
    const latest = await db.message.findFirst({
      where: { conversationId },
      orderBy: { sequence: "desc" },
    });
    return db.message.create({
      data: {
        conversationId,
        workspaceId: workspace.id,
        senderMemberId: member.id,
        body: "hello",
        sequence: (latest?.sequence ?? 0) + 1,
      },
    });
  };
  const teardown = async () => {
    await db.workspace.delete({ where: { id: workspace.id } }).catch(() => {});
    await db.user.deleteMany({ where: { username: { endsWith: suffix } } }).catch(() => {});
    await db.$disconnect();
  };
  return { db, workspace, ada, bob, dms, announced, post, teardown };
}

test.skipIf(!connectionString)(
  "reading a DM tells the reader's pages its unread count, and a read that moves nothing says nothing",
  async () => {
    const { workspace, ada, bob, dms, announced, post, teardown } = await setup();
    try {
      const { conversationId } = await dms.open(workspace.id, ada.id, { userId: bob.id });
      await post(conversationId, ada.id);
      const second = await post(conversationId, ada.id);
      const third = await post(conversationId, ada.id);
      announced.length = 0;
      const marked = (unreadCount: number) => ({
        userIds: [bob.id],
        event: {
          type: "dm.marked.v1" as const,
          workspaceId: workspace.id,
          conversationId,
          unreadCount,
        },
      });

      await dms.markRead(workspace.id, bob.id, conversationId, second.sequence);
      await dms.markRead(workspace.id, bob.id, conversationId, second.sequence);
      await dms.markRead(workspace.id, bob.id, conversationId, third.sequence);
      expect(announced).toEqual([marked(1), marked(0)]);
    } finally {
      await teardown();
    }
  },
);

test.skipIf(!connectionString)(
  "marking a DM unread, closing it or bringing it back tells the viewer's pages, once per change",
  async () => {
    const { workspace, ada, bob, dms, announced, post, teardown } = await setup();
    try {
      const { conversationId } = await dms.open(workspace.id, ada.id, { userId: bob.id });
      const last = await post(conversationId, ada.id);
      await dms.markRead(workspace.id, bob.id, conversationId, last.sequence);
      announced.length = 0;
      const ids = { workspaceId: workspace.id, conversationId };

      await dms.setUnread(workspace.id, bob.id, conversationId, true);
      await dms.setUnread(workspace.id, bob.id, conversationId, true);
      await dms.setHidden(workspace.id, bob.id, conversationId, true);
      await dms.setHidden(workspace.id, bob.id, conversationId, true);
      await dms.setHidden(workspace.id, bob.id, conversationId, false);
      expect(announced).toEqual([
        { userIds: [bob.id], event: { type: "dm.marked.v1", ...ids, unreadCount: 1 } },
        { userIds: [bob.id], event: { type: "dm.closed.v1", ...ids } },
        { userIds: [bob.id], event: { type: "dm.opened.v1", ...ids } },
      ]);
    } finally {
      await teardown();
    }
  },
);

test.skipIf(!connectionString)(
  "starting a DM tells everyone in it once; opening it again says nothing",
  async () => {
    const { db, workspace, ada, bob, dms, announced, teardown } = await setup();
    try {
      const created = (conversationId: string) => ({
        type: "dm.created.v1" as const,
        workspaceId: workspace.id,
        conversationId,
      });
      const people = await dms.open(workspace.id, ada.id, { userId: bob.id });
      await dms.open(workspace.id, bob.id, { userId: ada.id });
      const self = await dms.open(workspace.id, ada.id, { userId: ada.id });
      const agent = await db.agent.create({
        data: {
          workspaceId: workspace.id,
          name: `dve-agent-${workspace.id.slice(0, 8)}`,
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
      const withAgent = await dms.open(workspace.id, ada.id, { agentId: agent.id });
      await dms.open(workspace.id, ada.id, { agentId: agent.id });
      expect(announced).toEqual([
        { userIds: [ada.id, bob.id], event: created(people.conversationId) },
        { userIds: [ada.id], event: created(self.conversationId) },
        { userIds: [ada.id], event: created(withAgent.conversationId) },
      ]);
    } finally {
      await teardown();
    }
  },
);
