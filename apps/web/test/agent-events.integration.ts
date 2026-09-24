import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import {
  PublicChannels,
  enrollGeneralChannel,
} from "#src/server/conversations/public-channels.server";

test("events drain returns unread rows in canonical order, advances read boundaries, and pages by limit", async () => {
  const connectionString = Bun.env.EVENTS_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("EVENTS_TEST_DATABASE_URL is required (local PostgreSQL)");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const id = crypto.randomUUID();
  const username = `e${id.slice(0, 8)}`;
  const user = await db.user.create({ data: { username } });
  const workspace = await db.workspace.create({
    data: {
      slug: id,
      name: "Events test",
      members: { create: { userId: user.id } },
    },
  });
  try {
    const agent = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: user.id,
        name: "helper",
        displayName: "Helper",
        runtimeConfig: {},
      },
    });
    const repo = new PrismaDirectConversationRepository(db);
    const channels = new PublicChannels(db, { execute: async (_scope, persist) => persist() });
    const dmTarget = `@${username}`;

    // DM root + thread reply, both sent by the user (unread to the Agent without a delivery row).
    const opened = await repo.openForUser(workspace.id, user.id, agent.id);
    const root = await repo.sendMessage(
      opened.conversationId,
      opened.senderMemberId,
      user.id,
      "dm root",
    );
    const reply = await repo.sendMessage(
      opened.conversationId,
      opened.senderMemberId,
      user.id,
      "dm thread reply",
      undefined,
      root.id,
    );
    const threadTarget = `@${username}:${root.id}`;

    // A #general channel message the Agent has a delivery for. An Agent joins #general muted,
    // so it is unmuted here to receive ordinary chatter.
    const general = await enrollGeneralChannel(db, workspace.id);
    await db.conversationMember.update({
      where: { conversationId_agentId: { conversationId: general.id, agentId: agent.id } },
      data: { channelMuted: false },
    });
    const channelMessage = await channels.send({
      workspaceId: workspace.id,
      userId: user.id,
      channelId: general.id,
      requestId: crypto.randomUUID(),
      body: "channel message",
    });
    const channelTarget = "#general";

    // A DM's sender is the message's own author and its target the conversation's other member.
    // Both must come from the message rather than from the conversation's member list, whose
    // "other member" is the *recipient* — an Agent-authored message would be attributed to the
    // wrong side, and in a conversation with no user member to nothing at all. Read before the
    // drain below, which acknowledges and so empties the recovery context. The sender projection
    // names that author as structured facts — a bare handle, not the rendered
    // `@handle` — while `target` keeps the rendered form.
    expect(
      (await repo.readAgentRecoveryContext(workspace.id, agent.id)).resumeMessages.find(
        (message) => message.target === dmTarget,
      ),
    ).toMatchObject({ latestSenderKind: "human", latestSenderHandle: username, target: dmTarget });

    // First drain returns every unread row; root sorts before its reply within the same
    // conversation regardless of how the DM and channel conversation ids happen to compare.
    const first = await repo.drainAgentEvents(workspace.id, agent.id, 50);
    expect(first.hasMore).toBe(false);
    expect(first.messages).toHaveLength(3);
    const bodies: string[] = first.messages.map((m) => m.body);
    expect(bodies.indexOf("dm root")).toBeLessThan(bodies.indexOf("dm thread reply"));
    expect(first.messages.map((m) => [m.body, m.target])).toEqual(
      expect.arrayContaining([
        ["dm root", dmTarget],
        ["dm thread reply", threadTarget],
        ["channel message", channelTarget],
      ]),
    );

    // Boundaries advanced for every drained target.
    const dmMember = await db.conversationMember.findUniqueOrThrow({
      where: {
        conversationId_agentId: { conversationId: opened.conversationId, agentId: agent.id },
      },
    });
    expect(dmMember.agentReadThroughSequence).toBe(root.sequence);
    const threadRead = await db.threadRead.findUnique({
      where: { memberId_rootMessageId: { memberId: dmMember.id, rootMessageId: root.id } },
    });
    expect(threadRead?.readThroughSequence).toBe(reply.sequence);
    const channelMember = await db.conversationMember.findUniqueOrThrow({
      where: { conversationId_agentId: { conversationId: general.id, agentId: agent.id } },
    });
    expect(channelMember.agentReadThroughSequence).toBe(channelMessage.sequence);

    // A second drain of the same data is empty.
    const second = await repo.drainAgentEvents(workspace.id, agent.id, 50);
    expect(second).toEqual({ messages: [], hasMore: false });
    expect((await repo.readAgentRecoveryContext(workspace.id, agent.id)).unreadSummary).toEqual({});

    // A fresh batch of three more unread messages, drained one at a time.
    const dmRoot2 = await repo.sendMessage(
      opened.conversationId,
      opened.senderMemberId,
      user.id,
      "dm root 2",
    );
    const dmReply2 = await repo.sendMessage(
      opened.conversationId,
      opened.senderMemberId,
      user.id,
      "dm reply 2",
      undefined,
      dmRoot2.id,
    );
    const channelMessage2 = await channels.send({
      workspaceId: workspace.id,
      userId: user.id,
      channelId: general.id,
      requestId: crypto.randomUUID(),
      body: "channel message 2",
    });
    const dmTarget2 = dmTarget;
    const threadTarget2 = `@${username}:${dmRoot2.id}`;
    const channelTarget2 = channelTarget;
    const allTargets = [dmTarget2, threadTarget2, channelTarget2];

    const partial = await repo.drainAgentEvents(workspace.id, agent.id, 1);
    expect(partial.hasMore).toBe(true);
    expect(partial.messages).toHaveLength(1);
    const drainedTarget = partial.messages[0]!.target;
    const afterPartial = await repo.readAgentRecoveryContext(workspace.id, agent.id);
    expect(Object.keys(afterPartial.unreadSummary).sort()).toEqual(
      allTargets.filter((target) => target !== drainedTarget).sort(),
    );

    const remainder = await repo.drainAgentEvents(workspace.id, agent.id, 50);
    expect(remainder.hasMore).toBe(false);
    expect(remainder.messages).toHaveLength(2);
    expect((await repo.readAgentRecoveryContext(workspace.id, agent.id)).unreadSummary).toEqual({});

    const finalDrain = await repo.drainAgentEvents(workspace.id, agent.id, 50);
    expect(finalDrain).toEqual({ messages: [], hasMore: false });
    void dmReply2;
    void channelMessage2;
  } finally {
    await db.agentMessageDelivery.deleteMany({ where: { workspaceId: workspace.id } });
    await db.message.deleteMany({ where: { workspaceId: workspace.id } });
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.delete({ where: { id: user.id } });
    await db.$disconnect();
  }
});

