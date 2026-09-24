import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { ActivityInbox, type ActivityInboxItem } from "#src/server/inbox/activity-inbox.server";

/**
 * The Activity inbox against PostgreSQL: which conversations and threads a person sees, their
 * unread and mention state, and how Done and Mark all read change it. Fixture rows are written
 * directly so each test controls sequences exactly.
 */
function database() {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString)
    throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

/** An item's kind as the page shows it: a thread card, or its conversation's own kind. */
function kindOf(item: ActivityInboxItem) {
  return item.thread ? "thread" : item.place.kind;
}

async function seed(db: PrismaClient, suffix: string) {
  const [alice, bob] = await Promise.all(
    ["alice", "bob"].map((name) =>
      db.user.create({ data: { username: `inbox-${name}-${suffix}`, displayName: name } }),
    ),
  );
  const workspace = await db.workspace.create({
    data: { slug: `inbox-${suffix}`, name: "Inbox" },
  });
  await db.workspaceMembership.createMany({
    data: [alice!, bob!].map((user) => ({ workspaceId: workspace.id, userId: user.id })),
  });
  const sequences = new Map<string, number>();
  async function channel(name: string, options: { archived?: boolean } = {}) {
    const conversation = await db.conversation.create({
      data: {
        workspaceId: workspace.id,
        channelName: `${name}-${suffix.slice(0, 8)}`,
        ...(options.archived ? { archivedAt: new Date() } : {}),
      },
    });
    const [aliceMember, bobMember] = await Promise.all(
      [alice!, bob!].map((user) =>
        db.conversationMember.create({
          data: { conversationId: conversation.id, workspaceId: workspace.id, userId: user.id },
        }),
      ),
    );
    return { conversation, aliceMember: aliceMember!, bobMember: bobMember! };
  }
  let clock = Date.UTC(2026, 0, 1, 8, 0, 0);
  async function post(
    conversationId: string,
    senderMemberId: string | null,
    body: string,
    options: { threadRootId?: string; mentionMemberIds?: string[] } = {},
  ) {
    const sequence = (sequences.get(conversationId) ?? 0) + 1;
    sequences.set(conversationId, sequence);
    clock += 60_000;
    const message = await db.message.create({
      data: {
        conversationId,
        workspaceId: workspace.id,
        senderMemberId,
        body,
        sequence,
        createdAt: new Date(clock),
        threadRootId: options.threadRootId ?? null,
      },
    });
    for (const memberId of options.mentionMemberIds ?? [])
      await db.messageMention.create({
        data: {
          messageId: message.id,
          memberId,
          conversationId,
          workspaceId: workspace.id,
          kind: "user",
          actorId: alice!.id,
          handle: alice!.username,
        },
      });
    return message;
  }
  return { alice: alice!, bob: bob!, workspace, channel, post, sequences };
}

async function cleanup(db: PrismaClient, suffix: string) {
  await db.workspace.deleteMany({ where: { slug: `inbox-${suffix}` } });
  await db.user.deleteMany({ where: { username: { startsWith: "inbox-", endsWith: suffix } } });
  await db.$disconnect();
}

