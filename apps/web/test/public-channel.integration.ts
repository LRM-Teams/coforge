import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/client";
import { PublicChannels } from "../src/server/conversations/public-channels.server";
import { RedisClient } from "bun";
import { RedisMessageRequestIdempotency } from "../src/server/conversations/redis-message-request-idempotency.server";
import { PrismaWorkspaceCatalogStore } from "../src/server/workspaces/catalog.server";
import { PrismaWorkspaceEnrollmentStore } from "../src/server/workspaces/enrollment.server";
import { readAuthorizedAttachment } from "../src/server/attachments/attachment.server";
import { PrismaDirectConversationRepository } from "../src/server/db/repositories/direct-conversation.repositories.server";
import { decodeAgentMessageDelivery } from "@coforge/protocol";
import { createAgentMessageMethod } from "../src/server/centrifugo/rpc-handler.server";
import { decodeCloudAgentMessageResponse, encodeAgentMessageRequest } from "@coforge/protocol";
import { RedisAgentMessageHoldStore } from "../src/server/conversations/agent-message-hold.server";
import { PrismaAgentRepository } from "../src/server/db/repositories/agent.repositories.server";
import { PrismaWebPushSubscriptionStore } from "../src/server/notifications/prisma-web-push-subscriptions.server";
import { ConversationHistory } from "../src/server/conversations/conversation-history.server";

