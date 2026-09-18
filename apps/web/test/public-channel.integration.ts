import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/client";
import {
  PublicChannels,
  enrollGeneralChannel,
  getAgentChannel,
} from "../src/server/conversations/public-channels.server";
import { RedisClient } from "bun";
import { RedisMessageRequestIdempotency } from "../src/server/conversations/redis-message-request-idempotency.server";
import { PrismaWorkspaceCatalogStore } from "../src/server/workspaces/catalog.server";
import { PrismaWorkspaceEnrollmentStore } from "../src/server/workspaces/enrollment.server";
import { readAuthorizedAttachment } from "../src/server/attachments/attachment.server";
import { PrismaDirectConversationRepository } from "../src/server/db/repositories/direct-conversation.repositories.server";
import { decodeAgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import type { CentrifugoServerApi } from "../src/server/centrifugo/server-api.server";
import {
  executeAgentSendMessageWithPolicy,
  muteAgentChannel,
  readAgentMessages,
  unfollowAgentThread,
} from "../src/server/agents/agent-messages.service";
import { SendDirectMessage } from "../src/server/conversations/direct-message.server";
import { CentrifugoConversationRealtime } from "../src/server/conversations/conversation-realtime.server";
import { RedisAgentMessageHoldStore } from "../src/server/conversations/agent-message-hold.server";
import { PrismaAgentRepository } from "../src/server/db/repositories/agent.repositories.server";
import { PrismaWebPushSubscriptionStore } from "../src/server/notifications/prisma-web-push-subscriptions.server";
import { ConversationHistory } from "../src/server/conversations/conversation-history.server";
import { AgentChannelManagement } from "../src/server/conversations/agent-channel-management.server";

test("Workspace humans enrolled in general see one general channel; outsiders cannot discover it", async () => {
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
    await enrollGeneral(db, workspace.id);
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
      workspaceId?: string;
      threadRootId?: string;
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
    expect(first).toEqual([
      {
        id: expect.any(String),
        name: "general",
        joined: true,
        archived: false,
        muted: false,
        unreadCount: 0,
      },
    ]);
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
    // Any Workspace member (bob, a plain member) can create a channel.
    const memberChannel = await channels.create(workspace.id, bob.id, "member-channel");
    expect(memberChannel.id).toEqual(expect.any(String));
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
      attachmentIds: [attachment.id],
    });
    expect((await pushSubscriptions.notificationForMessage(saved.id))?.subscriptions).toEqual([]);
    expect(realtimeEvents).toContainEqual({
      conversationId: engineering.id,
      messageId: saved.id,
      sequence: saved.sequence,
      workspaceId: workspace.id,
      threadRootId: undefined,
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
      // A resolved mention is stored as an embedded-UUID token (ADR 0022 / PR #338) and carries a
      // MessageMention row; the browser renders the handle from that row, never by re-parsing
      // prose. `agentReadableBody` is what turns the token back into `@handle` for Agents.
      [3, `@${alice.username}`, `<@human:${bob.id}> please review this`],
      [4, `@${bob.username}`, "Hello Alice"],
    ]);
    // The token is resolved, not orphaned: the viewer gets the mention row it renders from. The
    // projection's `kind` is `user` (the browser's sender vocabulary); the token's prefix is
    // `human`.
    expect(history.messages[2]?.mentions).toEqual([
      {
        kind: "user",
        actorId: bob.id,
        handle: bob.username,
        label: bob.username,
      },
    ]);
    expect(history.messages[0]?.mentions).toEqual([]);
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
      // Same stored-token contract as above.
      `<@human:${bob.id}> please review this`,
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
        // Workspace creation itself enrolls the creator; reads never repair enrollment.
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
    await enrollGeneral(db, workspace.id);
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
    const scope = { workspaceId: workspace.id, agentId: agent.id };
    const failingCentrifugo: CentrifugoServerApi = {
      publish: async () => {
        throw new Error("Agent reply must not publish");
      },
      publishJson: async () => {
        throw new Error("Agent reply must not publish");
      },
    };
    const holdStore = new RedisAgentMessageHoldStore(redis);
    const agentSender = new SendDirectMessage(
      repo,
      new RedisMessageRequestIdempotency(redis),
      failingCentrifugo,
      new CentrifugoConversationRealtime(failingCentrifugo),
    );
    await muteAgentChannel(repo, scope, "#general", true);
    expect(
      (await readAgentMessages(repo, scope, "#general", {})).messages.map((m) => m.body),
    ).toContain("New ordinary conversation after unmute.");
    const beforeReply = published.length;
    await channels.setUserMuted(workspace.id, user.id, general.id, true);
    const reply = await executeAgentSendMessageWithPolicy(
      { repository: repo, sender: agentSender, holdStore },
      {
        requestId: crypto.randomUUID(),
        workspaceId: workspace.id,
        agentId: agent.id,
        target: "#general",
        body: `@${user.username} this Agent reply should notify the mentioned human`,
        seenUpToSequence: ordinary.sequence,
      },
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

test("a channel @mention persists as a token and wakes only the mentioned Agent, including Agent-to-Agent", async () => {
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
      name: "Mention delivery",
      members: { create: { userId: user.id } },
    },
  });
  try {
    const computer = await db.computer.create({
      data: { ownerId: user.id, machineId: crypto.randomUUID() },
    });
    const helper = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: user.id,
        computerId: computer.id,
        name: "helper",
        displayName: "Helper",
        runtimeConfig: {},
      },
    });
    const scout = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: user.id,
        computerId: computer.id,
        name: "scout",
        displayName: "Scout",
        runtimeConfig: {},
      },
    });
    await enrollGeneral(db, workspace.id);
    const channels = new PublicChannels(db, new RedisMessageRequestIdempotency(redis), {
      publish: async () => {},
      publishJson: async () => {},
    });
    const general = (await channels.list(workspace.id, user.id))[0]!;
    const repo = new PrismaDirectConversationRepository(db);
    const agentSender = new SendDirectMessage(repo, new RedisMessageRequestIdempotency(redis), {
      publish: async () => {},
    });

    const humanMention = await channels.send({
      workspaceId: workspace.id,
      userId: user.id,
      channelId: general.id,
      requestId: crypto.randomUUID(),
      body: "@helper please triage this.",
    });
    expect(humanMention.body).toBe(`<@agent:${helper.id}> please triage this.`);
    expect(
      (await db.messageMention.findMany({ where: { messageId: humanMention.id } })).map((row) => [
        row.kind,
        row.handle,
        row.actorId,
        row.conversationId,
      ]),
    ).toEqual([["agent", "helper", helper.id, general.id]]);
    expect(
      (await db.agentMessageDelivery.findMany({ where: { messageId: humanMention.id } })).map(
        (row) => row.agentId,
      ),
    ).toEqual([helper.id]);
    expect(
      (await repo.readMessages(workspace.id, helper.id, "#general")).find(
        (message) => message.id === humanMention.id,
      )?.body,
    ).toBe("@helper please triage this.");

    const handoff = await agentSender.executeFromAgent({
      requestId: crypto.randomUUID(),
      workspaceId: workspace.id,
      agentId: helper.id,
      target: "#general",
      body: "@scout please take the follow-up.",
    });
    expect(handoff.body).toBe(`<@agent:${scout.id}> please take the follow-up.`);
    expect(
      (await db.agentMessageDelivery.findMany({ where: { messageId: handoff.id } })).map(
        (row) => row.agentId,
      ),
    ).toEqual([scout.id]);
    expect(
      (await repo.readMessages(workspace.id, scout.id, "#general")).find(
        (message) => message.id === handoff.id,
      )?.body,
    ).toBe("@scout please take the follow-up.");
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
    await enrollGeneral(db, workspace.id);
    await enrollGeneral(db, foreignWorkspace.id);
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
    await unfollowAgentThread(repo, { workspaceId: workspace.id, agentId: agent.id }, target);
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
      attachmentIds: [attachment.id],
      threadRootId: root.id,
    });
    expect((await repo.readMessages(workspace.id, agent.id, "#threads")).map((m) => m.id)).toEqual([
      root.id,
    ]);
    expect(
      (await repo.readMessages(workspace.id, agent.id, `#threads:${root.id.slice(0, 8)}`)).map(
        (message) => [message.id, message.target, message.attachments.at(0)?.id],
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

function enrollGeneral(db: PrismaClient, workspaceId: string) {
  return db.$transaction((tx) => enrollGeneralChannel(tx, workspaceId));
}

test("reads never enroll: general membership comes from write points and the backfill migration", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID().slice(0, 8);
  const alice = await db.user.create({ data: { username: `ea${suffix}` } });
  const bob = await db.user.create({ data: { username: `eb${suffix}` } });
  // A pre-backfill Workspace: humans and an Agent exist, general does not.
  const workspace = await db.workspace.create({
    data: {
      slug: `enroll-${suffix}`,
      name: "Legacy workspace",
      members: { create: [{ userId: alice.id }, { userId: bob.id }] },
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
        name: "legacy-helper",
        displayName: "Legacy Helper",
        runtimeConfig: {},
      },
    });
    const channels = new PublicChannels(db);
    expect(await channels.list(workspace.id, alice.id)).toEqual([]);

    const migration = (
      await Bun.file(
        new URL(
          "../prisma/migrations/20260915120000_backfill_general_channel/migration.sql",
          import.meta.url,
        ),
      ).text()
    )
      .split("\n")
      .filter((line) => !line.startsWith("--"))
      .join("\n")
      .split(";")
      .filter((part) => part.trim());
    for (const statement of migration) await db.$executeRawUnsafe(statement);
    const general = await db.conversation.findUniqueOrThrow({
      where: { workspaceId_channelName: { workspaceId: workspace.id, channelName: "general" } },
      include: { members: { orderBy: { userId: "asc" } } },
    });
    expect(general.members.map((m) => m.userId ?? m.agentId).sort()).toEqual(
      [alice.id, bob.id, agent.id].sort(),
    );
    expect(await channels.list(workspace.id, bob.id)).toEqual([
      {
        id: general.id,
        name: "general",
        joined: true,
        archived: false,
        muted: false,
        unreadCount: 0,
      },
    ]);

    // Re-running the backfill is a no-op.
    for (const statement of migration) await db.$executeRawUnsafe(statement);
    expect(await db.conversationMember.count({ where: { conversationId: general.id } })).toBe(3);

    // A membership row written outside the write points is not repaired by reads.
    const carol = await db.user.create({ data: { username: `ec${suffix}` } });
    try {
      await db.workspaceMembership.create({
        data: { workspaceId: workspace.id, userId: carol.id },
      });
      expect(await channels.list(workspace.id, carol.id)).toEqual([
        {
          id: general.id,
          name: "general",
          joined: false,
          archived: false,
          muted: false,
          unreadCount: 0,
        },
      ]);
      await channels.open(workspace.id, carol.id, general.id);
      expect(await db.conversationMember.count({ where: { conversationId: general.id } })).toBe(3);
    } finally {
      await db.user.delete({ where: { id: carol.id } });
    }
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.computer.deleteMany({ where: { ownerId: alice.id } });
    await db.user.deleteMany({ where: { id: { in: [alice.id, bob.id] } } });
    await db.$disconnect();
  }
});

