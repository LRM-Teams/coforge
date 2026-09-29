import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import type { ViewerEvent } from "#src/features/conversations/conversation-realtime";
import {
  PublicChannels,
  enrollGeneralChannel,
} from "#src/server/conversations/public-channels.server";
import type { ConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import { AgentChannelManagement } from "#src/server/conversations/agent-channel-management.server";
import { arrangeConversationPins } from "#src/server/conversations/conversation-pins.server";

/**
 * The events a person's own pages hear about their place in a channel (`ViewerEvent`), from the
 * real `PublicChannels` writes against local PostgreSQL: who hears each one, and that a write
 * which changed nothing announces nothing.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;

function recordingRealtime() {
  const announced: { userIds: readonly string[]; event: ViewerEvent }[] = [];
  const realtime: ConversationRealtime = {
    async messageAvailable() {},
    async memberChanged() {},
    async channelUpdated() {},
    async viewerChanged(input) {
      announced.push(input);
    },
  };
  return { realtime, announced };
}

async function setup() {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: connectionString! }) });
  const suffix = crypto.randomUUID().slice(0, 8);
  const ada = await db.user.create({ data: { username: `ve-ada-${suffix}` } });
  const bob = await db.user.create({ data: { username: `ve-bob-${suffix}` } });
  const workspace = await db.workspace.create({
    data: {
      slug: `ve-${suffix}`,
      name: "Viewer events",
      members: {
        create: [
          { userId: ada.id, role: "owner" },
          { userId: bob.id, role: "member" },
        ],
      },
    },
  });
  await enrollGeneralChannel(db, workspace.id);
  const { realtime, announced } = recordingRealtime();
  const channels = new PublicChannels(db, undefined, undefined, undefined, realtime);
  const team = await channels.create(workspace.id, ada.id, `team-${suffix}`);
  await channels.join(workspace.id, bob.id, team.id);
  /** Posts a top-level message as `userId`, the way a send stores it. */
  const post = async (userId: string) => {
    const member = await db.conversationMember.findFirstOrThrow({
      where: { conversationId: team.id, userId },
    });
    const latest = await db.message.findFirst({
      where: { conversationId: team.id },
      orderBy: { sequence: "desc" },
    });
    return db.message.create({
      data: {
        conversationId: team.id,
        workspaceId: workspace.id,
        senderMemberId: member.id,
        body: "hello",
        sequence: (latest?.sequence ?? 0) + 1,
      },
    });
  };
  announced.length = 0;
  /** Removes the Workspace and every person this test made (all named with its suffix). */
  const teardown = async () => {
    await db.workspace.delete({ where: { id: workspace.id } }).catch(() => {});
    await db.user.deleteMany({ where: { username: { endsWith: suffix } } }).catch(() => {});
    await db.$disconnect();
  };
  return { db, suffix, workspace, ada, bob, team, channels, realtime, announced, post, teardown };
}

test.skipIf(!connectionString)(
  "reading a channel tells the reader's pages its unread count, and a read that moves nothing says nothing",
  async () => {
    const { teardown, workspace, ada, bob, team, channels, announced, post } = await setup();
    try {
      await post(ada.id);
      const second = await post(ada.id);
      const third = await post(ada.id);
      announced.length = 0;

      await channels.markRead(workspace.id, bob.id, team.id, second.sequence);
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
      ]);

      announced.length = 0;
      await channels.markRead(workspace.id, bob.id, team.id, second.sequence);
      expect(announced).toEqual([]);

      await channels.markRead(workspace.id, bob.id, team.id, third.sequence);
      expect(announced.map(({ event }) => event)).toEqual([
        {
          type: "channel.marked.v1",
          workspaceId: workspace.id,
          conversationId: team.id,
          unreadCount: 0,
        },
      ]);
    } finally {
      await teardown();
    }
  },
);

test.skipIf(!connectionString)(
  "marking a channel unread tells the member's pages the badge it opens",
  async () => {
    const { teardown, workspace, ada, bob, team, channels, announced, post } = await setup();
    try {
      const last = await post(ada.id);
      await channels.markRead(workspace.id, bob.id, team.id, last.sequence);
      announced.length = 0;

      await channels.setUserUnread(workspace.id, bob.id, team.id, true);
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
      ]);
    } finally {
      await teardown();
    }
  },
);

