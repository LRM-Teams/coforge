import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import {
  PublicChannels,
  enrollGeneralChannel,
  getAgentChannel,
} from "#src/server/conversations/public-channels.server";
import { RedisClient } from "bun";
import { RedisMessageRequestIdempotency } from "#src/server/conversations/redis-message-request-idempotency.server";
import { PrismaWorkspaceCatalogStore } from "#src/server/workspaces/catalog.server";
import { PrismaWorkspaceEnrollmentStore } from "#src/server/workspaces/enrollment.server";
import { readAuthorizedAttachment } from "#src/server/attachments/attachment.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { decodeAgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import type { CentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import {
  executeAgentSendMessageWithPolicy,
  muteAgentChannel,
  readAgentMessages,
  unfollowAgentThread,
} from "#src/server/agents/agent-messages.server";
import { SendDirectMessage } from "#src/server/conversations/direct-message.server";
import { CentrifugoConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import { PrismaAgentRepository } from "#src/server/db/repositories/agent.repositories.server";
import { PrismaWebPushSubscriptionStore } from "#src/server/notifications/prisma-web-push-subscriptions.server";
import type { MessageWebPushNotification } from "#src/server/notifications/web-push-notifications.server";
import { ConversationHistory } from "#src/server/conversations/conversation-history.server";
import { AgentChannelManagement } from "#src/server/conversations/agent-channel-management.server";
import { TaskBoard } from "#src/server/tasks/task-board.server";
import { arrangeConversationPins } from "#src/server/conversations/conversation-pins.server";
import { isAppError } from "#src/lib/app-error";
import {
  MAX_THREAD_REFERENCES,
  storeMessageBody,
} from "#src/server/conversations/message-references.server";

/** Flattens every recipient's browser subscriptions, matching the earlier assertions this
 * suite made directly against `notificationForMessage`'s old flat `subscriptions` field. */
function subscriptionsOf(notification: MessageWebPushNotification | null) {
  return notification?.recipients.flatMap((recipient) => recipient.subscriptions) ?? [];
}

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
    await db.userPreference.createMany({
      data: [alice.id, bob.id].map((userId) => ({ userId, browserNotificationsEnabled: true })),
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
      requestId?: string;
    }> = [];
    const channels = new PublicChannels(
      db,
      new RedisMessageRequestIdempotency(redis),
      undefined,
      undefined,
      {
        async memberChanged() {},
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
        hidden: false,
        pinned: false,
        pinSortOrder: null,
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
    expect(subscriptionsOf(await pushSubscriptions.notificationForMessage(saved.id))).toEqual([]);
    expect(realtimeEvents).toContainEqual({
      conversationId: engineering.id,
      messageId: saved.id,
      sequence: saved.sequence,
      workspaceId: workspace.id,
      threadRootId: undefined,
      requestId,
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
    expect(subscriptionsOf(await pushSubscriptions.notificationForMessage(saved.id))).toEqual([]);
    const mutedOrdinary = await send(alice.id, "Muted ordinary message");
    expect(
      subscriptionsOf(await pushSubscriptions.notificationForMessage(mutedOrdinary.id)),
    ).toEqual([]);
    // notificationForRecipient shares the same recipient rule, narrowed to one already-known user
    // (the seam `getMessageNotification` reads): muted bob is not a recipient of the ordinary
    // message, and the sender is never their own recipient either.
    expect(await pushSubscriptions.notificationForRecipient(mutedOrdinary.id, bob.id)).toBeNull();
    expect(await pushSubscriptions.notificationForRecipient(mutedOrdinary.id, alice.id)).toBeNull();
    const mutedMention = await send(alice.id, `@${bob.username} please review this`);
    const mentionNotification = await pushSubscriptions.notificationForMessage(mutedMention.id);
    expect(subscriptionsOf(mentionNotification)).toEqual([
      expect.objectContaining({
        endpoint: `https://fcm.googleapis.com/wp/bob-${suffix}`,
      }),
    ]);
    // The target names the Chat tab: a member's own tab order can put another tab first.
    expect(mentionNotification?.url).toBe(
      `/notifications/open?workspace=${workspace.slug}&target=${encodeURIComponent(`/messages/channels/${engineering.id}?view=chat#message-${mutedMention.id}`)}`,
    );
    // An explicit @mention pierces the mute for notificationForRecipient too, with the same
    // title/body/url/tag/conversationPath the push payload carries.
    expect(await pushSubscriptions.notificationForRecipient(mutedMention.id, bob.id)).toEqual({
      title: mentionNotification!.title,
      body: mentionNotification!.body,
      url: mentionNotification!.url,
      tag: `message:${mutedMention.id}`,
      conversationPath: `/messages/channels/${engineering.id}`,
    });
    expect(await pushSubscriptions.notificationForRecipient(mutedMention.id, alice.id)).toBeNull();
    await channels.setUserMuted(workspace.id, bob.id, engineering.id, false);
    expect(subscriptionsOf(await pushSubscriptions.notificationForMessage(saved.id))).toEqual([
      expect.objectContaining({
        endpoint: `https://fcm.googleapis.com/wp/bob-${suffix}`,
      }),
    ]);
    await send(bob.id, "Hello Alice");
    const history = await channels.open(workspace.id, alice.id, engineering.id);
    // `senderName` is the display name a person reads (falling back to the username), not the
    // `@handle` — the handle travels beside it as `senderHandle`, which is what a mention types.
    expect(history.messages.map((m) => [m.sequence, m.senderName, m.senderHandle, m.body])).toEqual(
      [
        [1, alice.username, alice.username, "Hello Bob"],
        [2, alice.username, alice.username, "Muted ordinary message"],
        // A resolved mention is stored as an embedded-UUID token (PR #338) and carries a
        // MessageMention row; the browser renders the handle from that row, never by re-parsing
        // prose. `agentReadableBody` is what turns the token back into `@handle` for Agents.
        [3, alice.username, alice.username, `<@human:${bob.id}> please review this`],
        [4, bob.username, bob.username, "Hello Alice"],
      ],
    );
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
    // A jump lands on another member's message too (#740): for a channel, Workspace membership is
    // the whole access decision, so Bob opens the window around Alice's message and an outsider
    // is refused.
    expect(
      (
        await browserHistory.loadAround(workspace.id, bob.id, engineering.id, saved.id)
      ).messages.some((message) => message.id === saved.id),
    ).toBe(true);
    await expect(
      browserHistory.loadAround(workspace.id, outsider.id, engineering.id, saved.id),
    ).rejects.toThrow("ACCESS_DENIED");
    await expect(
      browserHistory.listOwnMessages(workspace.id, outsider.id, engineering.id),
    ).rejects.toThrow("ACCESS_DENIED");
    const latestPage = await channels.open(workspace.id, alice.id, engineering.id, { limit: 2 });
    expect(latestPage.hasOlder).toBe(true);
    // The initial (uncursored) page is the live tail: nothing newer to fetch.
    expect(latestPage.hasNewer).toBe(false);
    expect(latestPage.messages.map((message) => message.sequence)).toEqual([5, 6]);
    const olderPage = await channels.open(workspace.id, alice.id, engineering.id, {
      beforeSequence: 5,
      limit: 2,
    });
    expect(olderPage.hasOlder).toBe(true);
    // A backward page always has newer content above it, so the bounded window knows the tail it
    // retained is no longer the live end.
    expect(olderPage.hasNewer).toBe(true);
    expect(olderPage.messages.map((message) => message.sequence)).toEqual([3, 4]);
    // Reading back towards the live end from the retained page recovers the tail.
    const newerPage = await channels.open(workspace.id, alice.id, engineering.id, {
      afterSequence: 4,
      limit: 2,
    });
    expect(newerPage.hasOlder).toBe(true);
    expect(newerPage.hasNewer).toBe(false);
    expect(newerPage.messages.map((message) => message.sequence)).toEqual([5, 6]);
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
        // Workspace creation itself creates #general with its creator in it; reads never enroll.
        const createdGeneral = await db.conversation.findFirst({
          where: { workspaceId: id, channelName: "general" },
          include: { members: true },
        });
        expect(createdGeneral?.members.map((m) => m.userId)).toEqual([alice.id]);
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
      broadcast: async () => {},
    });
    const general = (await channels.list(workspace.id, user.id))[0]!;
    await db.userPreference.create({
      data: { userId: user.id, browserNotificationsEnabled: true },
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
        m.senderHandle,
        m.body,
        m.target,
      ]),
    ).toEqual([[user.username, "Ordinary conversation, no Agent requested.", "#general"]]);
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
    expect(pending.map((m) => [m.messageId, m.target, m.latestSenderHandle])).toEqual([
      [mentioned.id, "#general", user.username],
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
      broadcast: async () => {
        throw new Error("Agent reply must not publish");
      },
    };
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
      { repository: repo, sender: agentSender },
      {
        idempotencyKey: crypto.randomUUID(),
        workspaceId: workspace.id,
        agentId: agent.id,
        target: "#general",
        content: `@${user.username} this Agent reply should notify the mentioned human`,
        seenUpToSeq: ordinary.sequence,
      },
    );
    expect(reply.state).toBe("sent");
    expect(published.length).toBe(beforeReply);
    if (!reply.messageId) throw new Error("Agent reply did not return its message identity");
    expect(
      subscriptionsOf(
        await new PrismaWebPushSubscriptionStore(db).notificationForMessage(reply.messageId),
      ),
    ).toEqual([
      expect.objectContaining({
        endpoint: `https://fcm.googleapis.com/wp/agent-mention-${workspace.id}`,
      }),
    ]);
    const opened = await channels.open(workspace.id, user.id, general.id);
    expect(opened.messages.at(-1)).toMatchObject({
      senderKind: "agent",
      senderName: "Helper",
      senderHandle: "helper",
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
    // Creating a public Agent puts it in #general. Joining late opens the history to it, while
    // delivery (below) covers only what is sent afterwards.
    expect(await repo.readPendingAgentDeliveries(workspace.id, second.id)).toEqual([]);
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
      broadcast: async () => {},
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
    expect<string | undefined>(
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
    // Eligibility for Agent attention rests on the delivery row, not on the sender's kind, so an
    // Agent-authored handoff is admitted here and every Agent-facing projection names its author.
    expect(
      (await repo.readPendingAgentDeliveries(workspace.id, scout.id)).find(
        (message) => message.messageId === handoff.id,
      ),
    ).toMatchObject({
      latestSenderKind: "agent",
      latestSenderHandle: "helper",
      target: "#general",
    });
    expect(
      (await repo.readAgentRecoveryContext(workspace.id, scout.id)).resumeMessages.find(
        (message) => message.messageId === handoff.id,
      ),
    ).toMatchObject({
      latestSenderKind: "agent",
      latestSenderHandle: "helper",
      target: "#general",
    });
    expect(
      (await repo.readPendingAgentContext(workspace.id, scout.id, "#general", 0)).find(
        (message) => message.id === handoff.id,
      ),
    ).toMatchObject({ senderKind: "agent", senderHandle: "helper", target: "#general" });
    expect<string | undefined>(
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

test("a #channel reference is stored as a channel token on every send path, and every Agent-facing body reads it as #name", async () => {
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
      name: "Channel references",
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
    await enrollGeneral(db, workspace.id);
    // Every body published to a daemon, decoded as the daemon reads it.
    const published: ReturnType<typeof decodeAgentMessageDelivery>[] = [];
    const centrifugo = {
      publish: async (_channel: string, payload: Uint8Array) => {
        published.push(decodeAgentMessageDelivery(payload));
      },
      publishJson: async () => {},
      broadcast: async () => {},
    };
    const channels = new PublicChannels(db, new RedisMessageRequestIdempotency(redis), centrifugo);
    const general = (await channels.list(workspace.id, user.id))[0]!;
    const product = await channels.create(workspace.id, user.id, "product");
    const productToken = `<@channel:${product.id}:product>`;
    const repo = new PrismaDirectConversationRepository(db);
    const sender = new SendDirectMessage(
      repo,
      new RedisMessageRequestIdempotency(redis),
      centrifugo,
    );
    const publishedBody = (messageId: string) =>
      published.find((delivery) => delivery.messageId === messageId)?.body;

    // A human channel message: the channel reference is stored as a token next to the mention
    // token; an unknown name, a code span and a thread reference stay as written.
    const typed = "@helper see #Product and #nope, `#product`, #product:deadbeef";
    const readable = "@helper see #product and #nope, `#product`, #product:deadbeef";
    const human = await channels.send({
      workspaceId: workspace.id,
      userId: user.id,
      channelId: general.id,
      requestId: crypto.randomUUID(),
      body: typed,
    });
    expect(human.body).toBe(
      `<@agent:${helper.id}> see ${productToken} and #nope, \`#product\`, #product:deadbeef`,
    );
    // Every body that reaches the daemon or the Agent's CLI reads `#product`, never the token.
    expect(publishedBody(human.id)).toBe(readable);
    const bodyOf = (messages: readonly { id?: string; messageId?: string; body: string }[]) =>
      messages.find((message) => (message.id ?? message.messageId) === human.id)?.body;
    // The unread readers first: draining the events advances the Agent's read boundary.
    expect(bodyOf(await repo.readPendingAgentDeliveries(workspace.id, helper.id))).toBe(readable);
    expect(
      bodyOf((await repo.readAgentRecoveryContext(workspace.id, helper.id)).resumeMessages),
    ).toBe(readable);
    expect(bodyOf(await repo.readPendingAgentContext(workspace.id, helper.id, "#general", 0))).toBe(
      readable,
    );
    expect(bodyOf((await repo.drainAgentEvents(workspace.id, helper.id)).messages)).toBe(readable);
    expect(
      bodyOf(await repo.readMessages(workspace.id, helper.id, "#general", { around: human.id })),
    ).toBe(readable);
    // The token keeps the channel's name, so a body search for the name still finds the message.
    expect(bodyOf(await repo.searchMessages(workspace.id, helper.id, { query: "product" }))).toBe(
      readable,
    );
    expect<string>((await repo.resolveAgentMessage(workspace.id, helper.id, human.id)).body).toBe(
      readable,
    );

    // A quote that spans lines keeps its references, and its mention wakes the Agent as before.
    const quote = await channels.send({
      workspaceId: workspace.id,
      userId: user.id,
      channelId: general.id,
      requestId: crypto.randomUUID(),
      body: "> **Ada** 10:00:\n> @helper see #product\n\nagreed",
    });
    expect(quote.body).toBe(
      `> **Ada** 10:00:\n> <@agent:${helper.id}> see ${productToken}\n\nagreed`,
    );
    expect(
      (await db.agentMessageDelivery.findMany({ where: { messageId: quote.id } })).map(
        (row) => row.agentId,
      ),
    ).toEqual([helper.id]);
    expect(publishedBody(quote.id)).toBe("> **Ada** 10:00:\n> @helper see #product\n\nagreed");

    // A token the sender typed is stored as typed: it is a claim every consumer checks (the web
    // links a channel only when the Workspace has its id), and an Agent reads it as plain text.
    const forgedChannel = crypto.randomUUID();
    const forged = await channels.send({
      workspaceId: workspace.id,
      userId: user.id,
      channelId: general.id,
      requestId: crypto.randomUUID(),
      body: `see <@channel:${forgedChannel}:evil> and <@task:9>`,
    });
    expect(forged.body).toBe(`see <@channel:${forgedChannel}:evil> and <@task:9>`);
    expect(publishedBody(forged.id)).toBe("see #evil and task #9");

    // An Agent channel message.
    const fromAgent = await sender.executeFromAgent({
      requestId: crypto.randomUUID(),
      workspaceId: workspace.id,
      agentId: helper.id,
      target: "#general",
      body: "moving this to #product",
    });
    expect(fromAgent.body).toBe(`moving this to ${productToken}`);
    // Push bodies read the same way.
    expect(
      (await new PrismaWebPushSubscriptionStore(db).notificationForMessage(fromAgent.id))?.body,
    ).toBe("@helper: moving this to #product");
    // A Task converted from that message shows its title as text in the view Agents read.
    const converted = await new TaskBoard(db).execute(
      { workspaceId: workspace.id, agentId: helper.id },
      {
        operation: "convert",
        idempotencyKey: crypto.randomUUID(),
        target: "#general",
        messageId: fromAgent.id,
      },
    );
    expect(converted.tasks[0]?.title).toBe("moving this to #product");
    // A converted title carrying a mention token reads it back through the message's mention row.
    const convertedHuman = await new TaskBoard(db).execute(
      { workspaceId: workspace.id, agentId: helper.id },
      {
        operation: "convert",
        idempotencyKey: crypto.randomUUID(),
        target: "#general",
        messageId: human.id,
      },
    );
    expect(convertedHuman.tasks[0]?.title).toBe(readable);

    // A bare `#N` naming a task of this channel is stored as the task token and reads back as
    // `task #N`; a number naming no task here, one beyond any task number, and a `#N` inside code
    // stay as written.
    const taskNumber = converted.tasks[0]!.number;
    const bareTyped = `see #${taskNumber}, not #${taskNumber + 100} or #99999999999 or \`#${taskNumber}\``;
    const bare = await channels.send({
      workspaceId: workspace.id,
      userId: user.id,
      channelId: general.id,
      requestId: crypto.randomUUID(),
      body: bareTyped,
    });
    expect(bare.body).toBe(
      `see <@task:${taskNumber}>, not #${taskNumber + 100} or #99999999999 or \`#${taskNumber}\``,
    );
    expect(publishedBody(bare.id)).toBe(
      `see task #${taskNumber}, not #${taskNumber + 100} or #99999999999 or \`#${taskNumber}\``,
    );
    // The same from an Agent, and in a task's own channel only: the DM below has no such task.
    const bareFromAgent = await sender.executeFromAgent({
      requestId: crypto.randomUUID(),
      workspaceId: workspace.id,
      agentId: helper.id,
      target: "#general",
      body: `picking up #${taskNumber}`,
    });
    expect(bareFromAgent.body).toBe(`picking up <@task:${taskNumber}>`);

    // A human DM to the Agent: stored as a token, published to the daemon as text.
    const opened = await repo.openForUser(workspace.id, user.id, helper.id);
    const dm = await sender.execute({
      requestId: crypto.randomUUID(),
      workspaceId: workspace.id,
      conversationId: opened.conversationId,
      senderMemberId: opened.senderMemberId,
      senderUserId: user.id,
      body: `check #product and #${taskNumber}`,
    });
    expect(dm.body).toBe(`check ${productToken} and #${taskNumber}`);
    expect(publishedBody(dm.id)).toBe(`check #product and #${taskNumber}`);

    // An Agent DM reply.
    const reply = await sender.executeFromAgent({
      requestId: crypto.randomUUID(),
      workspaceId: workspace.id,
      agentId: helper.id,
      target: `@${user.username}`,
      body: "done in #product",
    });
    expect(reply.body).toBe(`done in ${productToken}`);
    expect<string | undefined>(
      (await repo.readMessages(workspace.id, helper.id, `@${user.username}`)).find(
        (message) => message.id === reply.id,
      )?.body,
    ).toBe("done in #product");
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.computer.deleteMany({ where: { ownerId: user.id } });
    await db.user.delete({ where: { id: user.id } });
    await db.$disconnect();
    redis.close();
  }
});

test("a body's thread references are read in one query per channel, and only the first MAX_THREAD_REFERENCES of them", async () => {
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
      name: "Thread reference reads",
      members: { create: { userId: user.id } },
    },
  });
  try {
    await enrollGeneral(db, workspace.id);
    const channels = new PublicChannels(db, new RedisMessageRequestIdempotency(redis), {
      publish: async () => {},
      publishJson: async () => {},
      broadcast: async () => {},
    });
    const general = (await channels.list(workspace.id, user.id))[0]!;
    const product = await channels.create(workspace.id, user.id, "product");
    const random = await channels.create(workspace.id, user.id, "random");
    let sequence = 1_000_000;
    const createRoot = async (conversationId: string, id = crypto.randomUUID()) =>
      (
        await db.message.create({
          data: {
            id,
            conversationId,
            workspaceId: workspace.id,
            body: "root",
            sequence: sequence++,
          },
        })
      ).id;
    // Six roots in #product, two more sharing a six-hex prefix, one root in #random.
    const productRoots = await Promise.all(Array.from({ length: 6 }, () => createRoot(product.id)));
    const prefix = crypto.randomUUID().slice(0, 6);
    await createRoot(product.id, `${prefix}00-0000-4000-8000-000000000000`);
    await createRoot(product.id, `${prefix}ff-0000-4000-8000-000000000001`);
    const randomRoot = await createRoot(random.id);
    const token = (channel: { id: string }, name: string, root: string) =>
      `<@thread:${channel.id}:${root}:${name}>`;

    /** `storeMessageBody` in a transaction whose message reads are counted. */
    const store = (body: string) =>
      db.$transaction(async (tx) => {
        const reads: unknown[] = [];
        const counted = {
          task: tx.task,
          conversation: tx.conversation,
          message: {
            findMany: (args: Parameters<typeof tx.message.findMany>[0]) => {
              reads.push(args);
              return tx.message.findMany(args);
            },
          },
        } as unknown as Parameters<typeof storeMessageBody>[0];
        const stored = await storeMessageBody(
          counted,
          { workspaceId: workspace.id, conversationId: general.id },
          body,
          { targets: [] },
        );
        return { body: stored.body, reads: reads.length };
      });

    // References into two channels take one read each, however many there are; a prefix two
    // messages share, read in the same batch, still names nothing.
    const [first] = productRoots;
    const mixed = await store(
      [
        `#product:${first!.slice(0, 8)}`,
        `#product:${prefix}`,
        `#product:${first!.slice(0, 6)}`,
        `#random:${randomRoot.slice(0, 7)}`,
        `#random:${randomRoot}`,
        "#nope:abcdef12",
      ].join(" "),
    );
    expect(mixed.body).toBe(
      [
        token(product, "product", first!),
        `#product:${prefix}`,
        token(product, "product", first!),
        token(random, "random", randomRoot),
        token(random, "random", randomRoot),
        "#nope:abcdef12",
      ].join(" "),
    );
    expect(mixed.reads).toBe(2);

    // Twenty-four distinct references: the first MAX_THREAD_REFERENCES resolve, the rest stay text.
    const spellings = productRoots.flatMap((root) => [
      `#product:${root.slice(0, 6)}`,
      `#product:${root.slice(0, 7)}`,
      `#product:${root.slice(0, 8)}`,
      `#product:${root}`,
    ]);
    expect(spellings.length).toBeGreaterThan(MAX_THREAD_REFERENCES);
    const capped = await store(spellings.join(" "));
    expect(capped.body).toBe(
      spellings
        .map((written, index) =>
          index < MAX_THREAD_REFERENCES
            ? token(product, "product", productRoots[Math.floor(index / 4)]!)
            : written,
        )
        .join(" "),
    );
    expect(capped.reads).toBe(1);
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.delete({ where: { id: user.id } });
    await db.$disconnect();
    redis.close();
  }
});

test("a #name:shortid naming a channel thread is stored as a thread token, and every Agent-facing body reads it as a thread target", async () => {
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
      name: "Thread references",
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
    await enrollGeneral(db, workspace.id);
    const published: ReturnType<typeof decodeAgentMessageDelivery>[] = [];
    const centrifugo = {
      publish: async (_channel: string, payload: Uint8Array) => {
        published.push(decodeAgentMessageDelivery(payload));
      },
      publishJson: async () => {},
      broadcast: async () => {},
    };
    const channels = new PublicChannels(db, new RedisMessageRequestIdempotency(redis), centrifugo);
    const general = (await channels.list(workspace.id, user.id))[0]!;
    const product = await channels.create(workspace.id, user.id, "product");
    const repo = new PrismaDirectConversationRepository(db);
    const sender = new SendDirectMessage(
      repo,
      new RedisMessageRequestIdempotency(redis),
      centrifugo,
    );
    const send = (channelId: string, body: string, threadRootId?: string) =>
      channels.send({
        workspaceId: workspace.id,
        userId: user.id,
        channelId,
        requestId: crypto.randomUUID(),
        body,
        threadRootId,
      });
    const publishedBody = (messageId: string) =>
      published.find((delivery) => delivery.messageId === messageId)?.body;

    // A thread root in #product, a reply in it, and two top-level messages whose ids share their
    // first six hex characters.
    const root = await send(product.id, "launch plan");
    const reply = await send(product.id, "first reply", root.id);
    const prefix = crypto.randomUUID().slice(0, 6);
    for (const [index, tail] of ["00", "ff"].entries())
      await db.message.create({
        data: {
          id: `${prefix}${tail}-0000-4000-8000-00000000000${index}`,
          conversationId: product.id,
          workspaceId: workspace.id,
          body: `twin ${index}`,
          sequence: 1_000_000 + index,
        },
      });
    const short = root.id.slice(0, 8);
    const token = `<@thread:${product.id}:${root.id}:product>`;
    const target = `#product:${short}`;

    // Every spelling of the root resolves: eight, seven or six hex characters, the whole id, any
    // case. A reply's id, a prefix two messages share, an unknown channel and code stay as written,
    // and none of them is read as a `#product` channel reference.
    const typed = [
      `@helper see #product:${short},`,
      `#PRODUCT:${root.id.slice(0, 7).toUpperCase()},`,
      `#product:${root.id.slice(0, 6)} and 看#product:${root.id}的讨论;`,
      `not #product:${reply.id.slice(0, 8)}, #product:${prefix}, #nope:${short} or \`#product:${short}\``,
    ].join(" ");
    const human = await send(general.id, typed);
    expect(human.body).toBe(
      [
        `<@agent:${helper.id}> see ${token},`,
        `${token},`,
        `${token} and 看${token}的讨论;`,
        `not #product:${reply.id.slice(0, 8)}, #product:${prefix}, #nope:${short} or \`#product:${short}\``,
      ].join(" "),
    );
    const readable = [
      `@helper see ${target},`,
      `${target},`,
      `${target} and 看${target}的讨论;`,
      `not #product:${reply.id.slice(0, 8)}, #product:${prefix}, #nope:${short} or \`#product:${short}\``,
    ].join(" ");

    // Every body that reaches the daemon or the Agent's CLI reads `#product:<8 hex>`.
    expect(publishedBody(human.id)).toBe(readable);
    const bodyOf = (messages: readonly { id?: string; messageId?: string; body: string }[]) =>
      messages.find((message) => (message.id ?? message.messageId) === human.id)?.body;
    expect(bodyOf(await repo.readPendingAgentDeliveries(workspace.id, helper.id))).toBe(readable);
    expect(
      bodyOf((await repo.readAgentRecoveryContext(workspace.id, helper.id)).resumeMessages),
    ).toBe(readable);
    expect(bodyOf(await repo.readPendingAgentContext(workspace.id, helper.id, "#general", 0))).toBe(
      readable,
    );
    expect(bodyOf((await repo.drainAgentEvents(workspace.id, helper.id)).messages)).toBe(readable);
    expect(
      bodyOf(await repo.readMessages(workspace.id, helper.id, "#general", { around: human.id })),
    ).toBe(readable);
    expect(bodyOf(await repo.searchMessages(workspace.id, helper.id, { query: "product" }))).toBe(
      readable,
    );
    expect<string>((await repo.resolveAgentMessage(workspace.id, helper.id, human.id)).body).toBe(
      readable,
    );

    // An Agent writes one the same way, and can reply to the thread by the target it read.
    const fromAgent = await sender.executeFromAgent({
      requestId: crypto.randomUUID(),
      workspaceId: workspace.id,
      agentId: helper.id,
      target: "#general",
      body: `details in ${target}`,
    });
    expect(fromAgent.body).toBe(`details in ${token}`);
    await db.conversationMember.create({
      data: { workspaceId: workspace.id, conversationId: product.id, agentId: helper.id },
    });
    const threadReply = await sender.executeFromAgent({
      requestId: crypto.randomUUID(),
      workspaceId: workspace.id,
      agentId: helper.id,
      target,
      body: "on it",
    });
    expect(
      (await db.message.findUniqueOrThrow({ where: { id: threadReply.id } })).threadRootId,
    ).toBe(root.id);

    // A DM resolves a channel thread too.
    const opened = await repo.openForUser(workspace.id, user.id, helper.id);
    const dm = await sender.execute({
      requestId: crypto.randomUUID(),
      workspaceId: workspace.id,
      conversationId: opened.conversationId,
      senderMemberId: opened.senderMemberId,
      senderUserId: user.id,
      body: `look at ${target}`,
    });
    expect(dm.body).toBe(`look at ${token}`);
    expect(publishedBody(dm.id)).toBe(`look at ${target}`);

    // After a rename, an Agent still reads the name the message was sent with.
    await db.conversation.update({ where: { id: product.id }, data: { channelName: "launch" } });
    expect<string>(
      (await repo.resolveAgentMessage(workspace.id, helper.id, fromAgent.id)).body,
    ).toBe(`details in ${target}`);
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
      broadcast: async () => {},
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
    await db.userPreference.create({
      data: { userId: bob.id, browserNotificationsEnabled: true },
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
      subscriptionsOf(await pushSubscriptions.notificationForMessage(followerNotice.id)),
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
      subscriptionsOf(await pushSubscriptions.notificationForMessage(unfollowedNotice.id)),
    ).toEqual([]);

    // An Agent's first reply enrolls the root author, while a later reply respects that author's
    // explicit unfollow just as the human send path does.
    const agentOnlyRoot = await channels.send({
      workspaceId: workspace.id,
      userId: alice.id,
      channelId: general.id,
      requestId: crypto.randomUUID(),
      body: "agent-only root",
    });
    await repo.sendAgentMessage(
      general.id,
      agent.id,
      "first Agent reply",
      undefined,
      agentOnlyRoot.id.slice(0, 8),
    );
    const aliceMember = await db.conversationMember.findFirstOrThrow({
      where: { conversationId: general.id, userId: alice.id },
      select: { id: true },
    });
    expect(
      await db.threadFollow.findUnique({
        where: {
          memberId_rootMessageId: {
            memberId: aliceMember.id,
            rootMessageId: agentOnlyRoot.id,
          },
        },
      }),
    ).not.toBeNull();
    await channels.setUserThreadFollowed(
      workspace.id,
      alice.id,
      general.id,
      agentOnlyRoot.id,
      false,
    );
    await repo.sendAgentMessage(
      general.id,
      agent.id,
      "second Agent reply",
      undefined,
      agentOnlyRoot.id.slice(0, 8),
    );
    expect(
      await db.threadFollow.findUnique({
        where: {
          memberId_rootMessageId: {
            memberId: aliceMember.id,
            rootMessageId: agentOnlyRoot.id,
          },
        },
      }),
    ).toBeNull();
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
        hidden: false,
        pinned: false,
        pinSortOrder: null,
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
          hidden: false,
          pinned: false,
          pinSortOrder: null,
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
      broadcast: async () => {},
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
    // membership — "a server admin without membership can still archive".
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

    // Authority (Slack's default): any Agent that belongs to the Workspace may
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
    // #eng's creator — neither is #general, so both bases are reported.
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

    // Update requires admin authority (channel-aware) and at least one field; general
    // is reserved. `member` is #eng's creator, so it is itself a channel admin now (channelRole
    // "admin") — `outsiderAgent` (never a member, plain `Agent.role`) exercises the plain
    // denial instead.
    await expect(
      manage.update(workspace.id, outsiderAgent.id, "#eng", { name: "x" }),
    ).rejects.toThrow("this Agent's owner lacks admin authority for update");
    // Positive path for the OTHER basis (`channel_role`): #eng's creator may update
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
    // The composer's `#` list still offers an archived channel, with its description and flag.
    expect(
      (await new PublicChannels(db).names(workspace.id, owner.id)).find(
        (channel) => channel.name === "eng",
      ),
    ).toEqual({ id: expect.any(String), name: "eng", description: "Eng team", archived: true });
    await expect(manage.join(workspace.id, admin.id, "#eng")).rejects.toThrow(
      "channel is archived",
    );
    await manage.setArchived(workspace.id, admin.id, "#eng", false);
    expect((await manage.info(workspace.id, admin.id, "#eng")).archived).toBe(false);

    // `server_role` basis needs no membership at all: a server admin who never joined #eng can
    // still archive/unarchive it.
    const nonMemberArchived = await manage.setArchived(
      workspace.id,
      nonMemberServerAdmin.id,
      "#eng",
      true,
    );
    expect(nonMemberArchived).toEqual({ target: "#eng", archived: true });
    await manage.setArchived(workspace.id, nonMemberServerAdmin.id, "#eng", false);

    // add-member (Slack's default): the acting Agent must itself already be an
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

test("Channel roles: creator is channel admin, a plain member cannot archive, promote/demote via setChannelRole, server admin without membership, #general's roles are fixed", async () => {
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
      broadcast: async () => {},
    });
    await enrollGeneral(db, workspace.id);

    // The creator is the channel's own admin: `channelRole` "admin", basis
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
    // A server admin edits #general's description (never its name) and nothing else.
    expect(generalServerAdminView.channelCapabilities).toMatchObject({
      update: true,
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
      broadcast: async () => {},
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
    expect(generalMembers.channelCapabilities.leave).toBe(false);
    expect(generalMembers.canRemoveMembers).toBe(false);

    // A plain member cannot remove anyone.
    await expect(
      channels.removeMember(workspace.id, plain.id, ops.id, { userId: admin.id }),
    ).rejects.toThrow("ACCESS_DENIED");
    const opsMembersAsPlain = await channels.members(workspace.id, { userId: plain.id }, ops.id);
    expect(opsMembersAsPlain.canRemoveMembers).toBe(false);
    expect(opsMembersAsPlain.channelCapabilities.leave).toBe(true);
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

test("Agent channel info exposes a bound Project scoped to the Agent's own Workspace; an unbound channel omits it, and another Workspace's Project never leaks", async () => {
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

    // A Project discussion group: bound to `boundProject`, which itself has a
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

test("channel unread: list counts other-authored top-level messages past the cursor, markRead advances monotonically, threads never count, join/addMembers seed the cursor", async () => {
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
      broadcast: async () => {},
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

test("a thread's root author starts following that thread, so later replies reach them", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const redis = new RedisClient(Bun.env.CHANNEL_TEST_REDIS_URL!);
  const suffix = crypto.randomUUID();
  const alice = await db.user.create({ data: { username: `ra${suffix.slice(0, 8)}` } });
  const bob = await db.user.create({ data: { username: `rb${suffix.slice(0, 8)}` } });
  const workspace = await db.workspace.create({
    data: {
      slug: `root-follow-${suffix}`,
      name: "Root author follow",
      members: { create: [{ userId: alice.id }, { userId: bob.id }] },
    },
  });
  try {
    const channels = new PublicChannels(db, new RedisMessageRequestIdempotency(redis), {
      publish: async () => {},
      publishJson: async () => {},
      broadcast: async () => {},
    });
    const channel = await channels.create(workspace.id, alice.id, "rootfollow");
    await channels.join(workspace.id, bob.id, channel.id);

    const root = await channels.send({
      workspaceId: workspace.id,
      userId: alice.id,
      channelId: channel.id,
      requestId: crypto.randomUUID(),
      body: "root by alice",
    });
    const followed = async (userId: string) => {
      const member = await db.conversationMember.findUniqueOrThrow({
        where: { conversationId_userId: { conversationId: channel.id, userId } },
        select: { id: true },
      });
      return db.threadFollow.findUnique({
        where: { memberId_rootMessageId: { memberId: member.id, rootMessageId: root.id } },
      });
    };
    // A top-level root message on its own enrolls nobody: replies are what make a thread.
    expect(await followed(alice.id)).toBeNull();

    await channels.send({
      workspaceId: workspace.id,
      userId: bob.id,
      channelId: channel.id,
      requestId: crypto.randomUUID(),
      body: "reply by bob",
      threadRootId: root.id,
    });

    // The replier follows the thread, and so does the author of the message being replied to:
    // without that second enrollment a reply under someone's own message would never reach them,
    // because a thread reply is not a parent-channel post and notifies followers only.
    expect(await followed(bob.id)).not.toBeNull();
    expect(await followed(alice.id)).not.toBeNull();

    // An explicit unfollow is a decision: a later reply must not silently re-enroll the root
    // author back into the thread.
    await channels.setUserThreadFollowed(workspace.id, alice.id, channel.id, root.id, false);
    await channels.send({
      workspaceId: workspace.id,
      userId: bob.id,
      channelId: channel.id,
      requestId: crypto.randomUUID(),
      body: "second reply by bob",
      threadRootId: root.id,
    });
    expect(await followed(alice.id)).toBeNull();
  } finally {
    await db.workspace.deleteMany({ where: { id: workspace.id } });
    await db.user.deleteMany({ where: { id: { in: [alice.id, bob.id] } } });
    await db.$disconnect();
  }
});

test("an Agent's thread reply enrolls exactly the members its stored mention rows name; an @handle in code or a link label enrolls nobody", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const redis = new RedisClient(Bun.env.CHANNEL_TEST_REDIS_URL!);
  const suffix = crypto.randomUUID().slice(0, 8);
  const alice = await db.user.create({ data: { username: `ea${suffix}` } });
  const bob = await db.user.create({ data: { username: `eb${suffix}` } });
  const carol = await db.user.create({ data: { username: `ec${suffix}` } });
  const workspace = await db.workspace.create({
    data: {
      slug: `agent-enroll-${suffix}`,
      name: "Agent reply enrollment",
      members: {
        create: [{ userId: alice.id, role: "owner" }, { userId: bob.id }, { userId: carol.id }],
      },
    },
  });
  try {
    const helper = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: alice.id,
        name: "helper",
        displayName: "Helper",
        runtimeConfig: {},
      },
    });
    await enrollGeneral(db, workspace.id);
    const channels = new PublicChannels(db, new RedisMessageRequestIdempotency(redis), {
      publish: async () => {},
      publishJson: async () => {},
      broadcast: async () => {},
    });
    const repo = new PrismaDirectConversationRepository(db);
    const general = (await channels.list(workspace.id, alice.id))[0]!;
    const root = await channels.send({
      workspaceId: workspace.id,
      userId: alice.id,
      channelId: general.id,
      requestId: crypto.randomUUID(),
      body: "root by alice",
    });
    const reply = await repo.sendAgentMessage(
      general.id,
      helper.id,
      `@${bob.username} please look; not \`@${carol.username}\` or [ask @${carol.username}](https://example.com)`,
      undefined,
      root.id.slice(0, 8),
    );
    const followers = await db.threadFollow.findMany({
      where: { rootMessageId: root.id },
      select: { member: { select: { userId: true, agentId: true } } },
    });
    // The reply's mention rows name bob alone, and enrollment follows them: the replying Agent,
    // the root author (first reply) and bob. Carol, written only in code and in a link label,
    // is no mention and no follower.
    expect(
      (await db.messageMention.findMany({ where: { messageId: reply.id } })).map(
        (mention) => mention.actorId,
      ),
    ).toEqual([bob.id]);
    expect(followers.map(({ member }) => member.userId ?? member.agentId).sort()).toEqual(
      [alice.id, bob.id, helper.id].sort(),
    );
  } finally {
    await db.workspace.deleteMany({ where: { id: workspace.id } });
    await db.user.deleteMany({ where: { id: { in: [alice.id, bob.id, carol.id] } } });
    await db.$disconnect();
    redis.close();
  }
});

test("a channel member can list and unfollow Agents following a thread; a private Agent is never a channel follower", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const redis = new RedisClient(Bun.env.CHANNEL_TEST_REDIS_URL!);
  const suffix = crypto.randomUUID().slice(0, 8);
  const alice = await db.user.create({ data: { username: `fa${suffix}` } });
  const bob = await db.user.create({ data: { username: `fb${suffix}` } });
  const workspace = await db.workspace.create({
    data: {
      slug: `follow-agents-${suffix}`,
      name: "Following agents",
      members: {
        create: [{ userId: alice.id, role: "owner" }, { userId: bob.id }],
      },
    },
  });
  try {
    const computer = await db.computer.create({
      data: { ownerId: alice.id, machineId: crypto.randomUUID() },
    });
    const helper = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: alice.id,
        computerId: computer.id,
        name: "helper",
        displayName: "Helper",
        runtimeConfig: {},
      },
    });
    // A private Agent is never an active channel member — not even in #general. It
    // cannot be @mentioned there (mentions resolve against active members), is never delivered a
    // channel reply, and so never becomes a thread follower. Only the public `helper` can appear
    // in any follower list below; `scout` is here to prove it stays absent even for its creator.
    const scout = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: alice.id,
        computerId: computer.id,
        name: "scout",
        displayName: "Scout",
        visibility: "private",
        runtimeConfig: {},
      },
    });
    await enrollGeneral(db, workspace.id);
    const channels = new PublicChannels(db, new RedisMessageRequestIdempotency(redis), {
      publish: async () => {},
      publishJson: async () => {},
      broadcast: async () => {},
    });
    const general = (await channels.list(workspace.id, alice.id))[0]!;
    // The membership rule, pinned directly, so the absences below have one named cause:
    // #general enrolls every public Agent and no private one.
    expect(
      (
        await db.conversationMember.findMany({
          where: { conversationId: general.id, agentId: { in: [helper.id, scout.id] } },
          select: { agentId: true },
        })
      ).map((member) => member.agentId),
    ).toEqual([helper.id]);
    const root = await channels.send({
      workspaceId: workspace.id,
      userId: alice.id,
      channelId: general.id,
      requestId: crypto.randomUUID(),
      body: "please both take this",
    });
    await channels.send({
      workspaceId: workspace.id,
      userId: alice.id,
      channelId: general.id,
      requestId: crypto.randomUUID(),
      body: "@helper @scout please follow",
      threadRootId: root.id,
    });

    const aliceView = await channels.threadFollowingAgents(
      workspace.id,
      alice.id,
      general.id,
      root.id,
    );
    expect(aliceView.canUnfollow).toBe(true);
    expect(aliceView.agents.map((agent) => agent.id)).toEqual([helper.id]);

    const bobView = await channels.threadFollowingAgents(workspace.id, bob.id, general.id, root.id);
    expect(bobView.canUnfollow).toBe(true);
    expect(bobView.agents.map((agent) => agent.id)).toEqual([helper.id]);

    await expect(
      channels.unfollowAgentFromThread(workspace.id, bob.id, general.id, root.id, scout.id),
    ).rejects.toThrow("NOT_FOUND");

    await db.conversationMember.update({
      where: { conversationId_userId: { conversationId: general.id, userId: bob.id } },
      data: { leftAt: new Date() },
    });
    const leftView = await channels.threadFollowingAgents(
      workspace.id,
      bob.id,
      general.id,
      root.id,
    );
    expect(leftView.canUnfollow).toBe(false);
    expect(leftView.agents.map((agent) => agent.id)).toEqual([helper.id]);
    await expect(
      channels.unfollowAgentFromThread(workspace.id, bob.id, general.id, root.id, helper.id),
    ).rejects.toThrow("ACCESS_DENIED");

    expect(
      await channels.unfollowAgentFromThread(
        workspace.id,
        alice.id,
        general.id,
        root.id,
        helper.id,
      ),
    ).toEqual({ followed: false });
    // `helper` was the only follower alice could see (see the membership-rule note above), so
    // unfollowing it leaves the list empty — the private `scout` is not a hidden fallback.
    expect(
      (
        await channels.threadFollowingAgents(workspace.id, alice.id, general.id, root.id)
      ).agents.map((agent) => agent.id),
    ).toEqual([]);
  } finally {
    await db.workspace.deleteMany({ where: { id: workspace.id } });
    await db.computer.deleteMany({ where: { ownerId: alice.id } });
    await db.user.deleteMany({ where: { id: { in: [alice.id, bob.id] } } });
    await db.$disconnect();
    redis.close();
  }
});