test("channel members add humans and Agents; a Workspace member outside the channel cannot; invalid ids are rejected", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const redis = new RedisClient(Bun.env.CHANNEL_TEST_REDIS_URL!);
  const suffix = crypto.randomUUID().slice(0, 8);
  const owner = await db.user.create({ data: { username: `mo${suffix}` } });
  // A plain `member` role who joins the channel; Slack lets any channel member add people.
  const channelMember = await db.user.create({ data: { username: `mc${suffix}` } });
  // A plain `member` role who never joins the channel.
  const outsideMember = await db.user.create({ data: { username: `mm${suffix}` } });
  const newcomer = await db.user.create({ data: { username: `mn${suffix}` } });
  const workspace = await db.workspace.create({
    data: {
      slug: `members-${suffix}`,
      name: "Channel membership",
      members: {
        create: [
          { userId: owner.id, role: "owner" },
          { userId: channelMember.id },
          { userId: outsideMember.id },
          { userId: newcomer.id },
        ],
      },
    },
  });
  try {
    const computer = await db.computer.create({
      data: { ownerId: owner.id, machineId: crypto.randomUUID() },
    });
    const agent = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: owner.id,
        computerId: computer.id,
        name: "roster-helper",
        displayName: "Roster Helper",
        runtimeConfig: {},
      },
    });
    await enrollGeneral(db, workspace.id);
    const published: ReturnType<typeof decodeAgentMessageDelivery>[] = [];
    const channels = new PublicChannels(db, new RedisMessageRequestIdempotency(redis), {
      publish: async (_channel, payload) => {
        published.push(decodeAgentMessageDelivery(payload));
      },
      publishJson: async () => {},
    });

    // A plain Workspace member creates the channel (Slack: any member can create a channel).
    const channel = await channels.create(workspace.id, channelMember.id, "roster");
    await channels.join(workspace.id, owner.id, channel.id);

    // A Workspace member who is NOT in the channel may still read it, but cannot add members.
    const outsideView = await channels.members(
      workspace.id,
      { userId: outsideMember.id },
      channel.id,
    );
    expect(outsideView.canAddMembers).toBe(false);
    expect(outsideView.humans.map((human) => human.id).sort()).toEqual(
      [channelMember.id, owner.id].sort(),
    );
    expect(outsideView.agents).toEqual([]);
    expect(outsideView.candidates.humans.map((human) => human.id).sort()).toEqual(
      [outsideMember.id, newcomer.id].sort(),
    );
    expect(outsideView.candidates.agents.map((candidate) => candidate.id)).toEqual([agent.id]);

    await expect(
      channels.addMembers(workspace.id, { userId: outsideMember.id }, channel.id, {
        userIds: [newcomer.id],
        agentIds: [],
      }),
    ).rejects.toThrow("ACCESS_DENIED");

    // A channel member with a plain `member` Workspace role may read and add members.
    const memberView = await channels.members(
      workspace.id,
      { userId: channelMember.id },
      channel.id,
    );
    expect(memberView.canAddMembers).toBe(true);

    await expect(
      channels.addMembers(workspace.id, { userId: channelMember.id }, channel.id, {
        userIds: [crypto.randomUUID()],
        agentIds: [],
      }),
    ).rejects.toThrow("INVALID_INPUT");
    await expect(
      channels.addMembers(workspace.id, { userId: channelMember.id }, channel.id, {
        userIds: [],
        agentIds: [crypto.randomUUID()],
      }),
    ).rejects.toThrow("INVALID_INPUT");

    const afterAdd = await channels.addMembers(
      workspace.id,
      { userId: channelMember.id },
      channel.id,
      {
        userIds: [newcomer.id],
        agentIds: [agent.id],
      },
    );
    expect(afterAdd.canAddMembers).toBe(true);
    expect(afterAdd.humans.map((human) => human.id).sort()).toEqual(
      [newcomer.id, owner.id, channelMember.id].sort(),
    );
    expect(afterAdd.agents.map((candidate) => candidate.id)).toEqual([agent.id]);
    expect(afterAdd.candidates.humans.map((human) => human.id)).toEqual([outsideMember.id]);
    expect(afterAdd.candidates.agents).toEqual([]);

    // The newly added human is a real conversation member and can send.
    const opened = await channels.open(workspace.id, newcomer.id, channel.id);
    expect(opened.senderMemberId).not.toBe("");

    // The newly added Agent can now be resolved by its target...
    await getAgentChannel(db, workspace.id, agent.id, "#roster");
    // ...and receives an AgentMessageDelivery when a human posts afterward.
    const sent = await channels.send({
      workspaceId: workspace.id,
      userId: owner.id,
      channelId: channel.id,
      requestId: crypto.randomUUID(),
      body: "Welcome to the roster channel",
    });
    expect(published).toContainEqual(
      expect.objectContaining({ agentId: agent.id, messageId: sent.id }),
    );
    expect(
      await db.agentMessageDelivery.findFirst({
        where: { conversationId: channel.id, agentId: agent.id, messageId: sent.id },
      }),
    ).not.toBeNull();

    // Re-adding an existing member is a no-op (skipDuplicates), not a conflict.
    const reAdded = await channels.addMembers(
      workspace.id,
      { userId: channelMember.id },
      channel.id,
      {
        userIds: [newcomer.id],
        agentIds: [],
      },
    );
    expect(reAdded.humans.map((human) => human.id).sort()).toEqual(
      [newcomer.id, owner.id, channelMember.id].sort(),
    );
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.computer.deleteMany({ where: { ownerId: owner.id } });
    await db.user.deleteMany({
      where: { id: { in: [owner.id, channelMember.id, outsideMember.id, newcomer.id] } },
    });
    await db.$disconnect();
    redis.close();
  }
});

