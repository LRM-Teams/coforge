import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { executeAgentSendMessageWithPolicy } from "#src/server/agents/agent-messages.server";
import { SendDirectMessage } from "#src/server/conversations/direct-message.server";

test("thread send and unread ranges stay separate from the main conversation", async () => {
  const connectionString = Bun.env.THREAD_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("THREAD_TEST_DATABASE_URL is required (local PostgreSQL)");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const id = crypto.randomUUID();
  const username = `t${id.slice(0, 8)}`;
  const user = await db.user.create({ data: { username } });
  const workspace = await db.workspace.create({
    data: {
      slug: id,
      name: "Thread test",
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
    const opened = await repo.openForUser(workspace.id, user.id, agent.id);
    const root = await repo.sendMessage(
      opened.conversationId,
      opened.senderMemberId,
      user.id,
      "root",
    );
    const shortTarget = `@${username}:${root.id.slice(0, 8)}`;
    const target = `@${username}:${root.id}`;
    const reply = await repo.sendMessage(
      opened.conversationId,
      opened.senderMemberId,
      user.id,
      "thread only",
      undefined,
      root.id,
    );
    await repo.sendMessage(opened.conversationId, opened.senderMemberId, user.id, "main unread");
    const thread = await repo.readMessages(workspace.id, agent.id, shortTarget);
    expect(thread.map((m) => [m.body, m.senderHandle, m.target])).toEqual([
      ["thread only", username, target],
    ]);
    expect(
      (await repo.readMessages(workspace.id, agent.id, `@${username}`)).map((m) => m.body),
    ).toEqual(["root", "main unread"]);
    expect(await repo.readMessages(workspace.id, agent.id, target)).toEqual([]);
    expect(
      (
        await repo.readMessages(workspace.id, agent.id, `@${username}`, {
          around: root.id.slice(0, 8),
          limit: 1,
        })
      ).map((m) => m.id),
    ).toEqual([root.id]);
    await expect(
      repo.sendMessage(
        opened.conversationId,
        opened.senderMemberId,
        user.id,
        "nested",
        undefined,
        reply.id,
      ),
    ).rejects.toThrow("top-level");
    const other = await repo.sendMessage(
      opened.conversationId,
      opened.senderMemberId,
      user.id,
      "other root",
    );
    const otherShortTarget = `@${username}:${other.id.slice(0, 8)}`;
    const otherTarget = `@${username}:${other.id}`;
    await repo.sendMessage(
      opened.conversationId,
      opened.senderMemberId,
      user.id,
      "other thread",
      undefined,
      other.id,
    );
    await repo.sendMessage(
      opened.conversationId,
      opened.senderMemberId,
      user.id,
      "new thread message",
      undefined,
      root.id,
    );
    await repo.sendAgentMessage(
      opened.conversationId,
      agent.id,
      "thread response",
      undefined,
      root.id.slice(0, 8),
    );
    expect(
      (await repo.readPendingAgentContext(workspace.id, agent.id, otherShortTarget)).map((m) => [
        m.body,
        m.target,
      ]),
    ).toEqual([["other thread", otherTarget]]);
    const recovery = await repo.readAgentRecoveryContext(workspace.id, agent.id);
    expect(recovery.unreadSummary).toEqual({
      [`@${username}`]: 1,
      [target]: 1,
      [otherTarget]: 1,
    });
    expect(recovery.resumeMessages.find((m) => m.target === target)?.latestSenderHandle).toBe(
      username,
    );
    await repo.advanceAgentReadThrough(workspace.id, agent.id, target, 999);
    expect((await repo.readAgentRecoveryContext(workspace.id, agent.id)).unreadSummary).toEqual({
      [`@${username}`]: 1,
      [otherTarget]: 1,
    });
    expect(
      (
        await repo.readMessages(workspace.id, agent.id, target, {
          after: reply.id.slice(0, 8),
        })
      ).map((m) => m.body),
    ).toEqual(["new thread message", "thread response"]);
    expect(
      (await repo.readPendingAgentDeliveries(workspace.id, agent.id)).find(
        (m) => m.messageId === reply.id,
      )?.target,
    ).toBe(target);
    const beforeRead = await repo.openForUser(workspace.id, user.id, agent.id);
    expect(beforeRead.threadReadThrough[root.id] ?? 0).toBe(0);
    await repo.markThreadReadForUser(workspace.id, user.id, agent.id, root.id, 999);
    const afterRead = await repo.openForUser(workspace.id, user.id, agent.id);
    expect(afterRead.threadReadThrough[root.id]).toBe(7);
    expect(afterRead.threadReadThrough[other.id]).toBeUndefined();

    const idempotency = { execute: async (_scope: unknown, persist: () => unknown) => persist() };
    const sender = new SendDirectMessage(repo, idempotency as any, {} as any);
    const sendTo = async (destination: string, seenUpToSeq?: number) =>
      executeAgentSendMessageWithPolicy(
        { repository: repo, sender },
        {
          idempotencyKey: crypto.randomUUID(),
          workspaceId: workspace.id,
          agentId: agent.id,
          target: destination,
          content: "response",
          seenUpToSeq,
        },
      );
    // A first touch of a target that already carries context is held for a context sync (Raft's
    // `syncing_hold`), so the thread send is held rather than forwarded.
    expect((await sendTo(shortTarget)).state).toBe("held");
    const hold = await sendTo(otherTarget);
    expect(hold.state).toBe("held");
    expect(hold.decision).toBe("local_hold");
    expect(hold.heldMessages?.map((m) => [m.body, m.target, m.senderHandle])).toEqual([
      ["other thread", otherTarget, username],
    ]);
    const rootHold = await sendTo(`@${username}`);
    expect(rootHold.heldMessages?.map((m) => m.body)).toEqual([
      "root",
      "main unread",
      "other root",
    ]);

    // Explicit fixtures exercise an otherwise rare UUID-prefix collision.
    await db.message.createMany({
      data: ["aaaaaaaa-0000-4000-8000-000000000001", "aaaaaaaa-0000-4000-8000-000000000002"].map(
        (messageId, index) => ({
          id: messageId,
          workspaceId: workspace.id,
          conversationId: opened.conversationId,
          senderMemberId: opened.senderMemberId,
          sequence: 9 + index,
          body: "collision fixture",
        }),
      ),
    });
    await db.agentMessageDelivery.createMany({
      data: ["aaaaaaaa-0000-4000-8000-000000000001", "aaaaaaaa-0000-4000-8000-000000000002"].map(
        (messageId, index) => ({
          messageId,
          workspaceId: workspace.id,
          conversationId: opened.conversationId,
          agentId: agent.id,
          sequence: 9 + index,
        }),
      ),
    });
    await expect(
      repo.readMessages(workspace.id, agent.id, `@${username}`, {
        around: "aaaaaaaa",
      }),
    ).rejects.toThrow("ambiguous");
    await expect(
      repo.readMessages(workspace.id, agent.id, `@${username}:aaaaaaaa`),
    ).rejects.toThrow("ambiguous");
    expect(
      (
        await repo.readMessages(workspace.id, agent.id, `@${username}`, {
          around: "aaaaaaaa-0000-4000-8000-000000000001",
          limit: 1,
        })
      ).map((m) => m.id),
    ).toEqual(["aaaaaaaa-0000-4000-8000-000000000001"]);
    await expect(
      repo.readMessages(workspace.id, agent.id, otherTarget, {
        before: reply.id,
      }),
    ).rejects.toThrow("outside this target");
    await expect(
      repo.readMessages(workspace.id, agent.id, `@${username}`, {
        around: crypto.randomUUID(),
      }),
    ).rejects.toThrow("not found");
    const secondAgent = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: user.id,
        name: "second",
        displayName: "Second",
        runtimeConfig: {},
      },
    });
    await expect(repo.readMessages(workspace.id, secondAgent.id, target)).rejects.toThrow(
      "not found",
    );
    await expect(
      repo.sendAgentMessage(opened.conversationId, secondAgent.id, "forbidden", undefined, root.id),
    ).rejects.toThrow("not a conversation member");
    for (const collisionRoot of [
      "aaaaaaaa-0000-4000-8000-000000000001",
      "aaaaaaaa-0000-4000-8000-000000000002",
    ]) {
      const collisionReply = await repo.sendMessage(
        opened.conversationId,
        opened.senderMemberId,
        user.id,
        "collision reply",
        undefined,
        collisionRoot,
      );
      expect(collisionReply.deliveryTarget).toBe(`@${username}:${collisionRoot}`);
    }
    const collisionRecovery = await repo.readAgentRecoveryContext(workspace.id, agent.id);
    expect(
      collisionRecovery.unreadSummary[`@${username}:aaaaaaaa-0000-4000-8000-000000000001`],
    ).toBe(1);
    expect(
      collisionRecovery.unreadSummary[`@${username}:aaaaaaaa-0000-4000-8000-000000000002`],
    ).toBe(1);

    // Reviewer isolation (`freshnessContextMode: "withheld"`): a hold never
    // returns message bodies, senders, or metadata, only the state and a
    // count of everything still pending; a re-hold does not narrow to
    // "since last presented" because nothing was presented, and a valid
    // stage-2 token still lets `continueAnyway` send.
    const withheldRoot = await repo.sendMessage(
      opened.conversationId,
      opened.senderMemberId,
      user.id,
      "withheld root",
    );
    await repo.sendMessage(
      opened.conversationId,
      opened.senderMemberId,
      user.id,
      "withheld reply 1",
      undefined,
      withheldRoot.id,
    );
    await repo.sendMessage(
      opened.conversationId,
      opened.senderMemberId,
      user.id,
      "withheld reply 2",
      undefined,
      withheldRoot.id,
    );
    await repo.sendMessage(
      opened.conversationId,
      opened.senderMemberId,
      user.id,
      "withheld reply 3",
      undefined,
      withheldRoot.id,
    );
    await repo.sendMessage(
      opened.conversationId,
      opened.senderMemberId,
      user.id,
      "withheld reply 4",
      undefined,
      withheldRoot.id,
    );
    const withheldTarget = `@${username}:${withheldRoot.id}`;

    // Inline mode still presents only the bounded 3-row window; the fourth
    // pending reply is invisible to it, unlike withheld's true count below.
    const inlineHold = await sendTo(withheldTarget);
    expect(inlineHold.state).toBe("held");
    expect(inlineHold.heldMessages?.map((m) => m.body)).toEqual([
      "withheld reply 2",
      "withheld reply 3",
      "withheld reply 4",
    ]);

    const withheldBody = "independent review, reviewer isolated";
    const sendWithheld = async (draftReholdCount?: number, continueAnyway?: boolean) =>
      executeAgentSendMessageWithPolicy(
        { repository: repo, sender },
        {
          idempotencyKey: crypto.randomUUID(),
          workspaceId: workspace.id,
          agentId: agent.id,
          target: withheldTarget,
          content: withheldBody,
          draftReholdCount,
          continueAnyway,
          freshnessContextMode: "withheld",
        },
      );
    const withheldHold = await sendWithheld();
    expect(withheldHold).toMatchObject({
      state: "held",
      decision: "local_hold",
      heldMessages: [],
      freshnessContextMode: "withheld",
      withheldMessageCount: 4,
      continueAnywaySuggested: false,
    });
    const withheldRehold = await sendWithheld(1);
    expect(withheldRehold).toMatchObject({
      state: "held",
      decision: "local_hold",
      heldMessages: [],
      freshnessContextMode: "withheld",
      withheldMessageCount: 4,
      continueAnywaySuggested: true,
    });
    const withheldSent = await sendWithheld(1, true);
    // Raft's sent envelope carries no freshness-context field, and withheld mode returns no
    // bodies for anything — including the messages it bypassed.
    expect(withheldSent).toMatchObject({
      state: "sent",
      decision: "bypass",
      reason: "continue_anyway",
    });
    expect(withheldSent.recentUnread).toEqual([]);
  } finally {
    await db.agentMessageDelivery.deleteMany({
      where: { workspaceId: workspace.id },
    });
    await db.message.deleteMany({ where: { workspaceId: workspace.id } });
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.delete({ where: { id: user.id } });
    await db.$disconnect();
  }
});

test("thread follower and read-marker rows are found by their root through an index", async () => {
  const connectionString = Bun.env.THREAD_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("THREAD_TEST_DATABASE_URL is required (local PostgreSQL)");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  // Every thread reply asks "does this root have a follower yet?" under the conversation lock,
  // and deleting a Message cascades into both tables by (rootMessageId, conversationId). The
  // (memberId, rootMessageId) primary key cannot seek either lookup, so each table needs an
  // index that leads with the root; without it both walk the whole table.
  try {
    const leading = await db.$queryRaw<{ table: string; columns: string[] }[]>`
      SELECT t.relname AS "table",
             ARRAY(SELECT a.attname::text
                     FROM unnest(i.indkey[0:1]) WITH ORDINALITY AS k(attnum, position)
                     JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
                    ORDER BY k.position) AS columns
        FROM pg_index i
        JOIN pg_class t ON t.oid = i.indrelid
       WHERE t.relname IN ('thread_follows', 'thread_reads')`;
    for (const table of ["thread_follows", "thread_reads"]) {
      expect(
        leading.filter((index) => index.table === table).map((index) => index.columns),
        table,
      ).toContainEqual(["rootMessageId", "conversationId"]);
    }
  } finally {
    await db.$disconnect();
  }
});