test("a channel member without a browser push subscription is still a notificationForMessage recipient", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const redis = new RedisClient(Bun.env.CHANNEL_TEST_REDIS_URL!);
  const suffix = crypto.randomUUID().slice(0, 8);
  const alice = await db.user.create({ data: { username: `na${suffix}` } });
  // Notifications enabled, but this user never registered a browser subscription — the in-page
  // path must still treat them as a recipient so a later realtime signal reaches them,
  // even though the old flat `subscriptions` field would have silently dropped them.
  const carol = await db.user.create({
    data: {
      username: `nc${suffix}`,
      preferences: { create: { browserNotificationsEnabled: true } },
    },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `no-subscription-${suffix}`,
      name: "No subscription",
      members: { create: [{ userId: alice.id }, { userId: carol.id }] },
    },
  });
  try {
    const channels = new PublicChannels(db, new RedisMessageRequestIdempotency(redis), {
      publish: async () => {},
      publishJson: async () => {},
      broadcast: async () => {},
    });
    const room = await channels.create(workspace.id, alice.id, "no-subscription");
    await channels.join(workspace.id, carol.id, room.id);
    const message = await channels.send({
      workspaceId: workspace.id,
      userId: alice.id,
      channelId: room.id,
      requestId: crypto.randomUUID(),
      body: "hello without a subscription",
    });
    const pushSubscriptions = new PrismaWebPushSubscriptionStore(db);
    const notification = await pushSubscriptions.notificationForMessage(message.id);
    expect(notification?.workspaceId).toBe(workspace.id);
    expect(notification?.recipients).toEqual([{ userId: carol.id, subscriptions: [] }]);
    expect(await pushSubscriptions.notificationForRecipient(message.id, carol.id)).toEqual({
      title: notification!.title,
      body: notification!.body,
      url: notification!.url,
      tag: `message:${message.id}`,
      conversationPath: `/messages/channels/${room.id}`,
    });
  } finally {
    await db.workspace.deleteMany({ where: { id: workspace.id } });
    await db.user.deleteMany({ where: { id: { in: [alice.id, carol.id] } } });
    await db.$disconnect();
    redis.close();
  }
});

