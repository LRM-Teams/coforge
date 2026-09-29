import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import {
  generalChannelForCreator,
  PublicChannels,
} from "#src/server/conversations/public-channels.server";
import type { MessageRequestIdempotency } from "#src/server/conversations/message-request-idempotency.server";
import { UserDirectConversations } from "#src/server/conversations/user-direct-conversations.server";
import type {
  ConversationRealtime,
  ConversationRealtimeMessage,
  TaskChangedSignal,
} from "#src/server/conversations/conversation-realtime.server";
import { DirectConversations } from "#src/server/conversations/direct-conversations.server";
import { PrismaWorkspaceMemberDirectoryStore } from "#src/server/workspaces/member-directory-store.server";
import { WorkspaceMemberDirectory } from "#src/server/workspaces/member-directory.server";
import { TaskBoard } from "#src/server/tasks/task-board.server";

/**
 * Leaving a Workspace, or being removed from it, ends a person's memberships but never their
 * history: what they wrote stays readable under their name, and nobody still in the Workspace
 * sees them as a member. Drives the real services and Prisma stores against local PostgreSQL.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;

// Every send goes through request idempotency; these tests store each request once.
const passThrough: MessageRequestIdempotency = { execute: (_scope, persist) => persist() };
// Member-list announcements have their own suite (`channel-member-changed.integration.test.ts`).
const silentRealtime: ConversationRealtime = {
  async messageAvailable() {},
  async memberChanged() {},
};

async function setup() {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: connectionString! }) });
  const suffix = crypto.randomUUID().slice(0, 8);
  const owner = await db.user.create({ data: { username: `ml-owner-${suffix}` } });
  const bob = await db.user.create({ data: { username: `ml-bob-${suffix}` } });
  const workspace = await db.workspace.create({
    data: {
      slug: `ml-${suffix}`,
      name: "Member leave",
      members: { create: { userId: owner.id, role: "owner" } },
      conversations: generalChannelForCreator(owner.id),
    },
  });
  const directory = new WorkspaceMemberDirectory(
    new PrismaWorkspaceMemberDirectoryStore(db),
    undefined,
    silentRealtime,
  );
  const channels = new PublicChannels(db, passThrough, undefined, undefined, silentRealtime);
  const invite = async () => {
    const invitation = await directory.invite({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      inviteeUsername: bob.username,
      role: "member",
    });
    await directory.acceptInvitation({ invitationId: invitation.id, userId: bob.id });
  };
  await invite();
  const team = await channels.create(workspace.id, owner.id, `team-${suffix}`);
  await channels.join(workspace.id, bob.id, team.id);
  return { db, directory, channels, invite, workspace, owner, bob, team };
}

async function teardown(db: PrismaClient, workspaceId: string, userIds: string[]) {
  await db.workspace.delete({ where: { id: workspaceId } }).catch(() => {});
  await db.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  await db.$disconnect();
}

test.skipIf(!connectionString)(
  "a member who wrote in a channel can leave, and what they wrote stays readable under their name",
  async () => {
    const { db, directory, channels, workspace, owner, bob, team } = await setup();
    try {
      await channels.send({
        requestId: crypto.randomUUID(),
        workspaceId: workspace.id,
        userId: bob.id,
        channelId: team.id,
        body: "handing this over",
      });

      await directory.leave({ workspaceId: workspace.id, userId: bob.id });

      const history = await channels.open(workspace.id, owner.id, team.id);
      const message = history.messages.find((row) => row.body === "handing this over");
      expect(message).toMatchObject({ senderKind: "user", senderHandle: bob.username });
      const members = await channels.members(workspace.id, { userId: owner.id }, team.id);
      expect(members.humans.map((human) => human.id)).toEqual([owner.id]);
    } finally {
      await teardown(db, workspace.id, [owner.id, bob.id]);
    }
  },
);

test.skipIf(!connectionString)(
  "a removed member keeps their Tasks, and when invited back returns to #general and can rejoin",
  async () => {
    const { db, directory, channels, invite, workspace, owner, bob, team } = await setup();
    try {
      const board = new TaskBoard(db);
      const created = await board.execute(
        { workspaceId: workspace.id, userId: bob.id },
        {
          operation: "create",
          idempotencyKey: crypto.randomUUID(),
          conversationId: team.id,
          title: "Ship the release",
          assignee: `@${bob.username}`,
        },
      );
      const taskNumber = created.tasks[0]!.number;

      await directory.removeMember({
        workspaceId: workspace.id,
        actorUserId: owner.id,
        targetUserId: bob.id,
      });

      const listed = await board.execute(
        { workspaceId: workspace.id, userId: owner.id },
        { operation: "list", idempotencyKey: crypto.randomUUID(), conversationId: team.id },
      );
      expect(listed.tasks.find((task) => task.number === taskNumber)).toMatchObject({
        owner: { kind: "user", id: bob.id, left: true },
      });

      await invite();
      const general = await db.conversation.findUniqueOrThrow({
        where: { workspaceId_channelName: { workspaceId: workspace.id, channelName: "general" } },
      });
      const generalMembers = await channels.members(workspace.id, { userId: owner.id }, general.id);
      expect(generalMembers.humans.map((human) => human.id).sort()).toEqual(
        [owner.id, bob.id].sort(),
      );
      // Not back in the other channel until they join it again.
      expect(
        (await channels.list(workspace.id, bob.id)).find((row) => row.id === team.id)?.joined,
      ).toBe(false);
      await channels.join(workspace.id, bob.id, team.id);
      await channels.send({
        requestId: crypto.randomUUID(),
        workspaceId: workspace.id,
        userId: bob.id,
        channelId: team.id,
        body: "back on it",
      });
    } finally {
      await teardown(db, workspace.id, [owner.id, bob.id]);
    }
  },
);

test.skipIf(!connectionString)(
  "a member's direct conversations stay readable to the other side, and are theirs again when they return",
  async () => {
    const { db, directory, invite, workspace, owner, bob } = await setup();
    try {
      const announced: ConversationRealtimeMessage[] = [];
      const taskSignals: TaskChangedSignal[] = [];
      const realtime = {
        ...silentRealtime,
        async messageAvailable(input: ConversationRealtimeMessage) {
          announced.push(input);
        },
        async taskChanged(signal: TaskChangedSignal) {
          taskSignals.push(signal);
        },
      };
      const people = new UserDirectConversations(db, passThrough, realtime);
      const direct = new DirectConversations(db);
      const helper = await db.agent.create({
        data: {
          workspaceId: workspace.id,
          ownerId: bob.id,
          name: `helper-${bob.username}`,
          displayName: "Helper",
          runtimeConfig: {},
        },
      });
      const withOwner = await direct.open(workspace.id, bob.id, { userId: owner.id });
      const withHelper = await direct.open(workspace.id, bob.id, { agentId: helper.id });
      await people.send({
        requestId: crypto.randomUUID(),
        workspaceId: workspace.id,
        conversationId: withOwner.conversationId,
        senderUserId: bob.id,
        body: "see you",
      });

      await directory.leave({ workspaceId: workspace.id, userId: bob.id });

      // The other side still reads it, named after them; nothing new reaches them.
      const page = await direct.page(workspace.id, owner.id, withOwner.conversationId);
      expect(page).toMatchObject({ kind: "people", peer: { id: bob.id } });
      expect(page.messages.map((message) => message.body)).toEqual(["see you"]);
      await people.send({
        requestId: crypto.randomUUID(),
        workspaceId: workspace.id,
        conversationId: withOwner.conversationId,
        senderUserId: owner.id,
        body: "take care",
      });
      // The sender's own list is never signalled, and nobody else is left in it.
      expect(announced.at(-1)?.directUserIds).toEqual([]);
      await new TaskBoard(db, { realtime }).execute(
        { workspaceId: workspace.id, userId: owner.id },
        {
          operation: "create",
          idempotencyKey: crypto.randomUUID(),
          conversationId: withOwner.conversationId,
          title: "Return the keys",
        },
      );
      expect(taskSignals.map((signal) => signal.directUserIds)).toEqual([[owner.id]]);
      await expect(
        direct.page(workspace.id, bob.id, withOwner.conversationId),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });

      await invite();
      const back = await direct.page(workspace.id, bob.id, withOwner.conversationId);
      expect(back.messages.map((message) => message.body)).toEqual(
        expect.arrayContaining(["see you", "take care"]),
      );
      const list = await direct.list(workspace.id, bob.id);
      expect(list.conversations.map((row) => row.conversationId).sort()).toEqual(
        [withOwner.conversationId, withHelper.conversationId].sort(),
      );
    } finally {
      await teardown(db, workspace.id, [owner.id, bob.id]);
    }
  },
);