test("Agent channel management: authority, join/leave, archive, and add/remove member", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID().slice(0, 8);
  const owner = await db.user.create({ data: { username: `mo${suffix}` } });
  const outsider = await db.user.create({ data: { username: `mu${suffix}` } });
  const workspace = await db.workspace.create({
    data: {
      slug: `manage-${suffix}`,
      name: "Channel management",
      members: {
        create: [{ userId: owner.id, role: "owner" }, { userId: outsider.id }],
      },
    },
  });
  try {
    const computer = await db.computer.create({
      data: { ownerId: owner.id, machineId: crypto.randomUUID() },
    });
    const admin = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: owner.id,
        computerId: computer.id,
        name: `admin${suffix}`,
        displayName: "Admin",
        role: "admin",
        runtimeConfig: {},
      },
    });
    const member = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: owner.id,
        computerId: computer.id,
        name: `member${suffix}`,
        displayName: "Member",
        role: "member",
        runtimeConfig: {},
      },
    });
    // Never joins #eng: used to show add-member's Slack-style "must be a member" denial.
    const outsiderAgent = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: owner.id,
        computerId: computer.id,
        name: `outsideragent${suffix}`,
        displayName: "Outsider Agent",
        role: "member",
        runtimeConfig: {},
      },
    });
    // Never joins #eng either: `server_role` basis grants admin authority independent of
    // membership (ADR 0030) — "a server admin without membership can still archive".
    const nonMemberServerAdmin = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: owner.id,
        computerId: computer.id,
        name: `nonmemberadmin${suffix}`,
        displayName: "Non-member Admin",
        role: "admin",
        runtimeConfig: {},
      },
    });
    await enrollGeneral(db, workspace.id);
    const manage = new AgentChannelManagement(db, {
      snapshot: async () => {
        throw new Error("no live display data in this test");
      },
    });

    // Authority (Slack's default, ADR 0025): any Agent that belongs to the Workspace may
    // create a channel — including a plain, non-admin Agent — the same as `PublicChannels
    // .create` for humans. The creator becomes a member.
    const created = await manage.create(workspace.id, member.id, "#eng", "Engineering");
    expect(created).toEqual({
      target: "#eng",
      channel: { id: expect.any(String), name: "#eng", description: "Engineering" },
    });

    // Any Agent may join a non-archived channel; idempotent. `member` already joined by
    // creating the channel; `admin` joins separately. `alreadyJoined` distinguishes the two.
    const adminJoin = await manage.join(workspace.id, admin.id, "#eng");
    expect(adminJoin).toEqual({ target: "#eng", joined: true, alreadyJoined: false });
    const memberRejoin = await manage.join(workspace.id, member.id, "#eng");
    expect(memberRejoin).toEqual({ target: "#eng", joined: true, alreadyJoined: true });
    await manage.join(workspace.id, member.id, "#eng");
    const info = await manage.info(workspace.id, member.id, "#eng");
    expect(info).toMatchObject({
      name: "#eng",
      description: "Engineering",
      archived: false,
      joined: true,
      muted: false,
      memberCounts: { agents: 2, humans: 0 },
    });

    // Roster reflects both Agents, tagging the caller "self" and the creator "admin". `admin`'s
    // basis is its own server role (`Agent.role`); `member`'s is the `channelRole` it got as
    // #eng's creator (ADR 0030) — neither is #general, so both bases are reported.
    const roster = await manage.members(workspace.id, member.id, "#eng");
    expect(roster.agents.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      {
        name: admin.name,
        displayName: "Admin",
        description: "",
        serverRole: "admin",
        channelRole: "member",
        channelAdminBasis: "server_role",
        self: false,
        status: "unknown",
      },
      {
        name: member.name,
        displayName: "Member",
        description: "",
        serverRole: "member",
        channelRole: "admin",
        channelAdminBasis: "channel_role",
        self: true,
        status: "unknown",
      },
    ]);

    // Leave, then re-join: the row is soft-left and cleared, not deleted; membership count
    // reflects only active members while left. `wasMember` distinguishes an actual leave from
    // leaving again while already left.
    const memberLeave = await manage.leave(workspace.id, member.id, "#eng");
    expect(memberLeave).toEqual({ target: "#eng", joined: false, wasMember: true });
    const memberLeaveAgain = await manage.leave(workspace.id, member.id, "#eng");
    expect(memberLeaveAgain).toEqual({ target: "#eng", joined: false, wasMember: false });
    expect((await manage.info(workspace.id, member.id, "#eng")).joined).toBe(false);
    expect((await manage.info(workspace.id, admin.id, "#eng")).memberCounts.agents).toBe(1);
    expect(
      await db.conversationMember.count({
        where: { agentId: member.id, conversation: { channelName: "eng" } },
      }),
    ).toBe(1);
    await manage.join(workspace.id, member.id, "#eng");
    expect((await manage.info(workspace.id, member.id, "#eng")).joined).toBe(true);

    // #general cannot be left, renamed, archived, or have a member removed.
    await expect(manage.leave(workspace.id, member.id, "#general")).rejects.toThrow(
      "cannot leave #general",
    );
    await expect(
      manage.update(workspace.id, admin.id, "#general", { name: "renamed" }),
    ).rejects.toThrow("cannot rename #general");
    await expect(manage.setArchived(workspace.id, admin.id, "#general", true)).rejects.toThrow(
      "cannot archive #general",
    );
    await expect(
      manage.removeMember(workspace.id, admin.id, "#general", { agent: `@${member.name}` }),
    ).rejects.toThrow("cannot remove a member from #general");

    // Update requires admin authority (channel-aware, ADR 0030) and at least one field; general
    // is reserved. `member` is #eng's creator, so it is itself a channel admin now (channelRole
    // "admin") — `outsiderAgent` (never a member, plain `Agent.role`) exercises the plain
    // denial instead.
    await expect(
      manage.update(workspace.id, outsiderAgent.id, "#eng", { name: "x" }),
    ).rejects.toThrow("this Agent's owner lacks admin authority for update");
    // Positive path for the OTHER basis (`channel_role`, ADR 0030): #eng's creator may update
    // its own channel with no server-role admin authority at all.
    const channelRoleUpdate = await manage.update(workspace.id, member.id, "#eng", {
      description: "Updated via channel_role admin",
    });
    expect(channelRoleUpdate.description).toBe("Updated via channel_role admin");
    await expect(manage.update(workspace.id, admin.id, "#eng", {})).rejects.toThrow(
      "update requires --name or --description",
    );
    await expect(
      manage.update(workspace.id, admin.id, "#eng", { name: "general" }),
    ).rejects.toThrow("general is reserved");
    const updated = await manage.update(workspace.id, admin.id, "#eng", {
      description: "Eng team",
    });
    expect(updated.description).toBe("Eng team");

    // Archive/unarchive: admin only (either basis); join and post are refused while archived.
    await expect(manage.setArchived(workspace.id, outsiderAgent.id, "#eng", true)).rejects.toThrow(
      "this Agent's owner lacks admin authority for archive",
    );
    // Positive path for `channel_role` basis: the creator may archive/unarchive its own channel.
    const channelRoleArchived = await manage.setArchived(workspace.id, member.id, "#eng", true);
    expect(channelRoleArchived).toEqual({ target: "#eng", archived: true });
    await manage.setArchived(workspace.id, member.id, "#eng", false);
    const archived = await manage.setArchived(workspace.id, admin.id, "#eng", true);
    expect(archived).toEqual({ target: "#eng", archived: true });
    expect((await manage.info(workspace.id, admin.id, "#eng")).archived).toBe(true);
    await expect(manage.join(workspace.id, admin.id, "#eng")).rejects.toThrow(
      "channel is archived",
    );
    await manage.setArchived(workspace.id, admin.id, "#eng", false);
    expect((await manage.info(workspace.id, admin.id, "#eng")).archived).toBe(false);

    // `server_role` basis needs no membership at all: a server admin who never joined #eng can
    // still archive/unarchive it (ADR 0030).
    const nonMemberArchived = await manage.setArchived(
      workspace.id,
      nonMemberServerAdmin.id,
      "#eng",
      true,
    );
    expect(nonMemberArchived).toEqual({ target: "#eng", archived: true });
    await manage.setArchived(workspace.id, nonMemberServerAdmin.id, "#eng", false);

    // add-member (Slack's default, ADR 0025): the acting Agent must itself already be an
    // active member of the channel — not gated by Agent.role admin authority, reused from
    // `PublicChannels.addMembers`. Unknown handle 404s; a human must already be a Workspace
    // member (also enforced by the shared method, surfaced as the same 404).
    await expect(
      manage.addMember(workspace.id, outsiderAgent.id, "#eng", { user: `@${outsider.username}` }),
    ).rejects.toThrow("this Agent must be a member of #eng to add members to it");
    await expect(
      manage.addMember(workspace.id, member.id, "#eng", { user: "@nobody" }),
    ).rejects.toThrow("member not found: @nobody");
    const addedHuman = await manage.addMember(workspace.id, member.id, "#eng", {
      user: `@${outsider.username}`,
    });
    expect(addedHuman).toEqual({
      target: "#eng",
      member: { kind: "user", handle: `@${outsider.username}` },
      added: true,
      alreadyMember: false,
    });
    expect((await manage.info(workspace.id, admin.id, "#eng")).memberCounts.humans).toBe(1);
    // Adding the same human again reports alreadyMember, matching Raft's "@h is already in #x.".
    const reAddedHuman = await manage.addMember(workspace.id, member.id, "#eng", {
      user: `@${outsider.username}`,
    });
    expect(reAddedHuman).toEqual({
      target: "#eng",
      member: { kind: "user", handle: `@${outsider.username}` },
      added: true,
      alreadyMember: true,
    });

    // remove-member: admin required for another member (`member` is #eng's own channel admin,
    // so `outsiderAgent` exercises the plain denial); self-removal (an Agent removing itself)
    // is allowed without admin authority, the same as `leave`.
    await expect(
      manage.removeMember(workspace.id, outsiderAgent.id, "#eng", {
        user: `@${outsider.username}`,
      }),
    ).rejects.toThrow("this Agent's owner lacks admin authority for remove-member");
    // Positive path for `channel_role` basis: the authority check itself passes for the
    // creator (`wasMember: false` only because `outsiderAgent` never joined #eng).
    const channelRoleRemoval = await manage.removeMember(workspace.id, member.id, "#eng", {
      agent: `@${outsiderAgent.name}`,
    });
    expect(channelRoleRemoval).toEqual({ target: "#eng", removed: true, wasMember: false });
    const removedAgent = await manage.removeMember(workspace.id, member.id, "#eng", {
      agent: `@${member.name}`,
    });
    expect(removedAgent).toEqual({ target: "#eng", removed: true, wasMember: true });
    expect((await manage.info(workspace.id, member.id, "#eng")).joined).toBe(false);
    // Removing an already-left member reports wasMember: false, matching Raft's "@h was not
    // in #x.".
    const removedAgentAgain = await manage.removeMember(workspace.id, admin.id, "#eng", {
      agent: `@${member.name}`,
    });
    expect(removedAgentAgain).toEqual({ target: "#eng", removed: true, wasMember: false });
    const removedHuman = await manage.removeMember(workspace.id, admin.id, "#eng", {
      user: `@${outsider.username}`,
    });
    expect(removedHuman).toEqual({ target: "#eng", removed: true, wasMember: true });
    expect((await manage.info(workspace.id, admin.id, "#eng")).memberCounts.humans).toBe(0);

    // members() with an `@user` target looks the DM up read-only; it never creates one as a
    // side effect (unlike `read`/`search`/`send`, which lazily create it via
    // `getOrCreateUserAgent`). No DM exists yet between `admin` and `outsider`, so this 404s.
    await expect(manage.members(workspace.id, admin.id, `@${outsider.username}`)).rejects.toThrow(
      "channel not found",
    );
    expect(
      await db.conversation.findFirst({
        where: { workspaceId: workspace.id, channelName: null },
      }),
    ).toBeNull();

    // Once a DM conversation exists (created here the same way a real `send`/`read` would),
    // members() resolves it and tags the caller "self".
    await new PrismaDirectConversationRepository(db).getOrCreateUserAgent(
      workspace.id,
      owner.id,
      admin.id,
    );
    // A DM is not a named channel, so it has no channel-role concept: `channelRole`/
    // `channelAdminBasis` stay unset for every entry.
    const dmRoster = await manage.members(workspace.id, admin.id, `@${owner.username}`);
    expect(dmRoster).toEqual({
      target: `@${owner.username}`,
      agents: [
        {
          name: admin.name,
          displayName: "Admin",
          description: "",
          serverRole: "admin",
          self: true,
          status: "unknown",
        },
      ],
      humans: [{ username: owner.username, serverRole: "owner" }],
    });
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.computer.deleteMany({ where: { ownerId: owner.id } });
    await db.user.deleteMany({ where: { id: { in: [owner.id, outsider.id] } } });
    await db.$disconnect();
  }
});