test.skipIf(!connectionString)(
  "joining, creating or being added tells only the people now in the channel",
  async () => {
    const { db, teardown, suffix, workspace, ada, bob, team, channels, announced } = await setup();
    try {
      const carol = await db.user.create({
        data: { username: `ve-carol-${suffix}` },
      });
      await db.workspaceMembership.create({
        data: { workspaceId: workspace.id, userId: carol.id, role: "member" },
      });
      const joined = (conversationId: string) => ({
        type: "channel.joined.v1" as const,
        workspaceId: workspace.id,
        conversationId,
      });

      const lab = await channels.create(
        workspace.id,
        bob.id,
        `lab-${crypto.randomUUID().slice(0, 8)}`,
      );
      expect(announced).toEqual([{ userIds: [bob.id], event: joined(lab.id) }]);

      announced.length = 0;
      await channels.join(workspace.id, ada.id, lab.id);
      expect(announced).toEqual([{ userIds: [ada.id], event: joined(lab.id) }]);

      announced.length = 0;
      await channels.addMembers(workspace.id, { userId: ada.id }, team.id, {
        userIds: [bob.id, carol.id],
        agentIds: [],
      });
      // Bob was already in the channel: only Carol's place changed.
      expect(announced).toEqual([{ userIds: [carol.id], event: joined(team.id) }]);
    } finally {
      await teardown();
    }
  },
);

test.skipIf(!connectionString)(
  "leaving, or being removed by a person or an Agent, tells the person who is out",
  async () => {
    const { db, teardown, workspace, ada, bob, team, channels, realtime, announced } =
      await setup();
    try {
      const left = {
        type: "channel.left.v1" as const,
        workspaceId: workspace.id,
        conversationId: team.id,
      };

      await channels.leave(workspace.id, bob.id, team.id);
      expect(announced).toEqual([{ userIds: [bob.id], event: left }]);

      await channels.join(workspace.id, bob.id, team.id);
      announced.length = 0;
      await channels.removeMember(workspace.id, ada.id, team.id, { userId: bob.id });
      expect(announced).toEqual([{ userIds: [bob.id], event: left }]);

      await channels.join(workspace.id, bob.id, team.id);
      const admin = await db.agent.create({
        data: {
          workspaceId: workspace.id,
          name: `ve-admin-${crypto.randomUUID().slice(0, 8)}`,
          displayName: "Admin",
          ownerId: ada.id,
          role: "admin",
          runtimeConfig: {
            runtime: "pi",
            provider: { kind: "default" },
            model: "",
            modelProvider: "",
            reasoning: "",
          },
        },
      });
      const channel = await db.conversation.findUniqueOrThrow({ where: { id: team.id } });
      const bobUser = await db.user.findUniqueOrThrow({ where: { id: bob.id } });
      announced.length = 0;
      await new AgentChannelManagement(db, undefined, channels, realtime).removeMember(
        workspace.id,
        admin.id,
        `#${channel.channelName}`,
        { user: `@${bobUser.username}` },
      );
      expect(announced).toEqual([{ userIds: [bob.id], event: left }]);

      // Removing someone who is not in the channel changes nobody's place.
      announced.length = 0;
      await channels.removeMember(workspace.id, ada.id, team.id, { userId: bob.id });
      expect(announced).toEqual([]);
    } finally {
      await teardown();
    }
  },
);

test.skipIf(!connectionString)(
  "closing a channel in the list, or bringing it back, tells the member's pages",
  async () => {
    const { teardown, workspace, bob, team, channels, announced } = await setup();
    try {
      const ids = { workspaceId: workspace.id, conversationId: team.id };
      await channels.setUserHidden(workspace.id, bob.id, team.id, true);
      await channels.setUserHidden(workspace.id, bob.id, team.id, false);
      expect(announced).toEqual([
        { userIds: [bob.id], event: { type: "channel.closed.v1", ...ids } },
        { userIds: [bob.id], event: { type: "channel.opened.v1", ...ids } },
      ]);
    } finally {
      await teardown();
    }
  },
);

test.skipIf(!connectionString)(
  "muting, pinning or reordering pins tells the member's pages which preference changed",
  async () => {
    const { db, teardown, workspace, bob, team, channels, realtime, announced } = await setup();
    try {
      const pref = (name: "muted" | "pins") => ({
        userIds: [bob.id],
        event: { type: "pref.changed.v1" as const, workspaceId: workspace.id, name },
      });
      await channels.setUserMuted(workspace.id, bob.id, team.id, true);
      await channels.setUserPinned(workspace.id, bob.id, team.id, true);
      await arrangeConversationPins(
        db,
        workspace.id,
        bob.id,
        { pins: [], unpinned: [{ kind: "channel", channelId: team.id }] },
        realtime,
      );
      expect(announced).toEqual([pref("muted"), pref("pins"), pref("pins")]);
    } finally {
      await teardown();
    }
  },
);