test("a mention pierces a muted member's push only through the message's stored mention rows; an @handle in code or a link label does not", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const redis = new RedisClient(Bun.env.CHANNEL_TEST_REDIS_URL!);
  const suffix = crypto.randomUUID().slice(0, 8);
  const alice = await db.user.create({ data: { username: `pa${suffix}` } });
  const bob = await db.user.create({
    data: {
      username: `pb${suffix}`,
      preferences: { create: { browserNotificationsEnabled: true } },
    },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `mute-pierce-${suffix}`,
      name: "Mute pierce",
      members: { create: [{ userId: alice.id }, { userId: bob.id }] },
    },
  });
  try {
    const channels = new PublicChannels(db, new RedisMessageRequestIdempotency(redis), {
      publish: async () => {},
      publishJson: async () => {},
      broadcast: async () => {},
    });
    const room = await channels.create(workspace.id, alice.id, "mute-pierce");
    await channels.join(workspace.id, bob.id, room.id);
    await channels.setUserMuted(workspace.id, bob.id, room.id, true);
    const send = (body: string) =>
      channels.send({
        workspaceId: workspace.id,
        userId: alice.id,
        channelId: room.id,
        requestId: crypto.randomUUID(),
        body,
      });
    const pushSubscriptions = new PrismaWebPushSubscriptionStore(db);
    const recipientsOf = async (messageId: string) =>
      (await pushSubscriptions.notificationForMessage(messageId))?.recipients.map(
        (recipient) => recipient.userId,
      );

    const mentioned = await send(`@${bob.username} please review`);
    expect(await recipientsOf(mentioned.id)).toEqual([bob.id]);
    expect(await pushSubscriptions.notificationForRecipient(mentioned.id, bob.id)).not.toBeNull();

    const notMentioned = await send(
      `see \`@${bob.username}\` and [ask @${bob.username}](https://example.com)`,
    );
    expect(await db.messageMention.count({ where: { messageId: notMentioned.id } })).toBe(0);
    expect(await recipientsOf(notMentioned.id)).toEqual([]);
    expect(await pushSubscriptions.notificationForRecipient(notMentioned.id, bob.id)).toBeNull();
  } finally {
    await db.workspace.deleteMany({ where: { id: workspace.id } });
    await db.user.deleteMany({ where: { id: { in: [alice.id, bob.id] } } });
    await db.$disconnect();
    redis.close();
  }
});