test("Channel roles (ADR 0030): creator is channel admin, a plain member cannot archive, promote/demote via setChannelRole, server admin without membership, #general's roles are fixed", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const redis = new RedisClient(Bun.env.CHANNEL_TEST_REDIS_URL!);
  const suffix = crypto.randomUUID().slice(0, 8);
  const creator = await db.user.create({ data: { username: `rc${suffix}` } });
  const plainMember = await db.user.create({ data: { username: `rp${suffix}` } });
  const serverAdmin = await db.user.create({ data: { username: `ra${suffix}` } });
  const workspace = await db.workspace.create({
    data: {
      slug: `roles-${suffix}`,
      name: "Channel roles",
      members: {
        create: [
          { userId: creator.id },
          { userId: plainMember.id },
          // Never joins the channel: proves `server_role` basis needs no membership.
          { userId: serverAdmin.id, role: "admin" },
        ],
      },
    },
  });
  try {
    const channels = new PublicChannels(db, new RedisMessageRequestIdempotency(redis), {
      publish: async () => {},
      publishJson: async () => {},
    });
    await enrollGeneral(db, workspace.id);

    // The creator is the channel's own admin (ADR 0030): `channelRole` "admin", basis
    // "channel_role", and every admin capability except on `#general`.
    const channel = await channels.create(workspace.id, creator.id, "roles-eng");
    await channels.join(workspace.id, plainMember.id, channel.id);
    const creatorView = await channels.members(workspace.id, { userId: creator.id }, channel.id);
    expect(creatorView.channelRole).toBe("admin");
    expect(creatorView.channelAdminBasis).toBe("channel_role");
    expect(creatorView.channelCapabilities).toMatchObject({
      update: true,
      archive: true,
      unarchive: true,
      remove_member: true,
      manage_roles: true,
    });
    const creatorRow = creatorView.humans.find((human) => human.id === creator.id);
    expect(creatorRow).toMatchObject({ channelRole: "admin", channelAdminBasis: "channel_role" });

    // A plain member (no admin basis at all) sees no admin capabilities and cannot manage
    // roles or archive.
    const plainView = await channels.members(workspace.id, { userId: plainMember.id }, channel.id);
    expect(plainView.channelRole).toBe("member");
    expect(plainView.channelAdminBasis).toBeUndefined();
    expect(plainView.channelCapabilities).toMatchObject({
      update: false,
      archive: false,
      unarchive: false,
      remove_member: false,
      manage_roles: false,
    });
    await expect(
      channels.setChannelRole(
        workspace.id,
        plainMember.id,
        channel.id,
        { userId: plainMember.id },
        "admin",
      ),
    ).rejects.toThrow("ACCESS_DENIED");

    // Promoting via `setChannelRole` grants channel-admin authority; demoting revokes it.
    await channels.setChannelRole(
      workspace.id,
      creator.id,
      channel.id,
      { userId: plainMember.id },
      "admin",
    );
    const promotedView = await channels.members(
      workspace.id,
      { userId: plainMember.id },
      channel.id,
    );
    expect(promotedView.channelRole).toBe("admin");
    expect(promotedView.channelAdminBasis).toBe("channel_role");
    expect(promotedView.channelCapabilities.archive).toBe(true);

    await channels.setChannelRole(
      workspace.id,
      creator.id,
      channel.id,
      { userId: plainMember.id },
      "member",
    );
    const demotedView = await channels.members(
      workspace.id,
      { userId: plainMember.id },
      channel.id,
    );
    expect(demotedView.channelRole).toBe("member");
    expect(demotedView.channelAdminBasis).toBeUndefined();
    expect(demotedView.channelCapabilities.archive).toBe(false);

    // `server_role` basis needs no membership: `serverAdmin` never joined this channel but
    // still reports full admin capabilities.
    const serverAdminView = await channels.members(
      workspace.id,
      { userId: serverAdmin.id },
      channel.id,
    );
    expect(serverAdminView.channelRole).toBeUndefined();
    expect(serverAdminView.channelAdminBasis).toBe("server_role");
    expect(serverAdminView.channelCapabilities).toMatchObject({
      update: true,
      archive: true,
      unarchive: true,
      remove_member: true,
      manage_roles: true,
    });

    // `#general`'s roles are fixed: nobody can be its channel admin, `setChannelRole` always
    // rejects, and even a server admin's admin capabilities are unavailable there.
    const general = await db.conversation.findUniqueOrThrow({
      where: { workspaceId_channelName: { workspaceId: workspace.id, channelName: "general" } },
    });
    await expect(
      channels.setChannelRole(
        workspace.id,
        serverAdmin.id,
        general.id,
        { userId: plainMember.id },
        "admin",
      ),
    ).rejects.toThrow("CONFLICT");
    const generalServerAdminView = await channels.members(
      workspace.id,
      { userId: serverAdmin.id },
      general.id,
    );
    expect(generalServerAdminView.channelAdminBasis).toBe("server_role");
    expect(generalServerAdminView.channelCapabilities).toMatchObject({
      update: false,
      archive: false,
      unarchive: false,
      remove_member: false,
      manage_roles: false,
      leave: false,
    });
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.deleteMany({
      where: { id: { in: [creator.id, plainMember.id, serverAdmin.id] } },
    });
    await db.$disconnect();
    redis.close();
  }
});