test("events drain and recovery keep the unread rule across channels, direct messages, and their threads", async () => {
  const connectionString = Bun.env.EVENTS_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("EVENTS_TEST_DATABASE_URL is required (local PostgreSQL)");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const id = crypto.randomUUID();
  const username = `e${id.slice(0, 8)}`;
  const user = await db.user.create({ data: { username } });
  const workspace = await db.workspace.create({
    data: { slug: id, name: "Events rule test", members: { create: { userId: user.id } } },
  });
  try {
    const agent = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: user.id,
        name: "helper",
        displayName: "Helper",
        runtimeConfig: {},
      },
    });
    const repo = new PrismaDirectConversationRepository(db);
    const channels = new PublicChannels(db, { execute: async (_scope, persist) => persist() });
    const opened = await repo.openForUser(workspace.id, user.id, agent.id);
    const general = await enrollGeneralChannel(db, workspace.id);
    const [dmAgentMember, channelAgentMember] = await Promise.all(
      [opened.conversationId, general.id].map((conversationId) =>
        db.conversationMember.findUniqueOrThrow({
          where: { conversationId_agentId: { conversationId, agentId: agent.id } },
        }),
      ),
    );
    // An Agent joins #general muted; unmuted, ordinary chatter reaches it with a delivery row.
    await db.conversationMember.update({
      where: { id: channelAgentMember.id },
      data: { channelMuted: false },
    });
    // Rows the product has no public path for (an Agent's own or a system message) are written
    // directly with the next sequence.
    async function insert(
      conversationId: string,
      senderMemberId: string | null,
      body: string,
      threadRootId?: string,
    ) {
      const { _max } = await db.message.aggregate({
        where: { conversationId },
        _max: { sequence: true },
      });
      return db.message.create({
        data: {
          conversationId,
          workspaceId: workspace.id,
          senderMemberId,
          body,
          threadRootId: threadRootId ?? null,
          sequence: (_max.sequence ?? 0) + 1,
        },
      });
    }
    async function channelPost(body: string, threadRootId?: string) {
      return channels.send({
        workspaceId: workspace.id,
        userId: user.id,
        channelId: general.id,
        requestId: crypto.randomUUID(),
        body,
        ...(threadRootId ? { threadRootId } : {}),
      });
    }
    async function deliver(message: { id: string; sequence: number }) {
      await db.agentMessageDelivery.create({
        data: {
          deliveryId: crypto.randomUUID(),
          messageId: message.id,
          workspaceId: workspace.id,
          conversationId: general.id,
          agentId: agent.id,
          sequence: message.sequence,
        },
      });
    }
    async function undeliver(messageId: string) {
      await db.agentMessageDelivery.deleteMany({ where: { messageId, agentId: agent.id } });
    }

    // Already read by the Agent: a direct message below its top-level boundary.
    const seen = await repo.sendMessage(
      opened.conversationId,
      opened.senderMemberId,
      user.id,
      "seen",
    );
    await db.conversationMember.update({
      where: { id: dmAgentMember.id },
      data: { agentReadThroughSequence: seen.sequence },
    });
    // Direct messages: the user's root and thread reply count; the Agent's own and a system
    // notice do not, in the conversation or in the thread.
    const dmRoot = await repo.sendMessage(
      opened.conversationId,
      opened.senderMemberId,
      user.id,
      "dm root",
    );
    await insert(opened.conversationId, dmAgentMember.id, "agent says");
    await insert(opened.conversationId, null, "system notice");
    await insert(opened.conversationId, dmAgentMember.id, "agent replies", dmRoot.id);
    await repo.sendMessage(
      opened.conversationId,
      opened.senderMemberId,
      user.id,
      "dm reply",
      undefined,
      dmRoot.id,
    );
    // A thread whose earlier replies the Agent read keeps only the newer one.
    const readRoot = await repo.sendMessage(
      opened.conversationId,
      opened.senderMemberId,
      user.id,
      "read root",
    );
    const readReply = await repo.sendMessage(
      opened.conversationId,
      opened.senderMemberId,
      user.id,
      "read reply",
      undefined,
      readRoot.id,
    );
    await db.threadRead.create({
      data: {
        memberId: dmAgentMember.id,
        conversationId: opened.conversationId,
        workspaceId: workspace.id,
        rootMessageId: readRoot.id,
        readThroughSequence: readReply.sequence,
      },
    });
    await repo.sendMessage(
      opened.conversationId,
      opened.senderMemberId,
      user.id,
      "newer reply",
      undefined,
      readRoot.id,
    );

    // Channels count only what was delivered to the Agent, in the channel and in its threads.
    const channelRoot = await channelPost("delivered root");
    const quiet = await channelPost("undelivered root");
    await undeliver(quiet.id);
    await undeliver((await channelPost("undelivered reply", channelRoot.id)).id);
    // A thread reply reaches the Agent only through a delivery row of its own.
    await deliver(await channelPost("delivered reply", channelRoot.id));
    // A delivered channel message at or below the Agent's boundary stays read.
    const old = await channelPost("delivered but read");
    await undeliver((await channelPost("undelivered after read")).id);
    await db.conversationMember.update({
      where: { id: channelAgentMember.id },
      data: { agentReadThroughSequence: old.sequence },
    });
    const late = await channelPost("delivered late");

    const expected = [
      ["dm root", `@${username}`],
      ["dm reply", `@${username}:${dmRoot.id}`],
      ["read root", `@${username}`],
      ["newer reply", `@${username}:${readRoot.id}`],
      ["delivered reply", `#general:${channelRoot.id}`],
      ["delivered late", "#general"],
    ];
    const recovery = await repo.readAgentRecoveryContext(workspace.id, agent.id);
    expect(recovery.unreadSummary).toEqual({
      [`@${username}`]: 2,
      [`@${username}:${dmRoot.id}`]: 1,
      [`@${username}:${readRoot.id}`]: 1,
      [`#general:${channelRoot.id}`]: 1,
      "#general": 1,
    });
    const drained = await repo.drainAgentEvents(workspace.id, agent.id, 50);
    expect(drained.hasMore).toBe(false);
    expect(drained.messages.map((message) => [message.body, message.target])).toEqual(
      expect.arrayContaining(expected),
    );
    expect(drained.messages).toHaveLength(expected.length);
    expect(await repo.drainAgentEvents(workspace.id, agent.id, 50)).toEqual({
      messages: [],
      hasMore: false,
    });
    void late;
  } finally {
    await db.agentMessageDelivery.deleteMany({ where: { workspaceId: workspace.id } });
    await db.message.deleteMany({ where: { workspaceId: workspace.id } });
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.delete({ where: { id: user.id } });
    await db.$disconnect();
  }
});

