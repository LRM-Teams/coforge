import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { agentAvatarUrl } from "#src/server/agents/agent-avatar.server";
import {
  PrismaDirectConversationRepository,
  allocateSequence,
} from "#src/server/db/repositories/direct-conversation.repositories.server";
import { workspaceUserAvatarUrl } from "#src/server/db/repositories/user-profile.repositories.server";

/**
 * The browser shape of a direct-conversation message, as `openForUser` (a page of roots with
 * their replies) and `updatesForUser` (the poll past a cursor) return it: every field, the field
 * order, and no `senderMemberId` (the pane then decides "own" by `senderKind`).
 */
const BROWSER_MESSAGE_KEYS = [
  "id",
  "sequence",
  "threadRootId",
  "senderKind",
  "senderName",
  "senderHandle",
  "senderAgentId",
  "senderDeleted",
  "senderAvatarUrl",
  "body",
  "createdAt",
  "mentions",
  "attachments",
  "reactions",
  "actionCard",
];

test("a direct conversation's page and poll return the same browser message shape", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString)
    throw new Error("CHANNEL_TEST_DATABASE_URL is required (local PostgreSQL)");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const id = crypto.randomUUID();
  const username = `dm-view-${id.slice(0, 8)}`;
  const userAvatarKey = `avatars/users/${id}/v7/avatar.png`;
  const user = await db.user.create({
    data: { username, displayName: "Ada Lovelace", avatarObjectKey: userAvatarKey },
  });
  const workspace = await db.workspace.create({
    data: { slug: id, name: "DM view", members: { create: { userId: user.id } } },
  });
  try {
    const agentAvatarKey = `avatars/agents/${id}/v3/avatar.png`;
    const agent = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: user.id,
        name: "helper",
        displayName: "Helper",
        avatarObjectKey: agentAvatarKey,
        runtimeConfig: {},
      },
    });
    const repo = new PrismaDirectConversationRepository(db);
    const { conversationId, senderMemberId } = await repo.memberForUser(
      workspace.id,
      user.id,
      agent.id,
    );
    const agentMember = await db.conversationMember.findFirstOrThrow({
      where: { conversationId, agentId: agent.id },
      select: { id: true },
    });

    // A user root carrying an attachment and a reaction.
    const attachment = await db.attachment.create({
      data: {
        workspaceId: workspace.id,
        conversationId,
        uploaderId: user.id,
        objectKey: `attachments/${id}/notes.txt`,
        fileName: "notes.txt",
        contentType: "text/plain",
        sizeBytes: 12,
      },
    });
    const root = await repo.sendMessage(conversationId, senderMemberId, user.id, "release plan", [
      attachment.id,
    ]);
    await repo.setUserMessageReaction(workspace.id, user.id, agent.id, root.id, "👍", true);

    // An Agent reply in the root's thread that mentions the user.
    const reply = await db.$transaction(async (tx) => {
      const sequence = await allocateSequence(tx, conversationId);
      return tx.message.create({
        data: {
          conversationId,
          workspaceId: workspace.id,
          senderMemberId: agentMember.id,
          threadRootId: root.id,
          body: `on it <@human:${user.id}>`,
          sequence,
          mentions: {
            create: {
              memberId: senderMemberId,
              workspaceId: workspace.id,
              kind: "user",
              actorId: user.id,
              handle: username,
            },
          },
        },
        select: { id: true, sequence: true, createdAt: true },
      });
    });

    // A system root: no sender member.
    const system = await db.$transaction(async (tx) => {
      const sequence = await allocateSequence(tx, conversationId);
      return tx.message.create({
        data: { conversationId, workspaceId: workspace.id, body: "joined", sequence },
        select: { id: true, sequence: true, createdAt: true },
      });
    });

    const expected = [
      {
        id: root.id,
        sequence: root.sequence,
        threadRootId: undefined,
        senderKind: "user" as const,
        senderName: "Ada Lovelace",
        senderHandle: username,
        senderAgentId: undefined,
        senderDeleted: false,
        senderAvatarUrl: workspaceUserAvatarUrl(workspace.id, user.id, userAvatarKey),
        body: "release plan",
        createdAt: root.createdAt,
        mentions: [],
        attachments: [
          { id: attachment.id, fileName: "notes.txt", contentType: "text/plain", sizeBytes: 12 },
        ],
        reactions: [{ emoji: "👍", count: 1, reactors: [`@${username}`] }],
        actionCard: undefined,
      },
      {
        id: reply.id,
        sequence: reply.sequence,
        threadRootId: root.id,
        senderKind: "agent" as const,
        senderName: "Helper",
        senderHandle: "helper",
        senderAgentId: agent.id,
        senderDeleted: false,
        senderAvatarUrl: agentAvatarUrl(workspace.id, agent.id, agentAvatarKey),
        body: `on it <@human:${user.id}>`,
        createdAt: reply.createdAt,
        mentions: [
          { kind: "user" as const, actorId: user.id, handle: username, label: "Ada Lovelace" },
        ],
        attachments: [],
        reactions: undefined,
        actionCard: undefined,
      },
      {
        id: system.id,
        sequence: system.sequence,
        threadRootId: undefined,
        senderKind: "system" as const,
        senderName: "System",
        senderHandle: undefined,
        senderAgentId: undefined,
        senderDeleted: false,
        senderAvatarUrl: null,
        body: "joined",
        createdAt: system.createdAt,
        mentions: [],
        attachments: [],
        reactions: undefined,
        actionCard: undefined,
      },
    ];

    const opened = await repo.openForUser(workspace.id, user.id, agent.id);
    const polled = await repo.updatesForUser(workspace.id, user.id, agent.id, 0);
    for (const messages of [opened.messages, polled]) {
      expect(messages).toEqual(expected);
      for (const message of messages) expect(Object.keys(message)).toEqual(BROWSER_MESSAGE_KEYS);
    }
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.delete({ where: { id: user.id } });
    await db.$disconnect();
  }
});