test("channel leave and member removal: owner/admin removes a human and an Agent, a plain member cannot, #general is exempt, and a removed/left member loses send/delivery access until rejoining", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const redis = new RedisClient(Bun.env.CHANNEL_TEST_REDIS_URL!);
  const suffix = crypto.randomUUID().slice(0, 8);
  const owner = await db.user.create({ data: { username: `lo${suffix}` } });
  const admin = await db.user.create({ data: { username: `la${suffix}` } });
  const plain = await db.user.create({ data: { username: `lp${suffix}` } });
  const workspace = await db.workspace.create({
    data: {
      slug: `leave-${suffix}`,
      name: "Leave and removal",
      members: {
        create: [
          { userId: owner.id, role: "owner" },
          { userId: admin.id, role: "admin" },
          { userId: plain.id },
        ],
      },
    },
  });
  try {
    const computer = await db.computer.create({
      data: { ownerId: owner.id, machineId: crypto.randomUUID() },
    });
    const agent = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: owner.id,
        computerId: computer.id,
        name: `helper${suffix}`,
        displayName: "Helper",
        runtimeConfig: {},
      },
    });
    const general = await enrollGeneral(db, workspace.id);
    const published: ReturnType<typeof decodeAgentMessageDelivery>[] = [];
    const channels = new PublicChannels(db, new RedisMessageRequestIdempotency(redis), {
      publish: async (_channel, payload) => {
        published.push(decodeAgentMessageDelivery(payload));
      },
      publishJson: async () => {},
    });

    const ops = await channels.create(workspace.id, owner.id, "ops");
    await channels.join(workspace.id, admin.id, ops.id);
    await channels.join(workspace.id, plain.id, ops.id);
    await channels.addMembers(workspace.id, { userId: owner.id }, ops.id, {
      userIds: [],
      agentIds: [agent.id],
    });

    // Nobody may leave or be removed from #general, regardless of Workspace role.
    await expect(channels.leave(workspace.id, plain.id, general.id)).rejects.toThrow("CONFLICT");
    await expect(
      channels.removeMember(workspace.id, owner.id, general.id, { userId: plain.id }),
    ).rejects.toThrow("CONFLICT");
    const generalMembers = await channels.members(workspace.id, { userId: owner.id }, general.id);
    expect(generalMembers.canLeave).toBe(false);
    expect(generalMembers.canRemoveMembers).toBe(false);

    // A plain member cannot remove anyone.
    await expect(
      channels.removeMember(workspace.id, plain.id, ops.id, { userId: admin.id }),
    ).rejects.toThrow("ACCESS_DENIED");
    const opsMembersAsPlain = await channels.members(workspace.id, { userId: plain.id }, ops.id);
    expect(opsMembersAsPlain.canRemoveMembers).toBe(false);
    expect(opsMembersAsPlain.canLeave).toBe(true);
    const opsMembersAsAdmin = await channels.members(workspace.id, { userId: admin.id }, ops.id);
    expect(opsMembersAsAdmin.canRemoveMembers).toBe(true);

    // `plain` mutes the channel before being removed; the preference and member row must survive.
    await channels.setUserMuted(workspace.id, plain.id, ops.id, true);
    const memberRowBefore = await db.conversationMember.findUniqueOrThrow({
      where: { conversationId_userId: { conversationId: ops.id, userId: plain.id } },
    });
    expect(memberRowBefore.leftAt).toBeNull();
    const plainMessage = await channels.send({
      workspaceId: workspace.id,
      userId: plain.id,
      channelId: ops.id,
      requestId: crypto.randomUUID(),
      body: "before removal",
    });

    // Owner/admin removes the human: soft-left, message stays, roster excludes them, and they
    // reappear as an add-candidate.
    const removedHuman = await channels.removeMember(workspace.id, admin.id, ops.id, {
      userId: plain.id,
    });
    expect(removedHuman).toEqual({ removed: true, wasMember: true });
    const afterHumanRemoval = await channels.members(workspace.id, { userId: owner.id }, ops.id);
    expect(afterHumanRemoval.humans.map((human) => human.id)).not.toContain(plain.id);
    expect(afterHumanRemoval.candidates.humans.map((human) => human.id)).toContain(plain.id);
    const memberRowAfter = await db.conversationMember.findUniqueOrThrow({
      where: { conversationId_userId: { conversationId: ops.id, userId: plain.id } },
    });
    expect(memberRowAfter.id).toBe(memberRowBefore.id);
    expect(memberRowAfter.leftAt).not.toBeNull();
    expect(memberRowAfter.channelMuted).toBe(true);
    expect(
      await db.message.findUnique({ where: { id: plainMessage.id }, select: { id: true } }),
    ).not.toBeNull();
    // Removing an already-removed member reports wasMember: false.
    const removedAgain = await channels.removeMember(workspace.id, admin.id, ops.id, {
      userId: plain.id,
    });
    expect(removedAgain).toEqual({ removed: true, wasMember: false });

    // A removed/left human can no longer post or follow threads, and the preview reflects it.
    await expect(
      channels.send({
        workspaceId: workspace.id,
        userId: plain.id,
        channelId: ops.id,
        requestId: crypto.randomUUID(),
        body: "should be denied",
      }),
    ).rejects.toThrow("ACCESS_DENIED");
    await expect(
      channels.setUserThreadFollowed(workspace.id, plain.id, ops.id, plainMessage.id, true),
    ).rejects.toThrow("ACCESS_DENIED");
    const previewAfterRemoval = await channels.open(workspace.id, plain.id, ops.id);
    expect(previewAfterRemoval.senderMemberId).toBe("");
    await expect(channels.leave(workspace.id, plain.id, ops.id)).rejects.toThrow("ACCESS_DENIED");

    // Rejoining (self-service) clears leftAt on the same row and restores send access; the mute
    // preference survived the whole round trip.
    await channels.join(workspace.id, plain.id, ops.id);
    const memberRowRejoined = await db.conversationMember.findUniqueOrThrow({
      where: { conversationId_userId: { conversationId: ops.id, userId: plain.id } },
    });
    expect(memberRowRejoined.id).toBe(memberRowBefore.id);
    expect(memberRowRejoined.leftAt).toBeNull();
    expect(memberRowRejoined.channelMuted).toBe(true);
    const reopened = await channels.open(workspace.id, plain.id, ops.id);
    expect(reopened.senderMemberId).toBe(memberRowBefore.id);
    const resentMessage = await channels.send({
      workspaceId: workspace.id,
      userId: plain.id,
      channelId: ops.id,
      requestId: crypto.randomUUID(),
      body: "after rejoining",
    });
    expect(resentMessage.senderMemberId).toBe(memberRowBefore.id);

    // Owner/admin removes the Agent: it loses read access to the channel and receives no further
    // deliveries until re-added, at which point `leftAt` clears the same way a human's does.
    const removedAgent = await channels.removeMember(workspace.id, admin.id, ops.id, {
      agentId: agent.id,
    });
    expect(removedAgent).toEqual({ removed: true, wasMember: true });
    await expect(getAgentChannel(db, workspace.id, agent.id, "#ops")).rejects.toThrow(
      "ACCESS_DENIED",
    );
    published.length = 0;
    const afterAgentRemovalSend = await channels.send({
      workspaceId: workspace.id,
      userId: owner.id,
      channelId: ops.id,
      requestId: crypto.randomUUID(),
      body: "agent should not see this",
    });
    expect(published.some((delivery) => delivery.agentId === agent.id)).toBe(false);
    expect(
      await db.agentMessageDelivery.findFirst({
        where: { conversationId: ops.id, agentId: agent.id, messageId: afterAgentRemovalSend.id },
      }),
    ).toBeNull();

    await channels.addMembers(workspace.id, { userId: owner.id }, ops.id, {
      userIds: [],
      agentIds: [agent.id],
    });
    await getAgentChannel(db, workspace.id, agent.id, "#ops");
    published.length = 0;
    const afterAgentReadd = await channels.send({
      workspaceId: workspace.id,
      userId: owner.id,
      channelId: ops.id,
      requestId: crypto.randomUUID(),
      body: "agent is back",
    });
    expect(published.some((delivery) => delivery.agentId === agent.id)).toBe(true);
    expect(
      await db.agentMessageDelivery.findFirst({
        where: { conversationId: ops.id, agentId: agent.id, messageId: afterAgentReadd.id },
      }),
    ).not.toBeNull();
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.computer.deleteMany({ where: { ownerId: owner.id } });
    await db.user.deleteMany({ where: { id: { in: [owner.id, admin.id, plain.id] } } });
    await db.$disconnect();
    redis.close();
  }
});