test("a closed channel stays closed until someone else posts a top-level message after the close", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const redis = new RedisClient(Bun.env.CHANNEL_TEST_REDIS_URL!);
  const suffix = crypto.randomUUID();
  const alice = await db.user.create({ data: { username: `ca${suffix.slice(0, 8)}` } });
  const bob = await db.user.create({ data: { username: `cb${suffix.slice(0, 8)}` } });
  const workspace = await db.workspace.create({
    data: {
      slug: suffix,
      name: "Closed chats",
      members: { create: [{ userId: alice.id }, { userId: bob.id }] },
    },
  });
  try {
    const channels = new PublicChannels(db, new RedisMessageRequestIdempotency(redis));
    const ops = await channels.create(workspace.id, alice.id, "ops");
    await channels.join(workspace.id, bob.id, ops.id);
    const send = (userId: string, body: string, threadRootId?: string) =>
      channels.send({
        workspaceId: workspace.id,
        userId,
        channelId: ops.id,
        body,
        requestId: crypto.randomUUID(),
        ...(threadRootId ? { threadRootId } : {}),
      });
    const listed = async () =>
      (await channels.list(workspace.id, alice.id)).find((channel) => channel.id === ops.id);

    // Unread from before the close does not hold the chat open.
    const root = await send(bob.id, "before the close");
    await channels.setUserHidden(workspace.id, alice.id, ops.id, true);
    expect(await listed()).toBeUndefined();
    // A closed channel stays in the names a body's channel references link by (and the composer's
    // `#` list offers): closing hides it from the list, not from the Workspace.
    expect(
      (await channels.names(workspace.id, alice.id)).find((channel) => channel.id === ops.id),
    ).toEqual({ id: ops.id, name: "ops", description: "", archived: false });

    // Alice's own message is not "someone else posting".
    await Bun.sleep(2); // createdAt and hiddenAt are millisecond timestamps
    await send(alice.id, "my own, after the close");
    expect(await listed()).toBeUndefined();

    // A thread reply belongs to its thread, not the channel list.
    await send(bob.id, "a reply, after the close", root.id);
    expect(await listed()).toBeUndefined();

    await send(bob.id, "after the close");
    expect(await listed()).toEqual(expect.objectContaining({ hidden: false, unreadCount: 2 }));
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.deleteMany({ where: { id: { in: [alice.id, bob.id] } } });
    await db.$disconnect();
    redis.close();
  }
});