test("existing Workspace humans automatically join one general channel; outsiders cannot discover it", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString)
    throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const redis = new RedisClient(Bun.env.CHANNEL_TEST_REDIS_URL!);
  const suffix = crypto.randomUUID();
  const alice = await db.user.create({ data: { username: `alice-${suffix}` } });
  const bob = await db.user.create({ data: { username: `bob-${suffix}` } });
  const outsider = await db.user.create({
    data: { username: `other-${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: suffix,
      name: "Channels",
      members: { create: [{ userId: alice.id }, { userId: bob.id }] },
    },
  });
  try {
    await db.user.updateMany({
      where: { id: { in: [alice.id, bob.id] } },
      data: { browserNotificationsEnabled: true },
    });
    await db.webPushSubscription.createMany({
      data: [
        {
          userId: alice.id,
          endpoint: `https://fcm.googleapis.com/wp/alice-${suffix}`,
          p256dh: "a",
          auth: "a",
        },
        {
          userId: bob.id,
          endpoint: `https://fcm.googleapis.com/wp/bob-${suffix}`,
          p256dh: "b",
          auth: "b",
        },
      ],
    });
    const pushSubscriptions = new PrismaWebPushSubscriptionStore(db);
    const realtimeEvents: Array<{
      conversationId: string;
      messageId: string;
      sequence: number;
    }> = [];
    const channels = new PublicChannels(
      db,
      new RedisMessageRequestIdempotency(redis),
      undefined,
      undefined,
      {
        async messageAvailable(event) {
          realtimeEvents.push(event);
        },
      },
    );
    const [first, second] = await Promise.all([
      channels.list(workspace.id, alice.id),
      channels.list(workspace.id, bob.id),
    ]);
    expect(first).toEqual([{ id: expect.any(String), name: "general", joined: true }]);
    expect(second).toEqual(first);
    expect(await channels.list(workspace.id, alice.id)).toEqual(first);
    await expect(channels.list(workspace.id, outsider.id)).rejects.toThrow("ACCESS_DENIED");
    const engineering = await channels.create(workspace.id, alice.id, "engineering");
    expect(
      (await channels.list(workspace.id, bob.id)).find((c) => c.name === "engineering")?.joined,
    ).toBe(false);
    expect((await channels.open(workspace.id, bob.id, engineering.id)).senderMemberId).toBe("");
    await expect(channels.open(workspace.id, outsider.id, engineering.id)).rejects.toThrow(
      "ACCESS_DENIED",
    );
    await expect(channels.create(workspace.id, outsider.id, "secret")).rejects.toThrow(
      "ACCESS_DENIED",
    );
    await expect(channels.join(workspace.id, outsider.id, engineering.id)).rejects.toThrow(
      "ACCESS_DENIED",
    );
    await expect(channels.create(workspace.id, alice.id, "engineering")).rejects.toThrow(
      "CONFLICT",
    );
    await expect(channels.create(workspace.id, alice.id, "bad:name")).rejects.toThrow();
    const send = (userId: string, body: string, requestId = crypto.randomUUID()) =>
      channels.send({
        workspaceId: workspace.id,
        userId,
        channelId: engineering.id,
        body,
        requestId,
      });
    await expect(send(bob.id, "not joined")).rejects.toThrow("ACCESS_DENIED");
    await expect(send(outsider.id, "not in workspace")).rejects.toThrow("ACCESS_DENIED");
    const requestId = crypto.randomUUID();
    const attachment = await db.attachment.create({
      data: {
        workspaceId: workspace.id,
        conversationId: engineering.id,
        uploaderId: alice.id,
        objectKey: `test/${suffix}`,
        fileName: "notes.txt",
        contentType: "text/plain",
        sizeBytes: 5,
      },
    });
    await expect(
      readAuthorizedAttachment(db, {
        attachmentId: attachment.id,
        userId: bob.id,
      }),
    ).rejects.toThrow("NOT_FOUND");
    const saved = await channels.send({
      workspaceId: workspace.id,
      userId: alice.id,
      channelId: engineering.id,
      requestId,
      body: "Hello Bob",
      attachmentId: attachment.id,
    });
    expect((await pushSubscriptions.notificationForMessage(saved.id))?.subscriptions).toEqual([]);
    expect(realtimeEvents).toContainEqual({
      conversationId: engineering.id,
      messageId: saved.id,
      sequence: saved.sequence,
    });
    expect((await send(alice.id, "Hello Bob", requestId)).id).toBe(saved.id);
    const unjoined = await channels.open(workspace.id, bob.id, engineering.id);
    expect(unjoined.messages.map((m) => m.body)).toEqual(["Hello Bob"]);
    expect(
      (
        await readAuthorizedAttachment(db, {
          attachmentId: attachment.id,
          userId: bob.id,
        })
      ).attachment.id,
    ).toBe(attachment.id);
    await expect(
      readAuthorizedAttachment(db, {
        attachmentId: attachment.id,
        userId: outsider.id,
      }),
    ).rejects.toThrow("ACCESS_DENIED");
    await Promise.all([
      channels.join(workspace.id, bob.id, engineering.id),
      channels.join(workspace.id, bob.id, engineering.id),
    ]);
    expect(await channels.setUserMuted(workspace.id, bob.id, engineering.id, true)).toEqual({
      muted: true,
    });
    const mutedChannel = await channels.open(workspace.id, bob.id, engineering.id);
    expect(mutedChannel.senderMemberId).not.toBe("");
    expect(mutedChannel.muted).toBeTrue();
    expect((await pushSubscriptions.notificationForMessage(saved.id))?.subscriptions).toEqual([]);
    const mutedOrdinary = await send(alice.id, "Muted ordinary message");
    expect(
      (await pushSubscriptions.notificationForMessage(mutedOrdinary.id))?.subscriptions,
    ).toEqual([]);
    const mutedMention = await send(alice.id, `@${bob.username} please review this`);
    const mentionNotification = await pushSubscriptions.notificationForMessage(mutedMention.id);
    expect(mentionNotification?.subscriptions).toEqual([
      expect.objectContaining({
        endpoint: `https://fcm.googleapis.com/wp/bob-${suffix}`,
      }),
    ]);
    expect(mentionNotification?.url).toBe(
      `/notifications/open?workspace=${workspace.slug}&target=${encodeURIComponent(`/messages/channels/${engineering.id}#message-${mutedMention.id}`)}`,
    );
    await channels.setUserMuted(workspace.id, bob.id, engineering.id, false);
    expect((await pushSubscriptions.notificationForMessage(saved.id))?.subscriptions).toEqual([
      expect.objectContaining({
        endpoint: `https://fcm.googleapis.com/wp/bob-${suffix}`,
      }),
    ]);
    await send(bob.id, "Hello Alice");
    const history = await channels.open(workspace.id, alice.id, engineering.id);
    expect(history.messages.map((m) => [m.sequence, m.senderName, m.body])).toEqual([
      [1, `@${alice.username}`, "Hello Bob"],
      [2, `@${alice.username}`, "Muted ordinary message"],
      [3, `@${alice.username}`, `@${bob.username} please review this`],
      [4, `@${bob.username}`, "Hello Alice"],
    ]);
    expect(history.messages[0]?.senderMemberId).toBe(history.senderMemberId);
    expect(history.messages[3]?.senderMemberId).not.toBe(history.senderMemberId);
    await Promise.all([send(alice.id, "Concurrent A"), send(bob.id, "Concurrent B")]);
    const concurrentHistory = await channels.open(workspace.id, alice.id, engineering.id);
    expect(concurrentHistory.messages.map((m) => m.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
    const concurrentBobMessage = concurrentHistory.messages.find(
      (message) => message.body === "Concurrent B",
    );
    expect(concurrentBobMessage?.senderMemberId).not.toBe(concurrentHistory.senderMemberId);
    const browserHistory = new ConversationHistory(db);
    expect(
      (await browserHistory.listOwnMessages(workspace.id, alice.id, engineering.id)).messages.map(
        (message) => message.body,
      ),
    ).toEqual([
      "Hello Bob",
      "Muted ordinary message",
      `@${bob.username} please review this`,
      "Concurrent A",
    ]);
    await expect(
      browserHistory.loadAround(workspace.id, bob.id, engineering.id, saved.id),
    ).rejects.toThrow("NOT_FOUND");
    await expect(
      browserHistory.listOwnMessages(workspace.id, outsider.id, engineering.id),
    ).rejects.toThrow("ACCESS_DENIED");
    const latestPage = await channels.open(workspace.id, alice.id, engineering.id, { limit: 2 });
    expect(latestPage.hasOlder).toBe(true);
    expect(latestPage.messages.map((message) => message.sequence)).toEqual([5, 6]);
    const olderPage = await channels.open(workspace.id, alice.id, engineering.id, {
      beforeSequence: 5,
      limit: 2,
    });
    expect(olderPage.hasOlder).toBe(true);
    expect(olderPage.messages.map((message) => message.sequence)).toEqual([3, 4]);
    expect(
      (await channels.updates(workspace.id, alice.id, engineering.id, 4)).map(
        (message) => message.sequence,
      ),
    ).toEqual([5, 6]);
    const direct = await db.conversation.create({
      data: { workspaceId: workspace.id, directKey: `private-${suffix}` },
    });
    await expect(channels.open(workspace.id, bob.id, direct.id)).rejects.toThrow("NOT_FOUND");
    await expect(channels.join(workspace.id, bob.id, direct.id)).rejects.toThrow("NOT_FOUND");
    await db.workspaceMembership.delete({
      where: {
        workspaceId_userId: { workspaceId: workspace.id, userId: bob.id },
      },
    });
    await expect(channels.open(workspace.id, bob.id, engineering.id)).rejects.toThrow(
      "ACCESS_DENIED",
    );
    await expect(send(bob.id, "membership revoked")).rejects.toThrow("ACCESS_DENIED");
    await expect(
      readAuthorizedAttachment(db, {
        attachmentId: attachment.id,
        userId: bob.id,
      }),
    ).rejects.toThrow("ACCESS_DENIED");
    for (const store of [
      new PrismaWorkspaceCatalogStore(db),
      new PrismaWorkspaceEnrollmentStore(db),
    ]) {
      const created = await store.createForUser({
        slug: crypto.randomUUID(),
        name: "New workspace",
        userId: alice.id,
      });
      const id = typeof created === "string" ? created : created.id;
      try {
        // Check the creation transaction itself, before discovery can repair old enrollments.
        const general = await db.conversation.findFirst({
          where: { workspaceId: id, channelName: "general" },
          include: { members: true },
        });
        expect(general?.members.map((m) => m.userId)).toEqual([alice.id]);
      } finally {
        await db.workspace.delete({ where: { id } });
      }
    }
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.deleteMany({
      where: { id: { in: [alice.id, bob.id, outsider.id] } },
    });
    await db.$disconnect();
    redis.close();
  }
});