test("events drain returns only an Agent's channel deliveries above its read boundaries, however long its history", async () => {
  const connectionString = Bun.env.EVENTS_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("EVENTS_TEST_DATABASE_URL is required (local PostgreSQL)");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const id = crypto.randomUUID();
  const user = await db.user.create({ data: { username: `e${id.slice(0, 8)}` } });
  const workspace = await db.workspace.create({
    data: { slug: id, name: "Events history test", members: { create: { userId: user.id } } },
  });
  try {
    const agent = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: user.id,
        name: "helper",
        displayName: "Helper",
        runtimeConfig: {},
      },
    });
    const repo = new PrismaDirectConversationRepository(db);
    const general = await enrollGeneralChannel(db, workspace.id);
    const [userMember, agentMember] = await Promise.all([
      db.conversationMember.findUniqueOrThrow({
        where: { conversationId_userId: { conversationId: general.id, userId: user.id } },
      }),
      db.conversationMember.findUniqueOrThrow({
        where: { conversationId_agentId: { conversationId: general.id, agentId: agent.id } },
      }),
    ]);
    let sequence = 0;
    // A delivered #general message from the user, written directly: the history is too long to
    // send one message at a time.
    async function delivered(body: string, threadRootId?: string) {
      return db.message.create({
        data: {
          conversationId: general.id,
          workspaceId: workspace.id,
          senderMemberId: userMember.id,
          body,
          threadRootId: threadRootId ?? null,
          sequence: ++sequence,
          deliveries: {
            create: {
              workspaceId: workspace.id,
              conversationId: general.id,
              agentId: agent.id,
              sequence,
            },
          },
        },
      });
    }
    // A long delivered history the Agent has already read.
    const history = Array.from({ length: 300 }, (_, index) => ({
      id: crypto.randomUUID(),
      conversationId: general.id,
      workspaceId: workspace.id,
      senderMemberId: userMember.id,
      body: `history ${index}`,
      sequence: ++sequence,
    }));
    await db.message.createMany({ data: history });
    await db.agentMessageDelivery.createMany({
      data: history.map((message) => ({
        messageId: message.id,
        workspaceId: workspace.id,
        conversationId: general.id,
        agentId: agent.id,
        sequence: message.sequence,
      })),
    });
    const readRoot = await delivered("read root");
    const readReply = await delivered("read reply", readRoot.id);
    await db.threadRead.create({
      data: {
        memberId: agentMember.id,
        conversationId: general.id,
        workspaceId: workspace.id,
        rootMessageId: readRoot.id,
        readThroughSequence: readReply.sequence,
      },
    });
    // A thread the Agent never read: its reply sits below the top-level boundary set next, and
    // still counts, because a thread keeps its own boundary.
    const openRoot = await delivered("open root");
    await delivered("open reply", openRoot.id);
    const boundary = sequence;
    await db.conversationMember.update({
      where: { id: agentMember.id },
      data: { agentReadThroughSequence: boundary },
    });
    await delivered("newer reply", readRoot.id);
    await delivered("newer top level");

    const drained = await repo.drainAgentEvents(workspace.id, agent.id, 50);
    expect(drained.hasMore).toBe(false);
    expect(drained.messages.map((message) => [message.body, message.target])).toEqual(
      expect.arrayContaining([
        ["open reply", `#general:${openRoot.id}`],
        ["newer reply", `#general:${readRoot.id}`],
        ["newer top level", "#general"],
      ]),
    );
    expect(drained.messages).toHaveLength(3);
    expect(await repo.drainAgentEvents(workspace.id, agent.id, 50)).toEqual({
      messages: [],
      hasMore: false,
    });
  } finally {
    await db.agentMessageDelivery.deleteMany({ where: { workspaceId: workspace.id } });
    await db.message.deleteMany({ where: { workspaceId: workspace.id } });
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.delete({ where: { id: user.id } });
    await db.$disconnect();
  }
});