test("pins keep one order across the member's channels and DMs: a new pin goes last, a pin made again after unpinning goes last", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const redis = new RedisClient(Bun.env.CHANNEL_TEST_REDIS_URL!);
  const suffix = crypto.randomUUID();
  const alice = await db.user.create({ data: { username: `pa${suffix.slice(0, 8)}` } });
  const workspace = await db.workspace.create({
    data: { slug: suffix, name: "Pins", members: { create: [{ userId: alice.id }] } },
  });
  try {
    const computer = await db.computer.create({
      data: { ownerId: alice.id, machineId: crypto.randomUUID() },
    });
    const helper = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: alice.id,
        computerId: computer.id,
        name: "helper",
        displayName: "Helper",
        runtimeConfig: {},
      },
    });
    const channels = new PublicChannels(db, new RedisMessageRequestIdempotency(redis));
    const directs = new PrismaDirectConversationRepository(db);
    const ops = await channels.create(workspace.id, alice.id, "ops");
    const eng = await channels.create(workspace.id, alice.id, "eng");
    await directs.getOrCreateUserAgent(workspace.id, alice.id, helper.id);

    /** The member's pins as one list, the way the sidebar's Pinned section reads them. */
    const pinned = async () => {
      const [channelRows, preferences] = await Promise.all([
        channels.list(workspace.id, alice.id),
        directs.preferencesForUser(workspace.id, alice.id),
      ]);
      return [
        ...channelRows
          .filter((channel) => channel.pinned)
          .map((channel) => ({ name: channel.name, order: channel.pinSortOrder! })),
        ...preferences.pinned.map((pin) => ({ name: "@helper", order: pin.sortOrder })),
      ]
        .sort((left, right) => left.order - right.order)
        .map((pin) => pin.name);
    };

    await channels.setUserPinned(workspace.id, alice.id, ops.id, true);
    await directs.setPinnedForUser(workspace.id, alice.id, helper.id, true);
    await channels.setUserPinned(workspace.id, alice.id, eng.id, true);
    expect(await pinned()).toEqual(["ops", "@helper", "eng"]);

    // Pinning what is already pinned keeps its place.
    await channels.setUserPinned(workspace.id, alice.id, ops.id, true);
    expect(await pinned()).toEqual(["ops", "@helper", "eng"]);

    // Unpinning and pinning again puts it after every other pin, never on a slot another pin holds.
    await channels.setUserPinned(workspace.id, alice.id, ops.id, false);
    await channels.setUserPinned(workspace.id, alice.id, ops.id, true);
    expect(await pinned()).toEqual(["@helper", "eng", "ops"]);
    const orders = (await channels.list(workspace.id, alice.id))
      .filter((channel) => channel.pinned)
      .map((channel) => channel.pinSortOrder);
    expect(new Set(orders).size).toBe(orders.length);

    // Closing a pinned chat does not take it out of Pinned: the list keeps reporting it.
    await channels.setUserHidden(workspace.id, alice.id, eng.id, true);
    expect(await pinned()).toEqual(["@helper", "eng", "ops"]);
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.computer.deleteMany({ where: { ownerId: alice.id } });
    await db.user.deleteMany({ where: { id: alice.id } });
    await db.$disconnect();
    redis.close();
  }
});