test("Agent channel mute suppresses ordinary notices, preserves mentions and read access, and never backfills", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const redis = new RedisClient(Bun.env.CHANNEL_TEST_REDIS_URL!);
  const user = await db.user.create({
    data: { username: `u${crypto.randomUUID().slice(0, 8)}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: crypto.randomUUID(),
      name: "Agent channels",
      members: { create: { userId: user.id } },
    },
  });
  try {
    const computer = await db.computer.create({
      data: { ownerId: user.id, machineId: crypto.randomUUID() },
    });
    const agent = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: user.id,
        computerId: computer.id,
        name: "helper",
        displayName: "Helper",
        runtimeConfig: {},
      },
    });
    const published: ReturnType<typeof decodeAgentMessageDelivery>[] = [];
    let rejectNextPublish = false;
    const channels = new PublicChannels(db, new RedisMessageRequestIdempotency(redis), {
      publish: async (_channel, payload) => {
        if (rejectNextPublish) {
          rejectNextPublish = false;
          throw new Error("controlled publish outage");
        }
        published.push(decodeAgentMessageDelivery(payload));
      },
      publishJson: async () => {},
    });
    const general = (await channels.list(workspace.id, user.id))[0]!;
    await db.user.update({
      where: { id: user.id },
      data: { browserNotificationsEnabled: true },
    });
    await db.webPushSubscription.create({
      data: {
        userId: user.id,
        endpoint: `https://fcm.googleapis.com/wp/agent-mention-${workspace.id}`,
        p256dh: "p256dh",
        auth: "auth",
      },
    });
    expect(await channels.setAgentMuted(workspace.id, agent.id, "#general", true)).toEqual({
      muted: true,
    });
    await channels.send({
      workspaceId: workspace.id,
      userId: user.id,
      channelId: general.id,
      requestId: crypto.randomUUID(),
      body: "Ordinary conversation, no Agent requested.",
    });
    const repo = new PrismaDirectConversationRepository(db);
    expect(published).toEqual([]);
    expect(await repo.readPendingAgentDeliveries(workspace.id, agent.id)).toEqual([]);
    expect(await repo.readAgentRecoveryContext(workspace.id, agent.id)).toEqual({
      resumeMessages: [],
      unreadSummary: {},
    });
    expect(
      (await repo.readMessages(workspace.id, agent.id, "#general")).map((m) => [
        m.sender,
        m.body,
        m.target,
      ]),
    ).toEqual([[`@${user.username}`, "Ordinary conversation, no Agent requested.", "#general"]]);
    const mentioned = await channels.send({
      workspaceId: workspace.id,
      userId: user.id,
      channelId: general.id,
      requestId: crypto.randomUUID(),
      body: "@helper please review this. @helper",
    });
    await channels.send({
      workspaceId: workspace.id,
      userId: user.id,
      channelId: general.id,
      requestId: crypto.randomUUID(),
      body: "Email x@helper.test and @helper-other are not a mention.",
    });
    const pending = await repo.readPendingAgentDeliveries(workspace.id, agent.id);
    expect(pending.map((m) => [m.messageId, m.target, m.latestSender])).toEqual([
      [mentioned.id, "#general", `@${user.username}`],
    ]);
    const recovery = await repo.readAgentRecoveryContext(workspace.id, agent.id);
    expect(recovery.resumeMessages.map((m) => m.messageId)).toEqual([mentioned.id]);
    expect(recovery.unreadSummary).toEqual({ "#general": 1 });
    expect(
      (
        await repo.readMessagesPage(workspace.id, agent.id, "#general", {
          fromSequence: 1,
          throughSequence: mentioned.sequence + 1,
        })
      ).messages.map((m) => m.id),
    ).toEqual([mentioned.id]);
    expect(published.map((m) => [m.agentId, m.target, m.messageId])).toEqual([
      [agent.id, "#general", mentioned.id],
    ]);
    await channels.setAgentMuted(workspace.id, agent.id, "#general", false);
    expect(published.length).toBe(1);
    const ordinary = await channels.send({
      workspaceId: workspace.id,
      userId: user.id,
      channelId: general.id,
      requestId: crypto.randomUUID(),
      body: "New ordinary conversation after unmute.",
    });
    expect(published.map((m) => m.messageId)).toEqual([mentioned.id, ordinary.id]);
    expect(
      await repo.searchMessages(workspace.id, agent.id, {
        query: "ordinary unmute",
      }),
    ).toEqual([
      expect.objectContaining({
        id: ordinary.id,
        target: "#general",
        body: "New ordinary conversation after unmute.",
      }),
    ]);
    expect(
      (await repo.readAgentRecoveryContext(workspace.id, agent.id)).resumeMessages.map(
        (m) => m.messageId,
      ),
    ).toEqual([mentioned.id, ordinary.id]);
    const auth = { canUseAgent: async () => true };
    const metadata = {
      principal: {
        userId: user.id,
        workspaceId: workspace.id,
        agentId: agent.id,
        computerId: computer.id,
      },
      requestId: crypto.randomUUID(),
    };
    const rpc = async (
      operation: "read" | "send" | "mute" | "unmute",
      target: string,
      body?: string,
    ) => {
      const method = createAgentMessageMethod(
        repo,
        {
          publish: async () => {
            throw new Error("Agent reply must not publish");
          },
        },
        operation,
        auth,
        new RedisMessageRequestIdempotency(redis),
        new RedisAgentMessageHoldStore(redis),
      );
      const result = await method(
        encodeAgentMessageRequest({
          protocolMajor: 1,
          requestId: crypto.randomUUID(),
          workspaceId: workspace.id,
          agentId: agent.id,
          operation,
          target,
          body,
          seenUpToSequence: operation === "send" ? ordinary.sequence : undefined,
        }),
        metadata,
      );
      if (!(result instanceof Uint8Array)) throw new Error(JSON.stringify(result));
      return decodeCloudAgentMessageResponse(result);
    };
    expect((await rpc("mute", "#general")).accepted).toBe(true);
    expect((await rpc("read", "#general")).messages.map((m) => m.body)).toContain(
      "New ordinary conversation after unmute.",
    );
    const beforeReply = published.length;
    await channels.setUserMuted(workspace.id, user.id, general.id, true);
    const reply = await rpc(
      "send",
      "#general",
      `@${user.username} this Agent reply should notify the mentioned human`,
    );
    expect(reply.accepted).toBe(true);
    expect(published.length).toBe(beforeReply);
    if (!reply.messageId) throw new Error("Agent reply did not return its message identity");
    expect(
      (await new PrismaWebPushSubscriptionStore(db).notificationForMessage(reply.messageId))
        ?.subscriptions,
    ).toEqual([
      expect.objectContaining({
        endpoint: `https://fcm.googleapis.com/wp/agent-mention-${workspace.id}`,
      }),
    ]);
    const opened = await channels.open(workspace.id, user.id, general.id);
    expect(opened.messages.at(-1)).toMatchObject({
      senderKind: "agent",
      senderName: "@helper",
      id: reply.messageId,
    });
    expect(
      (await repo.readPendingAgentDeliveries(workspace.id, agent.id)).some(
        (m) => m.messageId === reply.messageId,
      ),
    ).toBe(false);
    const second = await new PrismaAgentRepository(db).create({
      workspaceId: workspace.id,
      ownerId: user.id,
      computerId: computer.id,
      name: "scout",
      displayName: "Scout",
      runtimeConfig: {
        runtime: "codex",
        provider: { kind: "default" },
        model: "default",
        modelProvider: "openai",
        reasoning: "",
      },
    });
    expect(
      (await repo.readMessages(workspace.id, second.id, "#general")).some(
        (m) => m.id === reply.messageId,
      ),
    ).toBe(true);
    const start = published.length;
    await channels.send({
      workspaceId: workspace.id,
      userId: user.id,
      channelId: general.id,
      requestId: crypto.randomUUID(),
      body: "A default unmuted channel update",
    });
    expect(published.slice(start).map((m) => m.agentId)).toEqual([second.id]);

    const other = await channels.create(workspace.id, user.id, "not-joined");
    await expect(repo.readMessages(workspace.id, agent.id, "#not-joined")).rejects.toThrow(
      "ACCESS_DENIED",
    );
    await expect(
      channels.setAgentMuted(workspace.id, agent.id, "#not-joined", true),
    ).rejects.toThrow("ACCESS_DENIED");
    await expect(channels.setAgentMuted(workspace.id, agent.id, "@helper", true)).rejects.toThrow(
      "INVALID_INPUT",
    );
    await expect(repo.sendAgentMessage(other.id, agent.id, "not allowed")).rejects.toThrow(
      "agent is not a conversation member",
    );
    await expect(repo.readMessages(crypto.randomUUID(), agent.id, "#general")).rejects.toThrow(
      "ACCESS_DENIED",
    );
    const denied = createAgentMessageMethod(repo, {}, "mute", {
      canUseAgent: async () => false,
    });
    expect(
      await denied(
        encodeAgentMessageRequest({
          protocolMajor: 1,
          requestId: crypto.randomUUID(),
          workspaceId: workspace.id,
          agentId: agent.id,
          operation: "mute",
          target: "#general",
        }),
        metadata,
      ),
    ).toMatchObject({ code: 403 });

    await channels.setAgentMuted(workspace.id, agent.id, "#general", false);
    const retryInput = {
      workspaceId: workspace.id,
      userId: user.id,
      channelId: general.id,
      requestId: crypto.randomUUID(),
      body: "Both Agents were eligible before this publish outage.",
    };
    rejectNextPublish = true;
    await expect(channels.send(retryInput)).rejects.toThrow("controlled publish outage");
    const eligibleBeforeMute = await repo.readPendingAgentDeliveries(workspace.id, agent.id);
    const recoveredId = eligibleBeforeMute.at(-1)!.messageId;
    await channels.setAgentMuted(workspace.id, agent.id, "#general", true);
    await channels.setAgentMuted(workspace.id, second.id, "#general", true);
    const retryStart = published.length;
    expect((await channels.send(retryInput)).id).toBe(recoveredId);
    expect(
      published
        .slice(retryStart)
        .map((m) => m.agentId)
        .sort(),
    ).toEqual([agent.id, second.id].sort());
    expect(new Set(published.slice(retryStart).map((m) => m.messageId))).toEqual(
      new Set([recoveredId]),
    );
    expect(
      (await channels.open(workspace.id, user.id, general.id)).messages.filter(
        (m) => m.body === retryInput.body,
      ),
    ).toHaveLength(1);
    expect(
      (await repo.readAgentRecoveryContext(workspace.id, agent.id)).resumeMessages.some(
        (m) => m.messageId === recoveredId,
      ),
    ).toBe(true);
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.computer.deleteMany({ where: { ownerId: user.id } });
    await db.user.delete({ where: { id: user.id } });
    await db.$disconnect();
    redis.close();
  }
});

