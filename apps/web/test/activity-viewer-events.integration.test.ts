import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import type { ViewerEvent } from "#src/features/conversations/conversation-realtime";
import type { ConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import { DirectConversations } from "#src/server/conversations/direct-conversations.server";
import { PublicChannels } from "#src/server/conversations/public-channels.server";
import { ActivityInbox } from "#src/server/inbox/activity-inbox.server";

/**
 * The read cursors the Activity page moves (Done, Mark all read) tell the person's other pages the
 * badge each conversation is left with, as a read in the conversation does (`channel.marked.v1`,
 * `dm.marked.v1`). Real `ActivityInbox` writes against local PostgreSQL.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;

async function setup() {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: connectionString! }) });
  const suffix = crypto.randomUUID().slice(0, 8);
  const ada = await db.user.create({ data: { username: `ave-ada-${suffix}` } });
  const bob = await db.user.create({ data: { username: `ave-bob-${suffix}` } });
  const workspace = await db.workspace.create({
    data: {
      slug: `ave-${suffix}`,
      name: "Activity viewer events",
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
  const channels = new PublicChannels(db, undefined, undefined, undefined, realtime);
  const team = await channels.create(workspace.id, ada.id, `team-${suffix}`);
  await channels.join(workspace.id, bob.id, team.id);
  const { conversationId: dm } = await new DirectConversations(db, realtime).open(
    workspace.id,
    ada.id,
    { userId: bob.id },
  );
  let clock = Date.UTC(2026, 0, 1, 8, 0, 0);
  /** Posts a top-level message as `userId`, a minute after the last one. */
  const post = async (conversationId: string, userId: string, threadRootId?: string) => {
    const member = await db.conversationMember.findFirstOrThrow({
      where: { conversationId, userId },
    });
    const latest = await db.message.findFirst({
      where: { conversationId },
      orderBy: { sequence: "desc" },
    });
    clock += 60_000;
    return db.message.create({
      data: {
        conversationId,
        workspaceId: workspace.id,
        senderMemberId: member.id,
        body: "hello",
        sequence: (latest?.sequence ?? 0) + 1,
        createdAt: new Date(clock),
        threadRootId: threadRootId ?? null,
      },
    });
  };
  const teardown = async () => {
    await db.workspace.delete({ where: { id: workspace.id } }).catch(() => {});
    await db.user.deleteMany({ where: { username: { endsWith: suffix } } }).catch(() => {});
    await db.$disconnect();
  };
  const inbox = new ActivityInbox(db, realtime);
  announced.length = 0;
  return { workspace, bob, ada, team, dm, inbox, announced, post, teardown };
}

test.skipIf(!connectionString)(
  "marking a conversation Done tells the person's pages its badge; a thread's Done does not touch it",
  async () => {
    const { workspace, ada, bob, team, dm, inbox, announced, post, teardown } = await setup();
    try {
      const root = await post(team.id, ada.id);
      await post(team.id, ada.id);
      await post(team.id, ada.id, root.id);
      const inDm = await post(dm, ada.id);

      await inbox.markDone(workspace.id, bob.id, {
        kind: "conversation",
        conversationId: team.id,
        throughSequence: root.sequence,
      });
      await inbox.markDone(workspace.id, bob.id, {
        kind: "conversation",
        conversationId: dm,
        throughSequence: inDm.sequence,
      });
      await inbox.markDone(workspace.id, bob.id, {
        kind: "thread",
        conversationId: team.id,
        rootMessageId: root.id,
        throughSequence: root.sequence + 2,
      });
      expect(announced).toEqual([
        {
          userIds: [bob.id],
          event: {
            type: "channel.marked.v1",
            workspaceId: workspace.id,
            conversationId: team.id,
            unreadCount: 1,
          },
        },
        {
          userIds: [bob.id],
          event: {
            type: "dm.marked.v1",
            workspaceId: workspace.id,
            conversationId: dm,
            unreadCount: 0,
          },
        },
      ]);
    } finally {
      await teardown();
    }
  },
);

test.skipIf(!connectionString)(
  "mark all read tells the person's pages the badge of each conversation it moved, and only those",
  async () => {
    const { workspace, ada, bob, team, dm, inbox, announced, post, teardown } = await setup();
    try {
      await post(team.id, ada.id);
      const shown = await post(dm, ada.id);
      // Posted after the page the person marked from: it stays unread.
      await post(dm, ada.id);

      await inbox.markAllRead(workspace.id, bob.id, {
        before: new Date(shown.createdAt.getTime()),
      });
      expect(
        announced
          .map(({ userIds, event }) => ({ userIds, event }))
          .sort((a, b) => a.event.type.localeCompare(b.event.type)),
      ).toEqual([
        {
          userIds: [bob.id],
          event: {
            type: "channel.marked.v1",
            workspaceId: workspace.id,
            conversationId: team.id,
            unreadCount: 0,
          },
        },
        {
          userIds: [bob.id],
          event: {
            type: "dm.marked.v1",
            workspaceId: workspace.id,
            conversationId: dm,
            unreadCount: 1,
          },
        },
      ]);

      // Nothing new to read: nothing announced.
      announced.length = 0;
      await inbox.markAllRead(workspace.id, bob.id, { before: shown.createdAt });
      expect(announced).toEqual([]);
    } finally {
      await teardown();
    }
  },
);