test("arranging a member's pins sets their order in one step, pins what is new, unpins only what it names, and refuses conversations the member is not in", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const redis = new RedisClient(Bun.env.CHANNEL_TEST_REDIS_URL!);
  const suffix = crypto.randomUUID();
  const alice = await db.user.create({ data: { username: `ra${suffix.slice(0, 8)}` } });
  const bob = await db.user.create({ data: { username: `rb${suffix.slice(0, 8)}` } });
  const workspace = await db.workspace.create({
    data: {
      slug: suffix,
      name: "Pin order",
      members: { create: [{ userId: alice.id }, { userId: bob.id }] },
    },
  });
  try {
    const computer = await db.computer.create({
      data: { ownerId: alice.id, machineId: crypto.randomUUID() },
    });
    const helper = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: alice.id,
        computerId: computer.id,
        name: "helper",
        displayName: "Helper",
        runtimeConfig: {},
      },
    });
    const channels = new PublicChannels(db, new RedisMessageRequestIdempotency(redis));
    const directs = new PrismaDirectConversationRepository(db);
    const ops = await channels.create(workspace.id, alice.id, "ops");
    const eng = await channels.create(workspace.id, alice.id, "eng");
    const bobsOwn = await channels.create(workspace.id, bob.id, "bobs");
    await directs.getOrCreateUserAgent(workspace.id, alice.id, helper.id);
    const pinned = async () => {
      const [channelRows, preferences] = await Promise.all([
        channels.list(workspace.id, alice.id),
        directs.preferencesForUser(workspace.id, alice.id),
      ]);
      return [
        ...channelRows
          .filter((channel) => channel.pinned)
          .map((channel) => ({ name: channel.name, order: channel.pinSortOrder! })),
        ...preferences.pinned.map((pin) => ({ name: "@helper", order: pin.sortOrder })),
      ]
        .sort((left, right) => left.order - right.order)
        .map((pin) => pin.name);
    };

    await channels.setUserPinned(workspace.id, alice.id, ops.id, true);
    // A new pin dropped at the top, ahead of the existing one.
    await arrangeConversationPins(db, workspace.id, alice.id, {
      pins: [
        { kind: "direct", agentId: helper.id },
        { kind: "channel", channelId: ops.id },
      ],
      unpinned: [],
    });
    expect(await pinned()).toEqual(["@helper", "ops"]);

    // Reordered, with one more pinned in between and one dragged out (unpinned).
    await arrangeConversationPins(db, workspace.id, alice.id, {
      pins: [
        { kind: "channel", channelId: eng.id },
        { kind: "direct", agentId: helper.id },
      ],
      unpinned: [{ kind: "channel", channelId: ops.id }],
    });
    expect(await pinned()).toEqual(["eng", "@helper"]);

    // A pin the arranged list does not know about (made in another tab) is kept, after the rest.
    await channels.setUserPinned(workspace.id, alice.id, ops.id, true);
    await arrangeConversationPins(db, workspace.id, alice.id, {
      pins: [
        { kind: "direct", agentId: helper.id },
        { kind: "channel", channelId: eng.id },
      ],
      unpinned: [],
    });
    expect(await pinned()).toEqual(["@helper", "eng", "ops"]);

    // A channel Alice never joined cannot be pinned, and the refusal changes nothing.
    const error = await arrangeConversationPins(db, workspace.id, alice.id, {
      pins: [{ kind: "channel", channelId: bobsOwn.id }],
      unpinned: [],
    }).catch((cause: unknown) => cause);
    expect(isAppError(error) && error.code).toBe("ACCESS_DENIED");
    expect(await pinned()).toEqual(["@helper", "eng", "ops"]);

    // Another member's pins are their own.
    await arrangeConversationPins(db, workspace.id, bob.id, { pins: [], unpinned: [] });
    expect(await pinned()).toEqual(["@helper", "eng", "ops"]);

    // Dragging the only arranged row out: the rest close up from the first place.
    await arrangeConversationPins(db, workspace.id, alice.id, {
      pins: [],
      unpinned: [{ kind: "direct", agentId: helper.id }],
    });
    expect(await pinned()).toEqual(["eng", "ops"]);
    expect(
      (await channels.list(workspace.id, alice.id))
        .filter((channel) => channel.pinned)
        .map((channel) => channel.pinSortOrder),
    ).toEqual([0, 1]);

    // A menu pin and a drag by the same member at the same moment both complete: they wait for
    // each other instead of deadlocking.
    for (let round = 0; round < 15; round += 1) {
      await Promise.all([
        channels.setUserPinned(workspace.id, alice.id, ops.id, round % 2 === 0),
        directs.setPinnedForUser(workspace.id, alice.id, helper.id, round % 2 === 1),
        arrangeConversationPins(db, workspace.id, alice.id, {
          pins: [
            { kind: "channel", channelId: ops.id },
            { kind: "channel", channelId: eng.id },
          ],
          unpinned: [],
        }),
      ]);
    }
    // Whichever finished last, the drag left ops and eng pinned, in that order, with no gaps.
    const [channelRows, preferences] = await Promise.all([
      channels.list(workspace.id, alice.id),
      directs.preferencesForUser(workspace.id, alice.id),
    ]);
    const orders = [
      ...channelRows.flatMap((channel) => (channel.pinned ? [channel.pinSortOrder!] : [])),
      ...preferences.pinned.map((pin) => pin.sortOrder),
    ].sort((left, right) => left - right);
    expect(orders).toEqual([...orders.keys()]);
    expect((await pinned()).filter((name) => name !== "@helper")).toEqual(["ops", "eng"]);
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.computer.deleteMany({ where: { ownerId: alice.id } });
    await db.user.deleteMany({ where: { id: { in: [alice.id, bob.id] } } });
    await db.$disconnect();
    redis.close();
  }
});

