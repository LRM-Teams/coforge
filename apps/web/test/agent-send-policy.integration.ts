import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { executeAgentSendMessageWithPolicy } from "#src/server/agents/agent-messages.server";
import { SendDirectMessage } from "#src/server/conversations/direct-message.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";

test("an Agent send forwards past its seen boundary, holds a newer reply, and refuses an unreachable target before sending", async () => {
  const connectionString = Bun.env.THREAD_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("THREAD_TEST_DATABASE_URL is required (local PostgreSQL)");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const id = crypto.randomUUID();
  const username = `p${id.slice(0, 8)}`;
  const user = await db.user.create({ data: { username } });
  const workspace = await db.workspace.create({
    data: { slug: id, name: "Send policy test", members: { create: { userId: user.id } } },
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
    const opened = await repo.openForUser(workspace.id, user.id, agent.id);
    const root = await repo.sendMessage(
      opened.conversationId,
      opened.senderMemberId,
      user.id,
      "root",
    );
    const firstReply = await repo.sendMessage(
      opened.conversationId,
      opened.senderMemberId,
      user.id,
      "first reply",
      undefined,
      root.id,
    );
    const target = `@${username}:${root.id.slice(0, 8)}`;

    const idempotency = { execute: async (_scope: unknown, persist: () => unknown) => persist() };
    const sender = new SendDirectMessage(repo, idempotency as any, {} as any);
    const sentTargets: string[] = [];
    const recordingSender = {
      executeFromAgent: (input: Parameters<typeof sender.executeFromAgent>[0]) => {
        sentTargets.push(input.target);
        return sender.executeFromAgent(input);
      },
    };
    const sendTo = (destination: string, seenUpToSeq?: number) =>
      executeAgentSendMessageWithPolicy(
        { repository: repo, sender: recordingSender },
        {
          idempotencyKey: crypto.randomUUID(),
          workspaceId: workspace.id,
          agentId: agent.id,
          target: destination,
          content: "response",
          seenUpToSeq,
        },
      );

    // A boundary past the thread's newest message is bounded to it, and nothing is left pending.
    const forwarded = await sendTo(target, 999);
    expect(forwarded).toMatchObject({
      state: "sent",
      decision: "forward",
      reason: "model_seen_boundary",
    });
    expect(forwarded.producerFactId).toStartWith("freshness_decision_fact:");
    const stored = await db.message.findUniqueOrThrow({
      where: { id: forwarded.messageId! },
      select: { threadRootId: true, conversationId: true },
    });
    expect(stored).toEqual({ threadRootId: root.id, conversationId: opened.conversationId });

    // A reply newer than the boundary the Agent reports holds the next send on it.
    const newerReply = await repo.sendMessage(
      opened.conversationId,
      opened.senderMemberId,
      user.id,
      "newer reply",
      undefined,
      root.id,
    );
    const held = await sendTo(target, firstReply.sequence);
    expect(held).toMatchObject({
      state: "held",
      decision: "local_hold",
      reason: "exact_target_pending",
      newMessageCount: 1,
      seenUpToSeq: newerReply.sequence,
    });
    expect(held.heldMessages?.map((m) => [m.body, m.target])).toEqual([
      ["newer reply", `@${username}:${root.id}`],
    ]);

    // An unreachable target is refused while reading its context, before the sender runs.
    await expect(sendTo("#not-joined")).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    await expect(sendTo("@nobody-with-this-name", 5)).rejects.toThrow("target user not found");
    expect(sentTargets).toEqual([target]);
  } finally {
    await db.agentMessageDelivery.deleteMany({ where: { workspaceId: workspace.id } });
    await db.message.deleteMany({ where: { workspaceId: workspace.id } });
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.delete({ where: { id: user.id } });
    await db.$disconnect();
  }
});
