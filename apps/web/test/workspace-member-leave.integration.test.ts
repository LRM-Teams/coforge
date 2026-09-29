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
import {
  PrismaWorkspaceCatalogStore,
  WorkspaceCatalog,
} from "#src/server/workspaces/catalog.server";
import { WorkspaceDeparture } from "#src/server/workspaces/departure.server";
import { TaskBoard } from "#src/server/tasks/task-board.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { RedisClient } from "bun";
import { RedisMessageRequestIdempotency } from "#src/server/conversations/redis-message-request-idempotency.server";
import { SendDirectMessage } from "#src/server/conversations/direct-message.server";
import { handleAgentMessagesPost } from "#src/routes/api/agent/v1/messages";
import { handleAgentAttachmentUpload } from "#src/routes/api/agent/v1/attachments/index";
import { handleAttachmentUploadSessionCreate } from "#src/routes/api/agent/v1/attachment-upload-sessions/index";
import { handleAgentActionPrepare } from "#src/routes/api/agent/v1/actions/prepare";
import { ActionCards } from "#src/server/conversations/action-cards.server";

type Person = { id: string; username: string };

/**
 * Leaving a Workspace, or being removed from it, ends a person's memberships but never their
 * history: what they wrote stays readable under their name, and nobody still in the Workspace
 * sees them as a member. Drives the real services and Prisma stores against local PostgreSQL.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL; the Agent send test also
 * needs `CHANNEL_TEST_REDIS_URL` for request records.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
const redisUrl = Bun.env.CHANNEL_TEST_REDIS_URL;

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

/** Leaving the way the Leave Workspace server function does: leave, then go where `departure`
 * says. */
async function leaveAndGo(
  directory: WorkspaceMemberDirectory,
  departure: WorkspaceDeparture,
  input: { workspaceId: string; userId: string },
) {
  await directory.leave(input);
  return departure.next(input.userId);
}

/** The Workspace `/` returns to, kept in memory the way the browser keeps its cookie. */
function rememberedWorkspace(slug?: string) {
  const remembered = { slug };
  return {
    remembered,
    port: {
      read: () => remembered.slug,
      remember: (next: string) => {
        remembered.slug = next;
      },
      forget: () => {
        remembered.slug = undefined;
      },
    },
  };
}

test.skipIf(!connectionString)(
  "leaving goes to the Workspace last opened while still a member, else the first one left, and `/` remembers it",
  async () => {
    const { db, directory, invite, workspace, owner, bob } = await setup();
    const suffix = crypto.randomUUID().slice(0, 8);
    const [first, second] = [
      await db.workspace.create({
        data: {
          slug: `ml-first-${suffix}`,
          name: "First",
          members: { create: { userId: bob.id, role: "member" } },
        },
      }),
      await db.workspace.create({
        data: {
          slug: `ml-second-${suffix}`,
          name: "Second",
          members: { create: { userId: bob.id, role: "admin" } },
        },
      }),
    ];
    try {
      const departure = (slug?: string) => {
        const preference = rememberedWorkspace(slug);
        return {
          ...preference,
          departure: new WorkspaceDeparture(
            new WorkspaceCatalog(new PrismaWorkspaceCatalogStore(db)),
            preference.port,
          ),
        };
      };

      // `/` remembered the Workspace being left: the first one still theirs takes over.
      const leavingOpened = departure(workspace.slug);
      expect(
        await leaveAndGo(directory, leavingOpened.departure, {
          workspaceId: workspace.id,
          userId: bob.id,
        }),
      ).toEqual({ nextWorkspaceSlug: first.slug });
      expect(leavingOpened.remembered.slug).toBe(first.slug);

      // Left from another tab while `/` remembered a Workspace they are still in: that one stays.
      await invite();
      const leavingElsewhere = departure(second.slug);
      expect(
        await leaveAndGo(directory, leavingElsewhere.departure, {
          workspaceId: workspace.id,
          userId: bob.id,
        }),
      ).toEqual({ nextWorkspaceSlug: second.slug });
      expect(leavingElsewhere.remembered.slug).toBe(second.slug);
    } finally {
      await db.workspace.deleteMany({ where: { id: { in: [first.id, second.id] } } });
      await teardown(db, workspace.id, [owner.id, bob.id]);
    }
  },
);