test("an Agent's channel send freshness reads count only its delivered messages above the boundary", async () => {
  const connectionString = Bun.env.EVENTS_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("EVENTS_TEST_DATABASE_URL is required (local PostgreSQL)");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const id = crypto.randomUUID();
  const user = await db.user.create({ data: { username: `f${id.slice(0, 8)}` } });
  const workspace = await db.workspace.create({
    data: { slug: id, name: "Freshness test", members: { create: { userId: user.id } } },
  });
  try {
    const agent = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: user.id,
        name: "helper",
        displayName: "Helper",
        runtimeConfig: {},
      },
    });
    const repo = new PrismaDirectConversationRepository(db);
    const channels = new PublicChannels(db, { execute: async (_scope, persist) => persist() });
    const general = await enrollGeneralChannel(db, workspace.id);
    const agentMember = await db.conversationMember.findUniqueOrThrow({
      where: { conversationId_agentId: { conversationId: general.id, agentId: agent.id } },
    });
    async function post(body: string, delivered: boolean, threadRootId?: string) {
      const message = await channels.send({
        workspaceId: workspace.id,
        userId: user.id,
        channelId: general.id,
        requestId: crypto.randomUUID(),
        body,
        ...(threadRootId ? { threadRootId } : {}),
      });
      await db.agentMessageDelivery.deleteMany({ where: { messageId: message.id } });
      if (delivered) await deliver(message);
      return message;
    }
    async function deliver(message: { id: string; sequence: number }) {
      await db.agentMessageDelivery.create({
        data: {
          messageId: message.id,
          workspaceId: workspace.id,
          conversationId: general.id,
          agentId: agent.id,
          sequence: message.sequence,
        },
      });
    }
    // The Agent's own post has no public path here; it is written with the next sequence. It
    // carries a delivery row so the reads show that the Agent's own message never counts.
    async function ownPost(body: string) {
      const { _max } = await db.message.aggregate({
        where: { conversationId: general.id },
        _max: { sequence: true },
      });
      const message = await db.message.create({
        data: {
          conversationId: general.id,
          workspaceId: workspace.id,
          senderMemberId: agentMember.id,
          body,
          sequence: (_max.sequence ?? 0) + 1,
        },
      });
      await deliver(message);
      return message;
    }
    const bodies = (rows: readonly { body: string }[]) => rows.map((row) => row.body);

    await post("delivered before own post", true);
    await ownPost("own post");
    await post("undelivered", false);
    const root = await post("delivered root", true);
    await post("delivered reply", true, root.id);
    await post("undelivered reply", false, root.id);
    const first = await post("delivered 1", true);
    await post("delivered 2", true);
    await post("undelivered late", false);
    await post("delivered 3", true);

    // With no reported boundary, the Agent's own last post in the target is the boundary.
    expect(bodies(await repo.readPendingAgentContext(workspace.id, agent.id, "#general"))).toEqual([
      "delivered 1",
      "delivered 2",
      "delivered 3",
    ]);
    expect(await repo.countPendingAgentContext(workspace.id, agent.id, "#general")).toBe(4);
    // A reported boundary replaces it.
    expect(
      bodies(
        await repo.readPendingAgentContext(workspace.id, agent.id, "#general", first.sequence),
      ),
    ).toEqual(["delivered 2", "delivered 3"]);
    // The boundary-driven reads still count the Agent's own delivered post.
    expect(await repo.countPendingAgentContext(workspace.id, agent.id, "#general", 0)).toBe(6);
    // A thread target reads its own delivered replies.
    const thread = `#general:${root.id}`;
    expect(bodies(await repo.readPendingAgentContext(workspace.id, agent.id, thread))).toEqual([
      "delivered reply",
    ]);
    expect(await repo.countPendingAgentContext(workspace.id, agent.id, thread)).toBe(1);
    // First-touch context ignores every boundary but still skips the Agent's own and undelivered
    // messages.
    expect(
      bodies(await repo.readRecentAgentContext(workspace.id, agent.id, "#general", 10)),
    ).toEqual([
      "delivered before own post",
      "delivered root",
      "delivered 1",
      "delivered 2",
      "delivered 3",
    ]);
    expect(
      bodies(await repo.readRecentAgentContext(workspace.id, agent.id, "#general", 2)),
    ).toEqual(["delivered 2", "delivered 3"]);
  } finally {
    await db.agentMessageDelivery.deleteMany({ where: { workspaceId: workspace.id } });
    await db.message.deleteMany({ where: { workspaceId: workspace.id } });
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.delete({ where: { id: user.id } });
    await db.$disconnect();
  }
});
