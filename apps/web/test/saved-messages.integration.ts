import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/client";
import {
  listUserSavedMessages,
  saveUserMessage,
  unsaveUserMessage,
} from "../src/server/conversations/saved-messages.server";

test("saves idempotently, lists newest-first per viewer, and unsaves safely", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString)
    throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");

  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID();
  const usernames = ["alice", "bob"].map((name) => `saved-${name}-${suffix}`);
  try {
    const [alice, bob] = await Promise.all(
      usernames.map((username, index) =>
        db.user.create({ data: { username, displayName: ["Alice", "Bob"][index] } }),
      ),
    );
    const workspace = await db.workspace.create({
      data: { slug: `saved-${suffix}`, name: "Saved messages" },
    });
    const conversation = await db.conversation.create({
      data: { workspaceId: workspace.id, channelName: "general" },
    });
    const [aliceMember, bobMember] = await Promise.all(
      [alice, bob].map((user) =>
        db.conversationMember.create({
          data: { conversationId: conversation.id, workspaceId: workspace.id, userId: user.id },
        }),
      ),
    );
    const messages = await Promise.all(
      ["first", "second"].map((body, index) =>
        db.message.create({
          data: {
            conversationId: conversation.id,
            workspaceId: workspace.id,
            senderMemberId: aliceMember.id,
            body,
            sequence: index + 1,
          },
        }),
      ),
    );
    const first = messages[0]!;
    const second = messages[1]!;

    const save = (userId: string, messageId: string) =>
      saveUserMessage(db, {
        workspaceId: workspace.id,
        conversationId: conversation.id,
        userId,
        messageId,
      });

    // Saving twice keeps one row (PK upsert, original savedAt preserved).
    await save(alice!.id, first.id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await save(alice!.id, second.id);
    await save(alice!.id, second.id);
    expect(
      await db.savedMessage.count({
        where: { memberId: aliceMember.id },
      }),
    ).toBe(2);

    // Bob saves a message Alice has not saved; each viewer's list contains only their rows.
    await db.savedMessage.create({
      data: {
        messageId: second.id,
        conversationId: conversation.id,
        workspaceId: workspace.id,
        memberId: bobMember.id,
      },
    });

    const aliceList = await listUserSavedMessages(db, {
      workspaceId: workspace.id,
      userId: alice!.id,
    });
    expect(aliceList.map((entry) => entry.message.id)).toEqual([second.id, first.id]);
    expect(aliceList[0]!.savedAt.getTime()).toBeGreaterThanOrEqual(aliceList[1]!.savedAt.getTime());
    expect(aliceList[0]!.conversation.channelName).toBe("general");
    expect(aliceList[0]!.message.body).toBe("second");

    const bobList = await listUserSavedMessages(db, {
      workspaceId: workspace.id,
      userId: bob!.id,
    });
    expect(bobList.map((entry) => entry.message.id)).toEqual([second.id]);

    // Unsave is idempotent and scoped to the caller's own row: Bob's row survives Alice's.
    const unsave = (userId: string, messageId: string) =>
      unsaveUserMessage(db, {
        workspaceId: workspace.id,
        conversationId: conversation.id,
        userId,
        messageId,
      });
    await unsave(alice!.id, second.id);
    await unsave(alice!.id, second.id);
    expect(await db.savedMessage.count({ where: { memberId: aliceMember.id } })).toBe(1);
    expect(await db.savedMessage.count({ where: { memberId: bobMember.id } })).toBe(1);
  } finally {
    // Workspace deletion cascades conversations, members, messages and saved rows with them.
    await db.workspace.deleteMany({ where: { slug: `saved-${suffix}` } });
    await db.user.deleteMany({ where: { username: { in: usernames } } });
    await db.$disconnect();
  }
});

test("requires active membership to save; a soft-left member still unsaves; bad ids are NOT_FOUND", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString)
    throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");

  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID();
  const username = `saved-left-${suffix}`;
  try {
    const user = await db.user.create({ data: { username, displayName: "Lefty" } });
    const outsider = await db.user.create({ data: { username: `saved-out-${suffix}` } });
    const workspace = await db.workspace.create({
      data: { slug: `saved-left-${suffix}`, name: "Saved after leave" },
    });
    const conversation = await db.conversation.create({
      data: { workspaceId: workspace.id, channelName: "general" },
    });
    const member = await db.conversationMember.create({
      data: { conversationId: conversation.id, workspaceId: workspace.id, userId: user.id },
    });
    const message = await db.message.create({
      data: {
        conversationId: conversation.id,
        workspaceId: workspace.id,
        body: "before the leave",
        sequence: 1,
      },
    });
    const save = (userId: string, messageId: string, conversationId: string) =>
      saveUserMessage(db, {
        workspaceId: workspace.id,
        conversationId,
        userId,
        messageId,
      });

    // Save first while active, then soft-leave.
    await save(user.id, message.id, conversation.id);
    await db.conversationMember.update({
      where: { id: member.id },
      data: { leftAt: new Date() },
    });
    await expect(save(user.id, message.id, conversation.id)).rejects.toThrow("ACCESS_DENIED");
    // The bookmark still lists after the leave, and the leaver can clear it.
    const list = await listUserSavedMessages(db, { workspaceId: workspace.id, userId: user.id });
    expect(list.map((entry) => entry.message.id)).toEqual([message.id]);
    await unsaveUserMessage(db, {
      workspaceId: workspace.id,
      conversationId: conversation.id,
      userId: user.id,
      messageId: message.id,
    });
    expect(await db.savedMessage.count({ where: { memberId: member.id } })).toBe(0);

    // A message id outside the stated conversation, a foreign message, and a non-member: NOT_FOUND
    // for the former two (message lookup first, like the reaction path) and ACCESS_DENIED last.
    await expect(save(user.id, crypto.randomUUID(), conversation.id)).rejects.toThrow("NOT_FOUND");
    const otherConversation = await db.conversation.create({
      data: { workspaceId: workspace.id, channelName: "elsewhere" },
    });
    const foreignMessage = await db.message.create({
      data: {
        conversationId: otherConversation.id,
        workspaceId: workspace.id,
        body: "not yours",
        sequence: 1,
      },
    });
    await expect(save(user.id, foreignMessage.id, conversation.id)).rejects.toThrow("NOT_FOUND");
    await expect(save(outsider!.id, message.id, conversation.id)).rejects.toThrow("ACCESS_DENIED");
  } finally {
    await db.workspace.deleteMany({ where: { slug: `saved-left-${suffix}` } });
    await db.user.deleteMany({
      where: { username: { in: [username, `saved-out-${suffix}`] } },
    });
    await db.$disconnect();
  }
});
