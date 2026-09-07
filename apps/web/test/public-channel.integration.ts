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
    const channels = new PublicChannels(db, new RedisMessageRequestIdempotency(redis), undefined, {
      async notifyMessage(messageId) {
        realtimeEvents.push({ conversationId: "", messageId, sequence: 0 });
      },
    });
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
    expect(
      (await channels.open(workspace.id, alice.id, engineering.id)).messages.map((m) => m.sequence),
    ).toEqual([1, 2, 3, 4, 5, 6]);
    expect(history.messages[1]?.senderMemberId).not.toBe(history.senderMemberId);
    const browserHistory = new ConversationHistory(db);
    expect(
      (await browserHistory.listOwnMessages(workspace.id, alice.id, engineering.id)).messages.map(
        (message) => message.body,
      ),
    ).toEqual(["Hello Bob"]);
    await expect(
      browserHistory.loadAround(workspace.id, bob.id, engineering.id, saved.id),
    ).rejects.toThrow("NOT_FOUND");
    await expect(
      browserHistory.listOwnMessages(workspace.id, outsider.id, engineering.id),
    ).rejects.toThrow("ACCESS_DENIED");
    await Promise.all([send(alice.id, "Concurrent A"), send(bob.id, "Concurrent B")]);
    expect(
      (await channels.open(workspace.id, alice.id, engineering.id)).messages.map((m) => m.sequence),
    ).toEqual([1, 2, 3, 4]);
    const latestPage = await channels.open(workspace.id, alice.id, engineering.id, { limit: 2 });
    expect(latestPage.hasOlder).toBe(true);
    expect(latestPage.messages.map((message) => message.sequence)).toEqual([3, 4]);
    const olderPage = await channels.open(workspace.id, alice.id, engineering.id, {
      beforeSequence: 3,
      limit: 2,
    });
    expect(olderPage.hasOlder).toBe(false);
    expect(olderPage.messages.map((message) => message.sequence)).toEqual([1, 2]);
    expect(
      (await channels.updates(workspace.id, alice.id, engineering.id, 2)).map(
        (message) => message.sequence,
      ),
    ).toEqual([3, 4]);
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