test("Agent channel info exposes a bound Project (ADR 0026) scoped to the Agent's own Workspace; an unbound channel omits it, and another Workspace's Project never leaks", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID().slice(0, 8);
  const owner = await db.user.create({ data: { username: `pio${suffix}` } });
  const workspace = await db.workspace.create({
    data: {
      slug: `proj-info-${suffix}`,
      name: "Project channel info",
      members: { create: { userId: owner.id, role: "owner" } },
    },
  });
  const foreignWorkspace = await db.workspace.create({
    data: { slug: `proj-info-foreign-${suffix}`, name: "Foreign" },
  });
  try {
    const computer = await db.computer.create({
      data: { ownerId: owner.id, machineId: crypto.randomUUID() },
    });
    const agent = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: owner.id,
        computerId: computer.id,
        name: `piagent${suffix}`,
        displayName: "Agent",
        role: "member",
        runtimeConfig: {},
      },
    });
    await enrollGeneral(db, workspace.id);

    const boundProject = await db.project.create({
      data: {
        workspaceId: workspace.id,
        name: "Launch",
        slug: `launch-${suffix}`,
        githubFullName: "acme/launch",
        githubHtmlUrl: "https://github.com/acme/launch",
      },
    });
    const unboundProject = await db.project.create({
      data: { workspaceId: workspace.id, name: "Docs", slug: `docs-${suffix}` },
    });
    const foreignProject = await db.project.create({
      data: { workspaceId: foreignWorkspace.id, name: "Foreign", slug: `foreign-${suffix}` },
    });

    // A Project discussion group (ADR 0026): bound to `boundProject`, which itself has a
    // GitHub repository.
    const withGithub = await db.conversation.create({
      data: {
        workspaceId: workspace.id,
        channelName: `withgithub${suffix.slice(0, 6)}`,
        projectId: boundProject.id,
        members: { create: { agentId: agent.id } },
      },
    });
    // Bound to a Project with no GitHub repository.
    const noGithub = await db.conversation.create({
      data: {
        workspaceId: workspace.id,
        channelName: `nogithub${suffix.slice(0, 6)}`,
        projectId: unboundProject.id,
        members: { create: { agentId: agent.id } },
      },
    });
    // An ordinary channel: no Project at all.
    const plain = await db.conversation.create({
      data: {
        workspaceId: workspace.id,
        channelName: `plain${suffix.slice(0, 6)}`,
        members: { create: { agentId: agent.id } },
      },
    });
    // Data that should not be reachable through any authorized flow (`PublicChannels.create`
    // validates the Project's Workspace before assigning it): a channel whose `projectId` points
    // at another Workspace's Project. The server must still never surface it.
    const crossWorkspace = await db.conversation.create({
      data: {
        workspaceId: workspace.id,
        channelName: `cross${suffix.slice(0, 6)}`,
        projectId: foreignProject.id,
        members: { create: { agentId: agent.id } },
      },
    });

    const manage = new AgentChannelManagement(db, {
      snapshot: async () => {
        throw new Error("no live display data in this test");
      },
    });

    const withGithubInfo = await manage.info(workspace.id, agent.id, `#${withGithub.channelName}`);
    expect(withGithubInfo.project).toEqual({
      id: boundProject.id,
      name: "Launch",
      slug: `launch-${suffix}`,
      githubFullName: "acme/launch",
      githubHtmlUrl: "https://github.com/acme/launch",
    });

    const noGithubInfo = await manage.info(workspace.id, agent.id, `#${noGithub.channelName}`);
    expect(noGithubInfo.project).toEqual({
      id: unboundProject.id,
      name: "Docs",
      slug: `docs-${suffix}`,
    });

    const plainInfo = await manage.info(workspace.id, agent.id, `#${plain.channelName}`);
    expect(plainInfo.project).toBeUndefined();

    const crossWorkspaceInfo = await manage.info(
      workspace.id,
      agent.id,
      `#${crossWorkspace.channelName}`,
    );
    expect(crossWorkspaceInfo.project).toBeUndefined();
  } finally {
    await db.workspace.deleteMany({ where: { id: { in: [workspace.id, foreignWorkspace.id] } } });
    await db.computer.deleteMany({ where: { ownerId: owner.id } });
    await db.user.deleteMany({ where: { id: owner.id } });
    await db.$disconnect();
  }
});