test("lists joined conversations and followed threads with activity, newest first", async () => {
  const db = database();
  const suffix = crypto.randomUUID();
  try {
    const { alice, workspace, channel, post } = await seed(db, suffix);
    const general = await channel("general");
    const quiet = await channel("quiet");
    const archived = await channel("archived", { archived: true });
    const left = await channel("left");
    await db.conversationMember.update({
      where: { id: left.aliceMember.id },
      data: { leftAt: new Date() },
    });

    await post(archived.conversation.id, archived.bobMember.id, "old news");
    await post(left.conversation.id, left.bobMember.id, "after alice left");
    const root = await post(general.conversation.id, general.aliceMember.id, "a question");
    await post(general.conversation.id, general.bobMember.id, "hello");
    await post(general.conversation.id, null, "1 new task created: #1");
    await db.threadFollow.create({
      data: {
        memberId: general.aliceMember.id,
        rootMessageId: root.id,
        conversationId: general.conversation.id,
        workspaceId: workspace.id,
      },
    });
    const reply = await post(general.conversation.id, general.bobMember.id, "an answer", {
      threadRootId: root.id,
      mentionMemberIds: [general.aliceMember.id],
    });
    await post(general.conversation.id, general.aliceMember.id, "thanks", {
      threadRootId: root.id,
    });
    // An unfollowed thread elsewhere stays out.
    const otherRoot = await post(quiet.conversation.id, quiet.bobMember.id, "unfollowed root");
    await post(quiet.conversation.id, quiet.bobMember.id, "unfollowed reply", {
      threadRootId: otherRoot.id,
    });

    const inbox = new ActivityInbox(db);
    const page = await inbox.list(workspace.id, alice.id, { filter: "all" });

    expect(
      page.items.map((item) => [
        kindOf(item),
        item.place.conversationId,
        item.thread?.root.id ?? null,
      ]),
    ).toEqual([
      ["channel", quiet.conversation.id, null],
      ["thread", general.conversation.id, root.id],
      ["channel", general.conversation.id, null],
    ]);
    const [, thread, channelItem] = page.items;
    // Unread counts people's messages only, never the viewer's own or a system notice.
    expect(channelItem!.unreadCount).toBe(1);
    expect(channelItem!.latest.body).toBe("1 new task created: #1");
    expect(channelItem!.latest.senderKind).toBe("system");
    expect(thread!.unreadCount).toBe(1);
    expect(thread!.firstUnreadMessageId).toBe(reply.id);
    expect(thread!.thread?.replyCount).toBe(2);
    expect(thread!.thread?.root.body).toBe("a question");
    expect(thread!.latest.body).toBe("thanks");
    expect(thread!.mentioned).toBe(true);
    expect(thread!.unreadMention).toBe(true);
    expect(page.totalCount).toBe(3);
    expect(page.totalUnreadCount).toBe(3);
    expect(page.nextOffset).toBe(null);

    const unread = await inbox.list(workspace.id, alice.id, { filter: "unread" });
    expect(unread.items.map((item) => item.key)).toEqual(page.items.map((item) => item.key));
    const mentions = await inbox.list(workspace.id, alice.id, { filter: "mentions" });
    expect(mentions.items.map((item) => item.key)).toEqual([thread!.key]);

    const firstPage = await inbox.list(workspace.id, alice.id, { filter: "all", limit: 2 });
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.nextOffset).toBe(2);
    const secondPage = await inbox.list(workspace.id, alice.id, {
      filter: "all",
      limit: 2,
      offset: 2,
    });
    expect(secondPage.items.map((item) => item.key)).toEqual([channelItem!.key]);
  } finally {
    await cleanup(db, suffix);
  }
});

test("Done removes an item until newer activity arrives, and reads it", async () => {
  const db = database();
  const suffix = crypto.randomUUID();
  try {
    const { alice, workspace, channel, post } = await seed(db, suffix);
    const general = await channel("general");
    await post(general.conversation.id, general.bobMember.id, "one");
    const second = await post(general.conversation.id, general.bobMember.id, "two");
    const root = await post(general.conversation.id, general.aliceMember.id, "root");
    await db.threadFollow.create({
      data: {
        memberId: general.aliceMember.id,
        rootMessageId: root.id,
        conversationId: general.conversation.id,
        workspaceId: workspace.id,
      },
    });
    const reply = await post(general.conversation.id, general.bobMember.id, "reply", {
      threadRootId: root.id,
    });

    const inbox = new ActivityInbox(db);
    const channelRef = { kind: "conversation" as const, conversationId: general.conversation.id };
    // A Done that saw an older message leaves the newer one listed.
    await inbox.markDone(workspace.id, alice.id, { ...channelRef, throughSequence: 1 });
    let page = await inbox.list(workspace.id, alice.id, { filter: "all" });
    expect(page.items.map(kindOf)).toEqual(["thread", "channel"]);

    await inbox.markDone(workspace.id, alice.id, {
      ...channelRef,
      throughSequence: root.sequence,
    });
    await inbox.markDone(workspace.id, alice.id, {
      kind: "thread",
      conversationId: general.conversation.id,
      rootMessageId: root.id,
      throughSequence: reply.sequence,
    });
    page = await inbox.list(workspace.id, alice.id, { filter: "all" });
    expect(page.items).toEqual([]);
    const member = await db.conversationMember.findUniqueOrThrow({
      where: { id: general.aliceMember.id },
    });
    expect(member.readThroughSequence).toBe(root.sequence);
    expect(second.sequence).toBeLessThan(root.sequence);

    const next = await post(general.conversation.id, general.bobMember.id, "three");
    page = await inbox.list(workspace.id, alice.id, { filter: "all" });
    expect(page.items.map((item) => [kindOf(item), item.latest.id, item.unreadCount])).toEqual([
      ["channel", next.id, 1],
    ]);

    const late = await post(general.conversation.id, general.bobMember.id, "late reply", {
      threadRootId: root.id,
    });
    page = await inbox.list(workspace.id, alice.id, { filter: "all" });
    expect(page.items.map((item) => [kindOf(item), item.latest.id, item.unreadCount])).toEqual([
      ["thread", late.id, 1],
      ["channel", next.id, 1],
    ]);
  } finally {
    await cleanup(db, suffix);
  }
});

