import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/client";
import { ConversationHistory } from "../src/server/conversations/conversation-history.server";
import { TaskBoard } from "../src/server/tasks/task-board.server";

test("TaskBoard enforces conversation authorization, idempotency, and ownership under contention", async () => {
  const connectionString = Bun.env.TASK_TEST_DATABASE_URL ?? Bun.env.DATABASE_URL;
  if (!connectionString)
    throw new Error("TASK_TEST_DATABASE_URL or DATABASE_URL must point to local PostgreSQL");

  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const board = new TaskBoard(db);
  const history = new ConversationHistory(db);
  const suffix = crypto.randomUUID();
  const short = suffix.slice(0, 8);
  const users = await Promise.all(
    ["alice", "bob", "mallory"].map((name) =>
      db.user.create({ data: { username: `ta-${name}-${short}` } }),
    ),
  );
  const [alice, bob, mallory] = users;
  const workspace = await db.workspace.create({
    data: {
      slug: `task-auth-${suffix}`,
      name: "Task authorization",
      members: { create: [{ userId: alice!.id }, { userId: bob!.id }] },
      agents: {
        create: [
          {
            name: `task-auth-agent-${short}`,
            displayName: "Owned Agent",
            ownerId: alice!.id,
            runtimeConfig: {},
          },
          {
            name: `task-auth-peer-${short}`,
            displayName: "Peer Agent",
            ownerId: bob!.id,
            runtimeConfig: {},
          },
        ],
      },
    },
    include: { agents: true },
  });
  const [agent, peerAgent] = workspace.agents;
  const otherWorkspace = await db.workspace.create({
    data: {
      slug: `task-auth-other-${suffix}`,
      name: "Other workspace",
      members: { create: { userId: mallory!.id } },
    },
  });

  const publicChannel = await db.conversation.create({
    data: {
      workspaceId: workspace.id,
      channelName: `public-${short}`,
      members: {
        create: [{ userId: alice!.id }, { agentId: agent!.id }, { agentId: peerAgent!.id }],
      },
    },
    include: { members: true },
  });
  const otherChannel = await db.conversation.create({
    data: {
      workspaceId: workspace.id,
      channelName: `other-${short}`,
      members: { create: [{ userId: alice!.id }, { agentId: agent!.id }] },
    },
    include: { members: true },
  });
  const direct = await db.conversation.create({
    data: {
      workspaceId: workspace.id,
      directKey: [alice!.id, agent!.id].sort().join(":"),
      members: { create: [{ userId: alice!.id }, { agentId: agent!.id }] },
    },
    include: { members: true },
  });
  const peerDirect = await db.conversation.create({
    data: {
      workspaceId: workspace.id,
      directKey: [bob!.id, peerAgent!.id].sort().join(":"),
      members: { create: [{ userId: bob!.id }, { agentId: peerAgent!.id }] },
    },
  });
  const aliceChannelMember = publicChannel.members.find((member) => member.userId === alice!.id)!;
  const aliceOtherMember = otherChannel.members.find((member) => member.userId === alice!.id)!;
  const ambiguousPrefix = "deadbeef";

  try {
    const seed = await board.execute(
      { workspaceId: workspace.id, userId: alice!.id },
      {
        operation: "create",
        requestId: crypto.randomUUID(),
        conversationId: publicChannel.id,
        title: "Visible public task",
      },
    );
    await expect(
      board.execute(
        { workspaceId: workspace.id, userId: alice!.id },
        {
          operation: "unclaim",
          requestId: crypto.randomUUID(),
          conversationId: publicChannel.id,
          number: seed.tasks[0]!.number,
        },
      ),
    ).rejects.toThrow("INVALID_INPUT");

    expect(
      await board.execute(
        { workspaceId: workspace.id, userId: bob!.id },
        { operation: "list", requestId: crypto.randomUUID(), conversationId: publicChannel.id },
      ),
    ).toEqual({ tasks: seed.tasks });
    for (const operation of ["create", "convert", "claim", "update"] as const) {
      const command =
        operation === "create"
          ? { operation, title: "Unauthorized create" }
          : operation === "convert"
            ? { operation, messageId: seed.tasks[0]!.messageId }
            : operation === "claim"
              ? { operation, number: seed.tasks[0]!.number }
              : {
                  operation,
                  number: seed.tasks[0]!.number,
                  status: "closed" as const,
                  expectedRevision: seed.tasks[0]!.revision,
                };
      await expect(
        board.execute(
          { workspaceId: workspace.id, userId: bob!.id },
          { ...command, requestId: crypto.randomUUID(), conversationId: publicChannel.id },
        ),
      ).rejects.toThrow("ACCESS_DENIED");
    }
    await expect(
      board.execute(
        { workspaceId: otherWorkspace.id, userId: mallory!.id },
        { operation: "list", requestId: crypto.randomUUID(), conversationId: publicChannel.id },
      ),
    ).rejects.toThrow("NOT_FOUND");
    await expect(
      board.execute(
        { workspaceId: workspace.id, userId: bob!.id },
        { operation: "list", requestId: crypto.randomUUID(), conversationId: direct.id },
      ),
    ).rejects.toThrow("ACCESS_DENIED");
    const unrelatedDirectMember = await db.conversationMember.create({
      data: { workspaceId: workspace.id, conversationId: direct.id, userId: bob!.id },
    });
    await expect(
      board.execute(
        { workspaceId: workspace.id, userId: bob!.id },
        { operation: "list", requestId: crypto.randomUUID(), conversationId: direct.id },
      ),
    ).rejects.toThrow("ACCESS_DENIED");
    await db.conversationMember.delete({ where: { id: unrelatedDirectMember.id } });
    await expect(
      board.execute(
        { workspaceId: workspace.id, agentId: agent!.id },
        { operation: "list", requestId: crypto.randomUUID(), target: `@${bob!.username}` },
      ),
    ).rejects.toThrow("NOT_FOUND");

    const otherRoot = await db.message.create({
      data: {
        workspaceId: workspace.id,
        conversationId: otherChannel.id,
        senderMemberId: aliceOtherMember.id,
        sequence: 1,
        body: "Other channel root",
      },
    });
    const reply = await db.message.create({
      data: {
        workspaceId: workspace.id,
        conversationId: publicChannel.id,
        senderMemberId: aliceChannelMember.id,
        sequence: 2,
        body: "Thread reply",
        threadRootId: seed.tasks[0]!.messageId,
      },
    });
    for (const messageId of [otherRoot.id, reply.id]) {
      await expect(
        board.execute(
          { workspaceId: workspace.id, userId: alice!.id },
          {
            operation: "convert",
            requestId: crypto.randomUUID(),
            conversationId: publicChannel.id,
            messageId,
          },
        ),
      ).rejects.toThrow("NOT_FOUND");
    }
    await db.message.createMany({
      data: [1, 2].map((tail, index) => ({
        id: `${ambiguousPrefix}-0000-4000-8000-00000000000${tail}`,
        workspaceId: workspace.id,
        conversationId: publicChannel.id,
        senderMemberId: aliceChannelMember.id,
        sequence: 3 + index,
        body: `Ambiguous ${tail}`,
      })),
    });
    await expect(
      board.execute(
        { workspaceId: workspace.id, userId: alice!.id },
        {
          operation: "convert",
          requestId: crypto.randomUUID(),
          conversationId: publicChannel.id,
          messageId: ambiguousPrefix,
        },
      ),
    ).rejects.toThrow("CONFLICT");

    const agentCreated = await board.execute(
      { workspaceId: workspace.id, agentId: agent!.id },
      {
        operation: "create",
        requestId: crypto.randomUUID(),
        target: `@${alice!.username}`,
        title: "Agent-owned DM task",
      },
    );
    expect(
      (
        await board.execute(
          { workspaceId: workspace.id, agentId: agent!.id },
          { operation: "list", requestId: crypto.randomUUID(), target: `@${alice!.username}` },
        )
      ).tasks,
    ).toEqual(agentCreated.tasks);
    const agentClaimed = await board.execute(
      { workspaceId: workspace.id, agentId: agent!.id },
      {
        operation: "claim",
        requestId: crypto.randomUUID(),
        target: `@${alice!.username}`,
        number: agentCreated.tasks[0]!.number,
      },
    );
    expect(agentClaimed.tasks[0]).toMatchObject({
      status: "in_progress",
      owner: { kind: "agent" },
    });
    await expect(
      board.execute(
        { workspaceId: workspace.id, agentId: agent!.id },
        { operation: "list", requestId: crypto.randomUUID(), target: `@${bob!.username}` },
      ),
    ).rejects.toThrow("NOT_FOUND");

    const usedAttachment = await db.attachment.create({
      data: {
        workspaceId: workspace.id,
        conversationId: direct.id,
        uploaderId: alice!.id,
        objectKey: `task-auth/${suffix}/used`,
        fileName: "used.txt",
        contentType: "text/plain",
        sizeBytes: 1,
      },
    });
    await db.message.create({
      data: {
        workspaceId: workspace.id,
        conversationId: direct.id,
        senderMemberId: direct.members.find((member) => member.userId === alice!.id)!.id,
        sequence: 2,
        body: "Uses attachment",
        attachment: { connect: { id: usedAttachment.id } },
      },
    });
    const otherAttachment = await db.attachment.create({
      data: {
        workspaceId: workspace.id,
        conversationId: peerDirect.id,
        uploaderId: bob!.id,
        objectKey: `task-auth/${suffix}/other`,
        fileName: "other.txt",
        contentType: "text/plain",
        sizeBytes: 1,
      },
    });
    const beforeTasks = (
      await board.execute(
        { workspaceId: workspace.id, userId: alice!.id },
        { operation: "list", requestId: crypto.randomUUID(), conversationId: direct.id },
      )
    ).tasks.length;
    for (const [attachmentId, title] of [
      [usedAttachment.id, "Rejected used attachment"],
      [otherAttachment.id, "Rejected foreign attachment"],
    ]) {
      await expect(
        board.execute(
          { workspaceId: workspace.id, userId: alice!.id },
          {
            operation: "create",
            requestId: crypto.randomUUID(),
            conversationId: direct.id,
            title,
            attachmentId,
          },
        ),
      ).rejects.toThrow("ACCESS_DENIED");
    }
    expect(
      (
        await board.execute(
          { workspaceId: workspace.id, userId: alice!.id },
          { operation: "list", requestId: crypto.randomUUID(), conversationId: direct.id },
        )
      ).tasks,
    ).toHaveLength(beforeTasks);
    expect(
      (
        await history.listOwnMessages(workspace.id, alice!.id, direct.id, { limit: 50 })
      ).messages.some(({ body }) => body.startsWith("Rejected")),
    ).toBe(false);

    const requestIds = Array.from({ length: 8 }, () => crypto.randomUUID());
    const concurrent = await Promise.all(
      requestIds.map((requestId, index) =>
        board.execute(
          { workspaceId: workspace.id, userId: alice!.id },
          {
            operation: "create",
            requestId,
            conversationId: publicChannel.id,
            title: `Concurrent task ${index}`,
          },
        ),
      ),
    );
    expect(new Set(concurrent.map(({ tasks }) => tasks[0]!.number)).size).toBe(requestIds.length);
    const sameRequest = crypto.randomUUID();
    const duplicated = await Promise.all(
      Array.from({ length: 4 }, () =>
        board.execute(
          { workspaceId: workspace.id, userId: alice!.id },
          {
            operation: "create",
            requestId: sameRequest,
            conversationId: publicChannel.id,
            title: "One idempotent task",
          },
        ),
      ),
    );
    expect(new Set(duplicated.map(({ tasks }) => tasks[0]!.messageId)).size).toBe(1);

    const ownership = duplicated[0]!.tasks[0]!;
    const claimed = await board.execute(
      { workspaceId: workspace.id, agentId: agent!.id },
      {
        operation: "claim",
        requestId: crypto.randomUUID(),
        target: `#${publicChannel.channelName}`,
        number: ownership.number,
      },
    );
    const repeatedClaim = await board.execute(
      { workspaceId: workspace.id, agentId: agent!.id },
      {
        operation: "claim",
        requestId: crypto.randomUUID(),
        target: `#${publicChannel.channelName}`,
        number: ownership.number,
      },
    );
    expect(repeatedClaim.tasks[0]).toEqual(claimed.tasks[0]);
    for (const operation of ["unclaim", "update"] as const) {
      await expect(
        board.execute(
          { workspaceId: workspace.id, agentId: peerAgent!.id },
          operation === "unclaim"
            ? {
                operation,
                requestId: crypto.randomUUID(),
                target: `#${publicChannel.channelName}`,
                number: ownership.number,
                expectedRevision: claimed.tasks[0]!.revision,
              }
            : {
                operation,
                requestId: crypto.randomUUID(),
                target: `#${publicChannel.channelName}`,
                number: ownership.number,
                status: "done",
                expectedRevision: claimed.tasks[0]!.revision,
              },
        ),
      ).rejects.toThrow("ACCESS_DENIED");
    }
    const unclaimed = await board.execute(
      { workspaceId: workspace.id, agentId: agent!.id },
      {
        operation: "unclaim",
        requestId: crypto.randomUUID(),
        target: `#${publicChannel.channelName}`,
        number: ownership.number,
        expectedRevision: claimed.tasks[0]!.revision,
      },
    );
    expect(unclaimed.tasks[0]).toMatchObject({ status: "todo", owner: null });

    const reclaimed = await board.execute(
      { workspaceId: workspace.id, agentId: agent!.id },
      {
        operation: "claim",
        requestId: crypto.randomUUID(),
        target: `#${publicChannel.channelName}`,
        number: ownership.number,
      },
    );
    await expect(
      board.execute(
        { workspaceId: workspace.id, agentId: agent!.id },
        {
          operation: "unclaim",
          requestId: crypto.randomUUID(),
          target: `#${publicChannel.channelName}`,
          number: ownership.number,
          expectedRevision: claimed.tasks[0]!.revision,
        },
      ),
    ).rejects.toThrow("CONFLICT");
    const afterStaleUnclaim = await board.execute(
      { workspaceId: workspace.id, agentId: agent!.id },
      {
        operation: "list",
        requestId: crypto.randomUUID(),
        target: `#${publicChannel.channelName}`,
      },
    );
    expect(afterStaleUnclaim.tasks.find((task) => task.number === ownership.number)).toEqual(
      reclaimed.tasks[0],
    );
    const done = await board.execute(
      { workspaceId: workspace.id, agentId: agent!.id },
      {
        operation: "update",
        requestId: crypto.randomUUID(),
        target: `#${publicChannel.channelName}`,
        number: ownership.number,
        status: "done",
        expectedRevision: reclaimed.tasks[0]!.revision,
      },
    );
    for (const expectedRevision of [reclaimed.tasks[0]!.revision, done.tasks[0]!.revision]) {
      await expect(
        board.execute(
          { workspaceId: workspace.id, agentId: agent!.id },
          {
            operation: "unclaim",
            requestId: crypto.randomUUID(),
            target: `#${publicChannel.channelName}`,
            number: ownership.number,
            expectedRevision,
          },
        ),
      ).rejects.toThrow("CONFLICT");
    }
    await expect(
      board.execute(
        { workspaceId: workspace.id, agentId: agent!.id },
        {
          operation: "claim",
          requestId: crypto.randomUUID(),
          target: `#${publicChannel.channelName}`,
          number: ownership.number,
        },
      ),
    ).rejects.toThrow("CONFLICT");
    const reset = await board.execute(
      { workspaceId: workspace.id, userId: alice!.id },
      {
        operation: "update",
        requestId: crypto.randomUUID(),
        conversationId: publicChannel.id,
        number: ownership.number,
        status: "todo",
        expectedRevision: done.tasks[0]!.revision,
      },
    );
    expect(
      (
        await board.execute(
          { workspaceId: workspace.id, agentId: agent!.id },
          {
            operation: "claim",
            requestId: crypto.randomUUID(),
            target: `#${publicChannel.channelName}`,
            number: ownership.number,
          },
        )
      ).tasks[0],
    ).toMatchObject({ status: "in_progress", revision: reset.tasks[0]!.revision + 1 });

    const raceTask = concurrent[0]!.tasks[0]!;
    const race = await Promise.allSettled(
      ["closed", "done"].map((nextStatus) =>
        board.execute(
          { workspaceId: workspace.id, userId: alice!.id },
          {
            operation: "update",
            requestId: crypto.randomUUID(),
            conversationId: publicChannel.id,
            number: raceTask.number,
            status: nextStatus as "closed" | "done",
            expectedRevision: raceTask.revision,
          },
        ),
      ),
    );
    expect(race.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(race.filter(({ status }) => status === "rejected")).toHaveLength(1);

    const closedTask = concurrent[2]!.tasks[0]!;
    await board.execute(
      { workspaceId: workspace.id, userId: alice!.id },
      {
        operation: "update",
        requestId: crypto.randomUUID(),
        conversationId: publicChannel.id,
        number: closedTask.number,
        status: "closed",
        expectedRevision: closedTask.revision,
      },
    );
    await expect(
      board.execute(
        { workspaceId: workspace.id, agentId: agent!.id },
        {
          operation: "claim",
          requestId: crypto.randomUUID(),
          target: `#${publicChannel.channelName}`,
          number: closedTask.number,
        },
      ),
    ).rejects.toThrow("CONFLICT");

    const ownerRace = concurrent[1]!.tasks[0]!;
    const ownerClaim = await board.execute(
      { workspaceId: workspace.id, agentId: agent!.id },
      {
        operation: "claim",
        requestId: crypto.randomUUID(),
        target: `#${publicChannel.channelName}`,
        number: ownerRace.number,
      },
    );
    const ownerReset = await board.execute(
      { workspaceId: workspace.id, userId: alice!.id },
      {
        operation: "update",
        requestId: crypto.randomUUID(),
        conversationId: publicChannel.id,
        number: ownerRace.number,
        status: "todo",
        expectedRevision: ownerClaim.tasks[0]!.revision,
      },
    );
    await board.execute(
      { workspaceId: workspace.id, agentId: peerAgent!.id },
      {
        operation: "claim",
        requestId: crypto.randomUUID(),
        target: `#${publicChannel.channelName}`,
        number: ownerRace.number,
      },
    );
    await expect(
      board.execute(
        { workspaceId: workspace.id, agentId: agent!.id },
        {
          operation: "update",
          requestId: crypto.randomUUID(),
          target: `#${publicChannel.channelName}`,
          number: ownerRace.number,
          status: "done",
          expectedRevision: ownerReset.tasks[0]!.revision,
        },
      ),
    ).rejects.toThrow();
  } finally {
    await db.workspace.deleteMany({ where: { id: { in: [workspace.id, otherWorkspace.id] } } });
    await db.user.deleteMany({ where: { id: { in: users.map(({ id }) => id) } } });
    await db.$disconnect();
  }
});
