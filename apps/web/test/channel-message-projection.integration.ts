import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { RedisClient } from "bun";
import { PrismaClient } from "#src/generated/prisma/client";
import { PublicChannels } from "#src/server/conversations/public-channels.server";
import { RedisMessageRequestIdempotency } from "#src/server/conversations/redis-message-request-idempotency.server";

// Pins the browser-facing shape of a channel message as `PublicChannels.open`, `updates` and
// `send` return it: every field, for a person, a since-deleted Agent, a thread reply and a
// server-authored message, with avatars, attachments in send order, reactions and mentions.
test("a channel message reaches the browser in one shape from open, updates and send", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const redis = new RedisClient(Bun.env.CHANNEL_TEST_REDIS_URL!);
  const suffix = crypto.randomUUID().slice(0, 8);
  const alice = await db.user.create({
    data: {
      username: `pa${suffix}`,
      displayName: "Alice Liddell",
      avatarObjectKey: `avatars/alice/v7/avatar.png`,
    },
  });
  const bob = await db.user.create({ data: { username: `pb${suffix}` } });
  const workspace = await db.workspace.create({
    data: {
      slug: `projection-${suffix}`,
      name: "Projection",
      members: { create: [{ userId: alice.id }, { userId: bob.id }] },
    },
  });
  try {
    const agent = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: alice.id,
        name: "scribe",
        displayName: "Scribe",
        avatarObjectKey: `avatars/scribe/v3/avatar.png`,
        runtimeConfig: {},
      },
    });
    const channels = new PublicChannels(
      db,
      new RedisMessageRequestIdempotency(redis),
      { publish: async () => {}, publishJson: async () => {} } as never,
      undefined,
      { async memberChanged() {}, async messageAvailable() {} },
    );
    const channel = await channels.create(workspace.id, alice.id, "projection");
    await channels.join(workspace.id, bob.id, channel.id);
    const agentMember = await db.conversationMember.create({
      data: { conversationId: channel.id, workspaceId: workspace.id, agentId: agent.id },
    });
    const bobMember = await db.conversationMember.findFirstOrThrow({
      where: { conversationId: channel.id, userId: bob.id },
    });

    const sent = await channels.send({
      workspaceId: workspace.id,
      userId: alice.id,
      channelId: channel.id,
      requestId: crypto.randomUUID(),
      body: `hello @${bob.username}`,
    });
    const agentMessage = await db.message.create({
      data: {
        conversationId: channel.id,
        workspaceId: workspace.id,
        senderMemberId: agentMember.id,
        body: "top-level from the Agent",
        sequence: 2,
      },
    });
    const reply = await db.message.create({
      data: {
        conversationId: channel.id,
        workspaceId: workspace.id,
        senderMemberId: agentMember.id,
        threadRootId: sent.id,
        body: "a thread reply",
        sequence: 3,
      },
    });
    const system = await db.message.create({
      data: {
        conversationId: channel.id,
        workspaceId: workspace.id,
        senderMemberId: null,
        body: "Task #1 was created",
        sequence: 4,
      },
    });
    // Created out of position order: the projection lists them by `position`.
    const second = await db.attachment.create({
      data: {
        workspaceId: workspace.id,
        conversationId: channel.id,
        uploaderId: alice.id,
        messageId: sent.id,
        position: 1,
        objectKey: `attachments/${suffix}/b.txt`,
        fileName: "b.txt",
        contentType: "text/plain",
        sizeBytes: 2,
      },
    });
    const first = await db.attachment.create({
      data: {
        workspaceId: workspace.id,
        conversationId: channel.id,
        uploaderId: alice.id,
        messageId: sent.id,
        position: 0,
        objectKey: `attachments/${suffix}/a.txt`,
        fileName: "a.txt",
        contentType: "text/plain",
        sizeBytes: 1,
      },
    });
    await db.messageReaction.create({
      data: {
        messageId: agentMessage.id,
        conversationId: channel.id,
        workspaceId: workspace.id,
        memberId: bobMember.id,
        emoji: "👍",
      },
    });
    await db.agent.update({ where: { id: agent.id }, data: { deletedAt: new Date() } });

    const aliceMemberId = sent.senderMemberId;
    const expected: Awaited<ReturnType<PublicChannels["open"]>>["messages"] = [
      {
        id: sent.id,
        sequence: 1,
        threadRootId: undefined,
        senderMemberId: aliceMemberId,
        senderKind: "user",
        senderName: "Alice Liddell",
        senderHandle: alice.username,
        senderAgentId: undefined,
        senderDeleted: false,
        senderAvatarUrl: `/api/workspaces/${workspace.id}/users/${alice.id}/avatar?v=v7`,
        body: `hello <@human:${bob.id}>`,
        createdAt: sent.createdAt,
        mentions: [{ kind: "user", actorId: bob.id, handle: bob.username, label: bob.username }],
        attachments: [
          { id: first.id, fileName: "a.txt", contentType: "text/plain", sizeBytes: 1 },
          { id: second.id, fileName: "b.txt", contentType: "text/plain", sizeBytes: 2 },
        ],
        reactions: undefined,
        actionCard: undefined,
      },
      {
        id: agentMessage.id,
        sequence: 2,
        threadRootId: undefined,
        senderMemberId: agentMember.id,
        senderKind: "agent",
        senderName: "Scribe",
        senderHandle: "scribe",
        senderAgentId: agent.id,
        senderDeleted: true,
        senderAvatarUrl: `/api/workspaces/${workspace.id}/agents/${agent.id}/avatar?v=v3`,
        body: "top-level from the Agent",
        createdAt: agentMessage.createdAt,
        mentions: [],
        attachments: [],
        reactions: [{ emoji: "👍", count: 1, reactors: [`@${bob.username}`] }],
        actionCard: undefined,
      },
      {
        id: reply.id,
        sequence: 3,
        threadRootId: sent.id,
        senderMemberId: agentMember.id,
        senderKind: "agent",
        senderName: "Scribe",
        senderHandle: "scribe",
        senderAgentId: agent.id,
        senderDeleted: true,
        senderAvatarUrl: `/api/workspaces/${workspace.id}/agents/${agent.id}/avatar?v=v3`,
        body: "a thread reply",
        createdAt: reply.createdAt,
        mentions: [],
        attachments: [],
        reactions: undefined,
        actionCard: undefined,
      },
      {
        id: system.id,
        sequence: 4,
        threadRootId: undefined,
        senderMemberId: null,
        senderKind: "system",
        senderName: "System",
        senderHandle: undefined,
        senderAgentId: undefined,
        senderDeleted: false,
        senderAvatarUrl: null,
        body: "Task #1 was created",
        createdAt: system.createdAt,
        mentions: [],
        attachments: [],
        reactions: undefined,
        actionCard: undefined,
      },
    ];

    const opened = await channels.open(workspace.id, bob.id, channel.id);
    expect(opened.messages).toStrictEqual(expected);
    // Field order is part of what the browser receives.
    expect(opened.messages.map((message) => Object.keys(message))).toEqual(
      expected.map((message) => Object.keys(message)),
    );
    expect(await channels.updates(workspace.id, bob.id, channel.id, 0)).toStrictEqual(expected);

    // `send` returns the stored row, not the browser view: its sender is the wider Agent-delivery
    // projection, and the rest are the same columns the view is built from.
    expect(sent).toStrictEqual({
      id: sent.id,
      sequence: 1,
      threadRootId: null,
      senderMemberId: aliceMemberId,
      body: `hello <@human:${bob.id}>`,
      createdAt: sent.createdAt,
      sender: {
        agentId: null,
        agent: null,
        user: {
          id: alice.id,
          username: alice.username,
          displayName: "Alice Liddell",
          avatarObjectKey: `avatars/alice/v7/avatar.png`,
          description: "",
        },
      },
      attachments: [],
      mentions: [
        {
          kind: "user",
          actorId: bob.id,
          handle: bob.username,
          member: { user: { displayName: null }, agent: null },
        },
      ],
      reactions: [],
      // The Agent is a channel member, so the send delivered to it.
      deliveries: [
        { deliveryId: expect.any(String), agentId: agent.id, agent: { computerId: null } },
      ],
      unresolvedMentionHandles: [],
      pendingMentionActions: [],
    });
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.deleteMany({ where: { id: { in: [alice.id, bob.id] } } });
    await db.$disconnect();
    redis.close();
  }
});