test("channel threads enforce channel scope and isolate reads, recovery, notifications, and attachments", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const redis = new RedisClient(Bun.env.CHANNEL_TEST_REDIS_URL!);
  const suffix = crypto.randomUUID();
  const alice = await db.user.create({ data: { username: `ta${suffix.slice(0, 8)}` } });
  const bob = await db.user.create({ data: { username: `tb${suffix.slice(0, 8)}` } });
  const workspace = await db.workspace.create({
    data: {
      slug: `thread-${suffix}`,
      name: "Channel threads",
      members: { create: [{ userId: alice.id }, { userId: bob.id }] },
    },
  });
  const foreignWorkspace = await db.workspace.create({
    data: {
      slug: `foreign-${suffix}`,
      name: "Foreign channel threads",
      members: { create: { userId: alice.id } },
    },
  });
  try {
    const computer = await db.computer.create({
      data: { ownerId: alice.id, machineId: crypto.randomUUID() },
    });
    const agent = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: alice.id,
        computerId: computer.id,
        name: "thread-helper",
        displayName: "Thread Helper",
        runtimeConfig: {},
      },
    });
    const published: ReturnType<typeof decodeAgentMessageDelivery>[] = [];
    const channels = new PublicChannels(db, new RedisMessageRequestIdempotency(redis), {
      publish: async (_channel, payload) => {
        published.push(decodeAgentMessageDelivery(payload));
      },
      publishJson: async () => {},
    });
    const general = await channels.create(workspace.id, alice.id, "threads");
    await db.conversationMember.create({
      data: { workspaceId: workspace.id, conversationId: general.id, agentId: agent.id },
    });
    const foreignGeneral = (await channels.list(foreignWorkspace.id, alice.id))[0]!;
    const foreignRoot = await channels.send({
      workspaceId: foreignWorkspace.id,
      userId: alice.id,
      channelId: foreignGeneral.id,
      requestId: crypto.randomUUID(),
      body: "foreign root",
    });
    const root = await channels.send({
      workspaceId: workspace.id,
      userId: alice.id,
      channelId: general.id,
      requestId: crypto.randomUUID(),
      body: "channel root",
    });
    await channels.setAgentMuted(workspace.id, agent.id, "#threads", true);
    const quietReply = await channels.send({
      workspaceId: workspace.id,
      userId: alice.id,
      channelId: general.id,
      requestId: crypto.randomUUID(),
      body: "quiet thread reply",
      threadRootId: root.id,
    });
    const mentionedReply = await channels.send({
      workspaceId: workspace.id,
      userId: alice.id,
      channelId: general.id,
      requestId: crypto.randomUUID(),
      body: "@thread-helper please inspect this thread",
      threadRootId: root.id,
    });
    const target = `#threads:${root.id}`;
    const repo = new PrismaDirectConversationRepository(db);
    expect(published.map((message) => [message.messageId, message.target])).toEqual([
      [root.id, "#threads"],
      [mentionedReply.id, target],
    ]);
    const followedReply = await channels.send({
      workspaceId: workspace.id,
      userId: alice.id,
      channelId: general.id,
      requestId: crypto.randomUUID(),
      body: "ordinary reply reaches a follower through channel mute",
      threadRootId: root.id,
    });
    expect(published.at(-1)?.messageId).toBe(followedReply.id);
    const unfollow = createAgentMessageMethod(repo, {}, "thread-unfollow", {
      canUseAgent: async () => true,
    });
    const unfollowResult = await unfollow(
      encodeAgentMessageRequest({
        protocolMajor: 1,
        requestId: crypto.randomUUID(),
        workspaceId: workspace.id,
        agentId: agent.id,
        operation: "thread-unfollow",
        target,
      }),
      {
        principal: {
          userId: alice.id,
          workspaceId: workspace.id,
          agentId: agent.id,
          computerId: computer.id,
        },
      },
    );
    if (!(unfollowResult instanceof Uint8Array)) throw new Error(JSON.stringify(unfollowResult));
    expect(decodeCloudAgentMessageResponse(unfollowResult).accepted).toBe(true);
    const afterUnfollow = await channels.send({
      workspaceId: workspace.id,
      userId: alice.id,
      channelId: general.id,
      requestId: crypto.randomUUID(),
      body: "ordinary reply after unfollow",
      threadRootId: root.id,
    });
    expect(published.some((message) => message.messageId === afterUnfollow.id)).toBe(false);
    const reactivatingMention = await channels.send({
      workspaceId: workspace.id,
      userId: alice.id,
      channelId: general.id,
      requestId: crypto.randomUUID(),
      body: "@thread-helper please return",
      threadRootId: root.id,
    });
    const afterReactivation = await channels.send({
      workspaceId: workspace.id,
      userId: alice.id,
      channelId: general.id,
      requestId: crypto.randomUUID(),
      body: "ordinary reply after mention restored follow",
      threadRootId: root.id,
    });
    expect(published.slice(-2).map((message) => message.messageId)).toEqual([
      reactivatingMention.id,
      afterReactivation.id,
    ]);
    await expect(
      channels.send({
        workspaceId: workspace.id,
        userId: bob.id,
        channelId: general.id,
        requestId: crypto.randomUUID(),
        body: "not joined",
        threadRootId: root.id,
      }),
    ).rejects.toThrow("ACCESS_DENIED");
    await expect(
      channels.send({
        workspaceId: workspace.id,
        userId: alice.id,
        channelId: general.id,
        requestId: crypto.randomUUID(),
        body: "cross Workspace root",
        threadRootId: foreignRoot.id,
      }),
    ).rejects.toThrow("not found");
    await expect(
      channels.send({
        workspaceId: workspace.id,
        userId: alice.id,
        channelId: general.id,
        requestId: crypto.randomUUID(),
        body: "nested thread",
        threadRootId: quietReply.id,
      }),
    ).rejects.toThrow("top-level");
    const attachment = await db.attachment.create({
      data: {
        workspaceId: workspace.id,
        conversationId: general.id,
        uploaderId: alice.id,
        objectKey: `channel-thread/${suffix}`,
        fileName: "thread.txt",
        contentType: "text/plain",
        sizeBytes: 6,
      },
    });
    const attachmentReply = await channels.send({
      workspaceId: workspace.id,
      userId: alice.id,
      channelId: general.id,
      requestId: crypto.randomUUID(),
      body: "thread attachment",
      attachmentId: attachment.id,
      threadRootId: root.id,
    });
    expect((await repo.readMessages(workspace.id, agent.id, "#threads")).map((m) => m.id)).toEqual([
      root.id,
    ]);
    expect(
      (await repo.readMessages(workspace.id, agent.id, `#threads:${root.id.slice(0, 8)}`)).map(
        (message) => [message.id, message.target, message.attachment?.id],
      ),
    ).toEqual([
      [quietReply.id, target, undefined],
      [mentionedReply.id, target, undefined],
      [followedReply.id, target, undefined],
      [afterUnfollow.id, target, undefined],
      [reactivatingMention.id, target, undefined],
      [afterReactivation.id, target, undefined],
      [attachmentReply.id, target, attachment.id],
    ]);
    expect((await repo.readAgentRecoveryContext(workspace.id, agent.id)).unreadSummary).toEqual({});
    await repo.setAgentThreadFollowed(workspace.id, agent.id, target, false);
    const agentReply = await repo.sendAgentMessage(
      general.id,
      agent.id,
      "Agent thread response",
      undefined,
      root.id.slice(0, 8),
    );
    expect(agentReply.target).toBe(target);
    expect(
      await db.threadFollow.findUnique({
        where: {
          memberId_rootMessageId: {
            memberId: (
              await db.conversationMember.findUniqueOrThrow({
                where: {
                  conversationId_agentId: { conversationId: general.id, agentId: agent.id },
                },
              })
            ).id,
            rootMessageId: root.id,
          },
        },
      }),
    ).not.toBeNull();
    expect(
      (await repo.readPendingAgentDeliveries(workspace.id, agent.id)).some(
        (message) => message.messageId === agentReply.id,
      ),
    ).toBe(false);
    const opened = await channels.open(workspace.id, bob.id, general.id);
    expect(opened.messages.map((message) => message.id)).toEqual([
      root.id,
      quietReply.id,
      mentionedReply.id,
      followedReply.id,
      afterUnfollow.id,
      reactivatingMention.id,
      afterReactivation.id,
      attachmentReply.id,
      agentReply.id,
    ]);
    expect(opened.threadReadThrough[root.id]).toBeUndefined();
    await channels.markThreadReadForUser(workspace.id, alice.id, general.id, root.id, 999);
    expect(
      (await channels.open(workspace.id, alice.id, general.id)).threadReadThrough[root.id],
    ).toBe(agentReply.sequence);
    expect(
      (await channels.open(workspace.id, alice.id, general.id)).followedThreadRootIds,
    ).toContain(root.id);
    await channels.setUserThreadFollowed(workspace.id, alice.id, general.id, root.id, false);
    expect(
      (await channels.open(workspace.id, alice.id, general.id)).followedThreadRootIds,
    ).not.toContain(root.id);
    await channels.join(workspace.id, bob.id, general.id);
    await db.user.update({
      where: { id: bob.id },
      data: { browserNotificationsEnabled: true },
    });
    await db.webPushSubscription.create({
      data: {
        userId: bob.id,
        endpoint: `https://fcm.googleapis.com/wp/channel-thread-${suffix}`,
        p256dh: "thread-key",
        auth: "thread-auth",
      },
    });
    await channels.send({
      workspaceId: workspace.id,
      userId: bob.id,
      channelId: general.id,
      requestId: crypto.randomUUID(),
      body: "Bob participates and follows",
      threadRootId: root.id,
    });
    await channels.setUserMuted(workspace.id, bob.id, general.id, true);
    const followerNotice = await channels.send({
      workspaceId: workspace.id,
      userId: alice.id,
      channelId: general.id,
      requestId: crypto.randomUUID(),
      body: "ordinary human follower notification",
      threadRootId: root.id,
    });
    const pushSubscriptions = new PrismaWebPushSubscriptionStore(db);
    expect(
      (await pushSubscriptions.notificationForMessage(followerNotice.id))?.subscriptions,
    ).toEqual([
      expect.objectContaining({
        endpoint: `https://fcm.googleapis.com/wp/channel-thread-${suffix}`,
      }),
    ]);
    await channels.setUserThreadFollowed(workspace.id, bob.id, general.id, root.id, false);
    const unfollowedNotice = await channels.send({
      workspaceId: workspace.id,
      userId: alice.id,
      channelId: general.id,
      requestId: crypto.randomUUID(),
      body: "quiet after human unfollow",
      threadRootId: root.id,
    });
    expect(
      (await pushSubscriptions.notificationForMessage(unfollowedNotice.id))?.subscriptions,
    ).toEqual([]);
  } finally {
    await db.workspace.deleteMany({ where: { id: { in: [workspace.id, foreignWorkspace.id] } } });
    await db.computer.deleteMany({ where: { ownerId: alice.id } });
    await db.user.deleteMany({ where: { id: { in: [alice.id, bob.id] } } });
    await db.$disconnect();
    redis.close();
  }
});