test("Mark all read clears unread and keeps every item listed", async () => {
  const db = database();
  const suffix = crypto.randomUUID();
  try {
    const { alice, workspace, channel, post } = await seed(db, suffix);
    const general = await channel("general");
    const root = await post(general.conversation.id, general.aliceMember.id, "root");
    await db.threadFollow.create({
      data: {
        memberId: general.aliceMember.id,
        rootMessageId: root.id,
        conversationId: general.conversation.id,
        workspaceId: workspace.id,
      },
    });
    await post(general.conversation.id, general.bobMember.id, "reply", { threadRootId: root.id });
    await post(general.conversation.id, general.bobMember.id, "main");
    await db.conversationMember.update({
      where: { id: general.aliceMember.id },
      data: { unreadFromSequence: 1 },
    });

    const inbox = new ActivityInbox(db);
    expect((await inbox.list(workspace.id, alice.id, { filter: "all" })).totalUnreadCount).toBe(2);
    const shown = new Date();
    // Sent after the page the viewer looked at: Mark all read must not read it.
    const late = await post(general.conversation.id, general.bobMember.id, "late", {
      threadRootId: root.id,
    });
    await db.message.update({
      where: { id: late.id },
      data: { createdAt: new Date(shown.getTime() + 1_000) },
    });
    await inbox.markAllRead(workspace.id, alice.id, { before: shown });
    const page = await inbox.list(workspace.id, alice.id, { filter: "all" });
    expect(page.items.map((item) => [kindOf(item), item.unreadCount])).toEqual([
      ["thread", 1],
      ["channel", 0],
    ]);
    expect(page.totalUnreadCount).toBe(1);
    expect(page.items[0]!.firstUnreadMessageId).toBe(late.id);
    const member = await db.conversationMember.findUniqueOrThrow({
      where: { id: general.aliceMember.id },
    });
    expect(member.unreadFromSequence).toBe(null);
  } finally {
    await cleanup(db, suffix);
  }
});

test("direct messages and their threads are listed with the Agent they belong to", async () => {
  const db = database();
  const suffix = crypto.randomUUID();
  try {
    const { alice, workspace } = await seed(db, suffix);
    const agent = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: alice.id,
        name: `helper-${suffix.slice(0, 8)}`,
        displayName: "Helper",
        runtimeConfig: {},
      },
    });
    const repo = new PrismaDirectConversationRepository(db);
    const opened = await repo.openForUser(workspace.id, alice.id, agent.id);
    const root = await repo.sendMessage(
      opened.conversationId,
      opened.senderMemberId,
      alice.id,
      "q",
    );
    await repo.sendMessage(
      opened.conversationId,
      opened.senderMemberId,
      alice.id,
      "follow-up in thread",
      undefined,
      root.id,
    );

    const inbox = new ActivityInbox(db);
    let page = await inbox.list(workspace.id, alice.id, { filter: "all" });
    expect(
      page.items.map((item) => [
        kindOf(item),
        item.place.kind === "direct" ? item.place.agent.id : null,
      ]),
    ).toEqual([
      ["thread", agent.id],
      ["direct", agent.id],
    ]);
    const direct = page.items[1]!.place;
    expect(direct.kind === "direct" && direct.agent.displayName).toBe("Helper");

    // A deleted Agent's conversation stays readable in Chat but leaves the inbox.
    await db.agent.update({ where: { id: agent.id }, data: { deletedAt: new Date() } });
    page = await inbox.list(workspace.id, alice.id, { filter: "all" });
    expect(page.items).toEqual([]);
  } finally {
    await cleanup(db, suffix);
  }
});

test("a person can only read and change their own inbox in their own Workspace", async () => {
  const db = database();
  const suffix = crypto.randomUUID();
  try {
    const { alice, bob, workspace, channel, post } = await seed(db, suffix);
    const general = await channel("general");
    const message = await post(general.conversation.id, general.bobMember.id, "hello");
    const outsider = await db.user.create({
      data: { username: `inbox-outsider-${suffix}`, displayName: "outsider" },
    });
    const inbox = new ActivityInbox(db);
    await expect(inbox.list(workspace.id, outsider.id, { filter: "all" })).rejects.toMatchObject({
      code: "ACCESS_DENIED",
    });

    // Bob is a Workspace member but not in this channel any more.
    await db.conversationMember.update({
      where: { id: general.bobMember.id },
      data: { leftAt: new Date() },
    });
    const done = {
      kind: "conversation" as const,
      conversationId: general.conversation.id,
      throughSequence: message.sequence,
    };
    await expect(inbox.markDone(workspace.id, bob.id, done)).rejects.toMatchObject({
      code: "ACCESS_DENIED",
    });
    // The conversation belongs to another Workspace than the one named.
    const other = await db.workspace.create({
      data: { slug: `inbox-other-${suffix}`, name: "Other" },
    });
    await db.workspaceMembership.create({ data: { workspaceId: other.id, userId: alice.id } });
    await expect(inbox.markDone(other.id, alice.id, done)).rejects.toMatchObject({
      code: "ACCESS_DENIED",
    });
    await db.workspace.delete({ where: { id: other.id } });
  } finally {
    await cleanup(db, suffix);
  }
});