test("channel unread (ADR 0046): list counts other-authored top-level messages past the cursor, markRead advances monotonically, threads never count, join/addMembers seed the cursor", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString)
    throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID();
  const alice = await db.user.create({ data: { username: `alice-${suffix}` } });
  const bob = await db.user.create({ data: { username: `bob-${suffix}` } });
  const workspace = await db.workspace.create({
    data: {
      slug: suffix,
      name: "Unread",
      members: { create: [{ userId: alice.id }, { userId: bob.id }] },
    },
  });
  try {
    await enrollGeneral(db, workspace.id);
    const redis = new RedisClient(Bun.env.CHANNEL_TEST_REDIS_URL!);
    const channels = new PublicChannels(db, new RedisMessageRequestIdempotency(redis), {
      publish: async () => {},
      publishJson: async () => {},
    });
    const engineering = await channels.create(workspace.id, alice.id, "unread-eng");

    // Joining seeds the cursor at the channel's current end: no backlog badge.
    await channels.join(workspace.id, alice.id, engineering.id);
    await channels.join(workspace.id, bob.id, engineering.id);
    const send = (userId: string, body: string, threadRootId?: string) =>
      channels.send({
        workspaceId: workspace.id,
        userId,
        channelId: engineering.id,
        body,
        requestId: crypto.randomUUID(),
        ...(threadRootId ? { threadRootId } : {}),
      });

    const root = await send(alice.id, "root from alice");
    // bob's view: alice's top-level message is unread; alice's own never is.
    let list = await channels.list(workspace.id, bob.id);
    expect(list.find((c) => c.id === engineering.id)?.unreadCount).toBe(1);
    list = await channels.list(workspace.id, alice.id);
    expect(list.find((c) => c.id === engineering.id)?.unreadCount).toBe(0);

    // A thread reply never adds channel unread for bob.
    await send(alice.id, "thread reply", root.id);
    list = await channels.list(workspace.id, bob.id);
    expect(list.find((c) => c.id === engineering.id)?.unreadCount).toBe(1);

    // A second top-level message bumps the count to 2.
    await send(alice.id, "second top-level");
    list = await channels.list(workspace.id, bob.id);
    expect(list.find((c) => c.id === engineering.id)?.unreadCount).toBe(2);

    // markRead clears it; a stale boundary cannot move the cursor backwards.
    await channels.markRead(workspace.id, bob.id, engineering.id, 10_000);
    list = await channels.list(workspace.id, bob.id);
    expect(list.find((c) => c.id === engineering.id)?.unreadCount).toBe(0);
    await send(alice.id, "third after read");
    await channels.markRead(workspace.id, bob.id, engineering.id, 1);
    list = await channels.list(workspace.id, bob.id);
    expect(list.find((c) => c.id === engineering.id)?.unreadCount).toBe(1);

    // A non-member has no unread badge even though history is readable.
    const carol = await db.user.create({ data: { username: `carol-${suffix}` } });
    await db.workspaceMembership.create({
      data: { workspaceId: workspace.id, userId: carol.id },
    });
    list = await channels.list(workspace.id, carol.id);
    expect(list.find((c) => c.id === engineering.id)?.joined).toBe(false);
    expect(list.find((c) => c.id === engineering.id)?.unreadCount).toBe(0);

    // A newly added member starts already-read: addMembers seeds the cursor at the end.
    await channels.addMembers(workspace.id, { userId: alice.id }, engineering.id, {
      userIds: [carol.id],
      agentIds: [],
    });
    list = await channels.list(workspace.id, carol.id);
    expect(list.find((c) => c.id === engineering.id)?.unreadCount).toBe(0);

    // Re-adding an already-active member is a no-op: it must not reset a cursor they had
    // advanced, or an admin re-running `channel add-member` would re-badge read history.
    await channels.markRead(workspace.id, carol.id, engineering.id, 10_000);
    await send(alice.id, "unread for carol");
    expect(
      (await channels.list(workspace.id, carol.id)).find((c) => c.id === engineering.id)
        ?.unreadCount,
    ).toBe(1);
    await channels.addMembers(workspace.id, { userId: alice.id }, engineering.id, {
      userIds: [carol.id],
      agentIds: [],
    });
    expect(
      (await channels.list(workspace.id, carol.id)).find((c) => c.id === engineering.id)
        ?.unreadCount,
    ).toBe(1);
  } finally {
    await db.workspace.deleteMany({ where: { id: workspace.id } });
    await db.user.deleteMany({ where: { id: { in: [alice.id, bob.id] } } });
    await db.$disconnect();
  }
});