test.skipIf(!connectionString)(
  "leaving the last Workspace goes nowhere and `/` forgets it; the owner cannot leave",
  async () => {
    const { db, directory, workspace, owner, bob } = await setup();
    try {
      const catalog = new WorkspaceCatalog(new PrismaWorkspaceCatalogStore(db));
      const bobs = rememberedWorkspace(workspace.slug);
      expect(
        await leaveAndGo(directory, new WorkspaceDeparture(catalog, bobs.port), {
          workspaceId: workspace.id,
          userId: bob.id,
        }),
      ).toEqual({ nextWorkspaceSlug: null });
      expect(bobs.remembered.slug).toBeUndefined();

      const owners = rememberedWorkspace(workspace.slug);
      await expect(
        leaveAndGo(directory, new WorkspaceDeparture(catalog, owners.port), {
          workspaceId: workspace.id,
          userId: owner.id,
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(owners.remembered.slug).toBe(workspace.slug);
      expect((await catalog.listForUser(owner.id)).map((row) => row.id)).toEqual([workspace.id]);
    } finally {
      await teardown(db, workspace.id, [owner.id, bob.id]);
    }
  },
);

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
      const history = await channels.open(workspace.id, owner.id, team.id);
      expect(history.messages.at(-1)).toMatchObject({
        body: "back on it",
        senderHandle: bob.username,
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

const createAgent = (db: PrismaClient, workspaceId: string, owner: Person) =>
  db.agent.create({
    data: {
      workspaceId,
      ownerId: owner.id,
      name: `helper-${owner.username}`,
      displayName: "Helper",
      runtimeConfig: {},
    },
  });

/** Bob's own Agent, with one direct message from Bob it has not read yet. */
async function unreadAgentDirectMessage(db: PrismaClient, workspaceId: string, bob: Person) {
  const helper = await createAgent(db, workspaceId, bob);
  const repo = new PrismaDirectConversationRepository(db);
  const opened = await repo.memberForUser(workspaceId, bob.id, helper.id);
  const sent = await repo.sendMessage(
    opened.conversationId,
    opened.senderMemberId,
    bob.id,
    "please look",
  );
  return { repo, helper, conversationId: opened.conversationId, sent };
}

test.skipIf(!connectionString)(
  "an Agent still recovers, reads and marks read a direct message from someone who left",
  async () => {
    const { db, directory, workspace, owner, bob } = await setup();
    try {
      const { repo, helper, sent } = await unreadAgentDirectMessage(db, workspace.id, bob);

      await directory.leave({ workspaceId: workspace.id, userId: bob.id });

      const recovery = await repo.readAgentRecoveryContext(workspace.id, helper.id);
      expect(recovery.unreadSummary).toEqual({ [`@${bob.username}`]: 1 });
      await repo.advanceAgentReadThrough(
        workspace.id,
        helper.id,
        `@${bob.username}`,
        sent.sequence,
      );
      expect((await repo.readAgentRecoveryContext(workspace.id, helper.id)).unreadSummary).toEqual(
        {},
      );
    } finally {
      await teardown(db, workspace.id, [owner.id, bob.id]);
    }
  },
);

const departedRefusal = (bob: Person) => ({
  code: "DM_PEER_NOT_IN_WORKSPACE",
  error: `@${bob.username} is not a member of this Workspace, so this Agent cannot send them a direct message`,
  retryable: false,
});

test.skipIf(!connectionString || !redisUrl)(
  "an Agent's reply to someone who left is refused with a stable code, and nothing is written",
  async () => {
    const { db, directory, workspace, owner, bob } = await setup();
    const redis = new RedisClient(redisUrl!);
    try {
      const { repo, helper, conversationId, sent } = await unreadAgentDirectMessage(
        db,
        workspace.id,
        bob,
      );
      const agentBoundary = () =>
        db.conversationMember.findFirstOrThrow({
          where: { conversationId, agentId: helper.id },
          select: { agentReadThroughSequence: true },
        });
      const boundaryBefore = await agentBoundary();

      await directory.leave({ workspaceId: workspace.id, userId: bob.id });

      const records = new RedisMessageRequestIdempotency(redis);
      const dependencies = {
        repository: repo,
        requestRecords: records,
        sender: new SendDirectMessage(repo, records, { publish: async () => {} }),
      };
      const send = {
        target: `@${bob.username}`,
        content: "on it",
      };
      // Having reviewed the unread message, with it still unread, and sending anyway: none of
      // them advances the Agent's read position, holds the send, or records the request.
      for (const extra of [{ seenUpToSeq: sent.sequence }, {}, { continueAnyway: true }]) {
        const idempotencyKey = crypto.randomUUID();
        const response = await handleAgentMessagesPost(
          new Request("https://server.example/api/agent/v1/messages", {
            method: "POST",
            body: JSON.stringify({ ...send, ...extra, idempotencyKey }),
          }),
          { workspaceId: workspace.id, agentId: helper.id },
          dependencies,
        );
        expect({ status: response.status, body: await response.json() }).toEqual({
          status: 403,
          body: departedRefusal(bob),
        });
        expect(
          await records.find({
            workspaceId: workspace.id,
            senderKind: "agent",
            senderId: helper.id,
            requestId: idempotencyKey,
          }),
        ).toBeUndefined();
      }
      expect(await db.message.count({ where: { conversationId } })).toBe(1);
      expect(await agentBoundary()).toEqual(boundaryBefore);
    } finally {
      redis.close();
      await teardown(db, workspace.id, [owner.id, bob.id]);
    }
  },
);

test.skipIf(!connectionString)(
  "an Agent cannot upload an attachment to someone who left",
  async () => {
    const { db, directory, workspace, owner, bob } = await setup();
    try {
      const { repo, helper } = await unreadAgentDirectMessage(db, workspace.id, bob);
      await directory.leave({ workspaceId: workspace.id, userId: bob.id });
      const principal = { workspaceId: workspace.id, agentId: helper.id };
      const resolveTarget = repo.resolveAgentSendTarget.bind(repo);
      let stored = 0;

      const form = new FormData();
      form.set("target", `@${bob.username}`);
      form.set("file", new File(["notes"], "notes.txt", { type: "text/plain" }));
      const upload = await handleAgentAttachmentUpload(
        new Request("https://server.example/api/agent/v1/attachments", {
          method: "POST",
          body: form,
        }),
        principal,
        {
          resolveTarget,
          store: async () => {
            stored += 1;
            throw new Error("nothing is stored for a refused target");
          },
        },
      );
      const session = await handleAttachmentUploadSessionCreate(
        new Request("https://server.example/api/agent/v1/attachment-upload-sessions", {
          method: "POST",
          body: JSON.stringify({
            target: `@${bob.username}`,
            fileName: "notes.txt",
            contentType: "text/plain",
            sizeBytes: 5,
            idempotencyKey: crypto.randomUUID(),
          }),
        }),
        principal,
        {
          resolveTarget,
          create: async () => {
            stored += 1;
            throw new Error("nothing is stored for a refused target");
          },
        },
      );

      for (const response of [upload, session])
        expect({ status: response.status, body: await response.json() }).toEqual({
          status: 403,
          body: departedRefusal(bob),
        });
      expect(stored).toBe(0);
    } finally {
      await teardown(db, workspace.id, [owner.id, bob.id]);
    }
  },
);

test.skipIf(!connectionString || !redisUrl)(
  "a replay of an Agent's committed reply still reports it sent after the person left",
  async () => {
    const { db, directory, workspace, owner, bob } = await setup();
    const redis = new RedisClient(redisUrl!);
    try {
      const { repo, helper, conversationId } = await unreadAgentDirectMessage(
        db,
        workspace.id,
        bob,
      );
      const records = new RedisMessageRequestIdempotency(redis);
      const dependencies = {
        repository: repo,
        requestRecords: records,
        sender: new SendDirectMessage(repo, records, { publish: async () => {} }),
      };
      const idempotencyKey = crypto.randomUUID();
      const send = () =>
        handleAgentMessagesPost(
          new Request("https://server.example/api/agent/v1/messages", {
            method: "POST",
            body: JSON.stringify({
              target: `@${bob.username}`,
              content: "on it",
              idempotencyKey,
              continueAnyway: true,
            }),
          }),
          { workspaceId: workspace.id, agentId: helper.id },
          dependencies,
        ).then(async (response) => ({ status: response.status, body: await response.json() }));
      const messageCount = () => db.message.count({ where: { conversationId } });

      // The first send commits; its answer is lost, and the person leaves before the retry.
      const first = await send();
      expect(first).toMatchObject({ status: 200, body: { state: "sent" } });
      const committed = await messageCount();
      await directory.leave({ workspaceId: workspace.id, userId: bob.id });

      const replay = await send();
      expect(replay).toMatchObject({
        status: 200,
        body: {
          state: "sent",
          messageId: first.body.messageId,
          pendingMentionActions: first.body.pendingMentionActions,
          unresolvedMentionHandles: first.body.unresolvedMentionHandles,
        },
      });
      expect(await messageCount()).toBe(committed);
    } finally {
      redis.close();
      await teardown(db, workspace.id, [owner.id, bob.id]);
    }
  },
);

/** A route's answer, or what it threw past the handler (which the Agent middleware turns into 401). */
async function outcome(respond: () => Promise<Response>) {
  try {
    const response = await respond();
    return { status: response.status, body: await response.json() };
  } catch (error) {
    return { thrown: error instanceof Error ? error.message : String(error) };
  }
}

test.skipIf(!connectionString || !redisUrl)(
  "an Agent's send, upload or action card to someone outside the Workspace reads exactly like an unknown username",
  async () => {
    const { db, workspace, owner, bob } = await setup();
    const redis = new RedisClient(redisUrl!);
    const elsewhere = await db.user.create({
      data: { username: `ml-elsewhere-${crypto.randomUUID().slice(0, 8)}` },
    });
    const otherWorkspace = await db.workspace.create({
      data: {
        slug: `ml-other-${crypto.randomUUID().slice(0, 8)}`,
        name: "Elsewhere",
        members: { create: { userId: elsewhere.id, role: "owner" } },
      },
    });
    try {
      const helper = await createAgent(db, workspace.id, bob);
      const repo = new PrismaDirectConversationRepository(db);
      const records = new RedisMessageRequestIdempotency(redis);
      const principal = { workspaceId: workspace.id, agentId: helper.id };
      const resolveTarget = repo.resolveAgentSendTarget.bind(repo);
      const refuseStore = async (): Promise<never> => {
        throw new Error("nothing is stored for a refused target");
      };
      const answers = async (target: string) => {
        const form = new FormData();
        form.set("target", target);
        form.set("file", new File(["notes"], "notes.txt", { type: "text/plain" }));
        return {
          send: await outcome(() =>
            handleAgentMessagesPost(
              new Request("https://server.example/api/agent/v1/messages", {
                method: "POST",
                body: JSON.stringify({
                  target,
                  content: "hi",
                  idempotencyKey: crypto.randomUUID(),
                }),
              }),
              principal,
              {
                repository: repo,
                requestRecords: records,
                sender: new SendDirectMessage(repo, records, { publish: async () => {} }),
              },
            ),
          ),
          upload: await outcome(() =>
            handleAgentAttachmentUpload(
              new Request("https://server.example/api/agent/v1/attachments", {
                method: "POST",
                body: form,
              }),
              principal,
              { resolveTarget, store: refuseStore },
            ),
          ),
          session: await outcome(() =>
            handleAttachmentUploadSessionCreate(
              new Request("https://server.example/api/agent/v1/attachment-upload-sessions", {
                method: "POST",
                body: JSON.stringify({
                  target,
                  fileName: "notes.txt",
                  contentType: "text/plain",
                  sizeBytes: 5,
                  idempotencyKey: crypto.randomUUID(),
                }),
              }),
              principal,
              { resolveTarget, create: refuseStore },
            ),
          ),
          prepare: await outcome(() =>
            handleAgentActionPrepare(
              new Request("https://server.example/api/agent/v1/actions/prepare", {
                method: "POST",
                body: JSON.stringify({
                  target,
                  action: { type: "channel:create", name: "ops", visibility: "public" },
                }),
              }),
              principal,
              () => new ActionCards(db, repo),
            ),
          ),
        };
      };

      const unknown = await answers(`@ml-nobody-${crypto.randomUUID().slice(0, 8)}`);
      expect(await answers(`@${elsewhere.username}`)).toEqual(unknown);
      expect(unknown.send).toEqual({
        status: 403,
        body: {
          error: "target is not accessible",
          code: "TARGET_NOT_ACCESSIBLE",
          retryable: false,
        },
      });
      expect(unknown.upload).toEqual(unknown.send);
      expect(unknown.session).toEqual(unknown.send);
      expect(unknown.prepare).toEqual(unknown.send);
    } finally {
      redis.close();
      await db.workspace.delete({ where: { id: otherWorkspace.id } }).catch(() => {});
      await db.user.delete({ where: { id: elsewhere.id } }).catch(() => {});
      await teardown(db, workspace.id, [owner.id, bob.id]);
    }
  },
);

test.skipIf(!connectionString)(
  "an Agent's action card to someone who left is refused with the same code",
  async () => {
    const { db, directory, workspace, owner, bob } = await setup();
    try {
      const { repo, helper } = await unreadAgentDirectMessage(db, workspace.id, bob);
      await directory.leave({ workspaceId: workspace.id, userId: bob.id });

      const response = await handleAgentActionPrepare(
        new Request("https://server.example/api/agent/v1/actions/prepare", {
          method: "POST",
          body: JSON.stringify({
            target: `@${bob.username}`,
            action: { type: "channel:create", name: `ops-${bob.username}` },
          }),
        }),
        { workspaceId: workspace.id, agentId: helper.id },
        () => new ActionCards(db, repo),
      );
      expect({ status: response.status, body: await response.json() }).toEqual({
        status: 403,
        body: departedRefusal(bob),
      });
    } finally {
      await teardown(db, workspace.id, [owner.id, bob.id]);
    }
  },
);

test.skipIf(!connectionString)(
  "a direct message with an Agent that lost its member row works again when the person opens it",
  async () => {
    const { db, workspace, owner, bob } = await setup();
    try {
      const helper = await createAgent(db, workspace.id, bob);
      const repo = new PrismaDirectConversationRepository(db);
      const { conversationId } = await repo.memberForUser(workspace.id, bob.id, helper.id);
      await repo.sendAgentMessage(conversationId, helper.id, "hello");
      // A row that owns no message could be deleted outright, and nothing else recreates it.
      await db.conversationMember.deleteMany({ where: { conversationId, userId: bob.id } });

      const direct = new DirectConversations(db);
      expect(await direct.open(workspace.id, bob.id, { agentId: helper.id })).toEqual({
        conversationId,
      });
      const page = await direct.page(workspace.id, bob.id, conversationId);
      expect(page.messages.map((message) => message.body)).toEqual(["hello"]);
    } finally {
      await teardown(db, workspace.id, [owner.id, bob.id]);
    }
  },
);