test("@-completion scores count only the viewer's own mentions in the channel, thread replies included", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("CHANNEL_TEST_DATABASE_URL is required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const redis = new RedisClient(Bun.env.CHANNEL_TEST_REDIS_URL!);
  const suffix = crypto.randomUUID().slice(0, 8);
  const [alice, bob, carol, dana] = await Promise.all(
    ["ma", "mb", "mc", "md"].map((prefix) =>
      db.user.create({ data: { username: `${prefix}${suffix}` } }),
    ),
  );
  const workspace = await db.workspace.create({
    data: {
      slug: `mentions-${suffix}`,
      name: "Mentions",
      members: { create: [alice!, bob!, carol!].map((user) => ({ userId: user.id })) },
    },
  });
  try {
    await enrollGeneral(db, workspace.id);
    // Dana joins the Workspace after enrollment: she can read #general without a member row.
    await db.workspaceMembership.create({ data: { workspaceId: workspace.id, userId: dana!.id } });
    const channels = new PublicChannels(db, new RedisMessageRequestIdempotency(redis), {
      publish: async () => {},
      publishJson: async () => {},
      broadcast: async () => {},
    });
    const general = (await channels.list(workspace.id, alice!.id))[0]!;
    const send = (userId: string, body: string, threadRootId?: string) =>
      channels.send({
        workspaceId: workspace.id,
        userId,
        channelId: general.id,
        requestId: crypto.randomUUID(),
        body,
        threadRootId,
      });
    const root = await send(alice!.id, `@${bob!.username} can you look?`);
    await send(alice!.id, `@${bob!.username} following up`, root.id);
    // Carol mentions both Alice and Bob: someone else's mention never scores for Alice.
    await send(carol!.id, `@${alice!.username} @${bob!.username} on it`);

    const scores = (mentionables: { handle: string; mentionScore: number }[]) =>
      Object.fromEntries(mentionables.map((entry) => [entry.handle, entry.mentionScore]));
    const bobInTwo = { [alice!.username]: 0, [bob!.username]: 200, [carol!.username]: 0 };
    expect(scores((await channels.open(workspace.id, alice!.id, general.id)).mentionables)).toEqual(
      bobInTwo,
    );
    expect(scores(await channels.mentionDirectory(workspace.id, alice!.id, general.id))).toEqual(
      bobInTwo,
    );
    expect(scores(await channels.mentionDirectory(workspace.id, carol!.id, general.id))).toEqual({
      [alice!.username]: 100,
      [bob!.username]: 100,
      [carol!.username]: 0,
    });
    // A reader with no member row has mentioned no one here.
    expect(
      Object.values(scores((await channels.open(workspace.id, dana!.id, general.id)).mentionables)),
    ).toEqual([0, 0, 0]);
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.deleteMany({
      where: { id: { in: [alice!, bob!, carol!, dana!].map((user) => user.id) } },
    });
    await db.$disconnect();
    redis.close();
  }
});
