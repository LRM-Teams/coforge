import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { decodeAgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import { PrismaClient } from "#src/generated/prisma/client";
import { TaskBoard } from "#src/server/tasks/task-board.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { PublicChannels } from "#src/server/conversations/public-channels.server";

test("TaskBoard atomically creates, converts, claims and revision-checks message Tasks", async () => {
  const connectionString = Bun.env.TASK_TEST_DATABASE_URL ?? Bun.env.DATABASE_URL;
  if (!connectionString)
    throw new Error("TASK_TEST_DATABASE_URL or DATABASE_URL must point to local PostgreSQL");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID();
  const handle = suffix.slice(0, 8);
  const alice = await db.user.create({
    data: { username: `task-alice-${handle}` },
  });
  const bob = await db.user.create({
    data: { username: `task-bob-${handle}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `tasks-${suffix}`,
      name: "Tasks",
      members: { create: [{ userId: alice.id }, { userId: bob.id }] },
      agents: {
        create: {
          name: `task-agent-${handle}`,
          displayName: "Task Agent",
          ownerId: alice.id,
          runtimeConfig: {},
        },
      },
    },
    include: { agents: true },
  });
  const agent = workspace.agents[0]!;
  const computer = await db.computer.create({
    data: { ownerId: alice.id, machineId: crypto.randomUUID() },
  });
  await db.agent.update({
    where: { id: agent.id },
    data: { computerId: computer.id },
  });
  await db.workspaceComputer.create({
    data: { workspaceId: workspace.id, computerId: computer.id },
  });
  const channel = await db.conversation.create({
    data: {
      workspaceId: workspace.id,
      channelName: `tasks-${handle}`,
      members: {
        create: [{ userId: alice.id }, { userId: bob.id }, { agentId: agent.id }],
      },
    },
    include: { members: true },
  });
  const aliceMember = channel.members.find((member) => member.userId === alice.id)!;
  const ordinary = await db.message.create({
    data: {
      workspaceId: workspace.id,
      conversationId: channel.id,
      senderMemberId: aliceMember.id,
      sequence: 1,
      body: "Convert this message",
    },
  });
  const realtime: Array<{
    messageId: string;
    publicationId?: string;
  }> = [];
  const board = new TaskBoard(db, {
    realtime: {
      async memberChanged() {},
      async messageAvailable(event) {
        realtime.push(event);
      },
    },
  });
  const command = {
    operation: "create" as const,
    idempotencyKey: crypto.randomUUID(),
    conversationId: channel.id,
    title: "Ship Task backend",
  };

  try {
    const direct = await db.conversation.create({
      data: {
        workspaceId: workspace.id,
        directKey: [alice.id, agent.id].sort().join(":"),
        members: { create: [{ userId: alice.id }, { agentId: agent.id }] },
      },
    });
    const attachment = await db.attachment.create({
      data: {
        workspaceId: workspace.id,
        conversationId: direct.id,
        uploaderId: alice.id,
        objectKey: `tasks/${suffix}`,
        fileName: "task.txt",
        contentType: "text/plain",
        sizeBytes: 4,
      },
    });
    const delivered: ReturnType<typeof decodeAgentMessageDelivery>[] = [];
    const directBoard = new TaskBoard(db, {
      publisher: {
        async publish(_channel, payload) {
          delivered.push(decodeAgentMessageDelivery(payload));
        },
      },
    });
    const directTask = await directBoard.execute(
      { workspaceId: workspace.id, userId: alice.id },
      {
        operation: "create",
        idempotencyKey: crypto.randomUUID(),
        conversationId: direct.id,
        title: "DM attachment task",
        attachmentId: attachment.id,
      },
    );
    expect(delivered[0]).toMatchObject({ target: `@${alice.username}` });
    expect(
      await db.message.findUnique({
        where: { id: directTask.tasks[0]!.messageId },
        select: {
          attachments: { select: { id: true } },
          deliveries: { select: { agentId: true } },
        },
      }),
    ).toEqual({
      attachments: [{ id: attachment.id }],
      deliveries: [{ agentId: agent.id }],
    });
    const directResource = await directBoard.execute(
      { workspaceId: workspace.id, agentId: agent.id },
      {
        operation: "create",
        idempotencyKey: crypto.randomUUID(),
        target: `@${alice.username}`,
        title: "DM temporary resource",
        assignee: `@${agent.name}`,
        createsResource: true,
      },
    );
    const directReceiptCommand = {
      operation: "receipt" as const,
      idempotencyKey: crypto.randomUUID(),
      target: `@${alice.username}`,
      number: directResource.tasks[0]!.number,
      receipt: {
        object: "DM test resource",
        purpose: "verify follow-up target",
        teardownOwner: `@${agent.name}`,
        securityPrivacy: "synthetic local data only",
        expiry: new Date(Date.now() + 86_400_000).toISOString(),
        runbook: "delete it",
        tracking: `task:${directResource.tasks[0]!.messageId}`,
      },
    };
    const directReceipt = await directBoard.execute(
      { workspaceId: workspace.id, agentId: agent.id },
      directReceiptCommand,
    );
    const replayedDirectReceipt = await directBoard.execute(
      { workspaceId: workspace.id, agentId: agent.id },
      directReceiptCommand,
    );
    expect(replayedDirectReceipt.resourceFollowup?.id).toBe(directReceipt.resourceFollowup?.id);
    expect(
      await db.reminder.findUniqueOrThrow({
        where: { id: directReceipt.resourceFollowup!.id },
        select: { target: true },
      }),
    ).toEqual({ target: `@${alice.username}:${directResource.tasks[0]!.messageId}` });

    const created = await board.execute({ workspaceId: workspace.id, userId: alice.id }, command);
    expect(created.tasks[0]).toMatchObject({
      number: 1,
      title: command.title,
      status: "todo",
      revision: 0,
    });
    expect(
      (await board.execute({ workspaceId: workspace.id, userId: alice.id }, command)).tasks[0]
        ?.messageId,
    ).toBe(created.tasks[0]?.messageId);
    expect(
      await db.message.count({
        where: { conversationId: channel.id, body: command.title },
      }),
    ).toBe(1);
    const competingClaims = await Promise.allSettled(
      [alice.id, bob.id].map((userId) =>
        board.execute(
          { workspaceId: workspace.id, userId },
          {
            operation: "claim",
            idempotencyKey: crypto.randomUUID(),
            conversationId: channel.id,
            number: 1,
          },
        ),
      ),
    );
    expect(competingClaims.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(competingClaims.filter(({ status }) => status === "rejected")).toHaveLength(1);

    const converted = await board.execute(
      { workspaceId: workspace.id, agentId: agent.id },
      {
        operation: "convert",
        idempotencyKey: crypto.randomUUID(),
        target: `#${channel.channelName}`,
        messageId: ordinary.id.slice(0, 8),
      },
    );
    expect(converted.tasks[0]).toMatchObject({
      number: 2,
      messageId: ordinary.id,
      title: ordinary.body,
    });
    expect(
      (
        await board.execute(
          { workspaceId: workspace.id, agentId: agent.id },
          {
            operation: "claim",
            idempotencyKey: crypto.randomUUID(),
            target: `#${channel.channelName}`,
            number: 2,
          },
        )
      ).tasks[0],
    ).toMatchObject({
      status: "in_progress",
      revision: 1,
      owner: { kind: "agent" },
    });

    await expect(
      board.execute(
        { workspaceId: workspace.id, userId: bob.id },
        {
          operation: "claim",
          idempotencyKey: crypto.randomUUID(),
          conversationId: channel.id,
          number: 2,
        },
      ),
    ).rejects.toThrow("CONFLICT");
    const review = await board.execute(
      { workspaceId: workspace.id, agentId: agent.id },
      {
        operation: "update",
        idempotencyKey: crypto.randomUUID(),
        target: `#${channel.channelName}`,
        number: 2,
        status: "in_review",
        expectedRevision: 1,
      },
    );
    await expect(
      board.execute(
        { workspaceId: workspace.id, agentId: agent.id },
        {
          operation: "update",
          idempotencyKey: crypto.randomUUID(),
          target: `#${channel.channelName}`,
          number: 2,
          status: "done",
          expectedRevision: 1,
        },
      ),
    ).rejects.toThrow("CONFLICT");
    expect(
      (
        await board.execute(
          { workspaceId: workspace.id, agentId: agent.id },
          {
            operation: "update",
            idempotencyKey: crypto.randomUUID(),
            target: `#${channel.channelName}`,
            number: 2,
            status: "done",
            expectedRevision: review.tasks[0]!.revision,
          },
        )
      ).tasks[0]?.status,
    ).toBe("done");
    expect(realtime.some((event) => event.publicationId?.endsWith(":task:1"))).toBe(true);
    expect(realtime.some((event) => event.publicationId?.endsWith(":task:2"))).toBe(true);

    const unowned = await board.execute(
      { workspaceId: workspace.id, userId: alice.id },
      {
        operation: "create",
        idempotencyKey: crypto.randomUUID(),
        conversationId: channel.id,
        title: "Close without claiming",
      },
    );
    const closed = await board.execute(
      { workspaceId: workspace.id, userId: alice.id },
      {
        operation: "update",
        idempotencyKey: crypto.randomUUID(),
        conversationId: channel.id,
        number: unowned.tasks[0]!.number,
        status: "closed",
        expectedRevision: 0,
      },
    );
    expect(closed.tasks[0]).toMatchObject({ status: "closed", owner: null });
    expect(
      (
        await board.execute(
          { workspaceId: workspace.id, userId: bob.id },
          {
            operation: "update",
            idempotencyKey: crypto.randomUUID(),
            conversationId: channel.id,
            number: closed.tasks[0]!.number,
            status: "todo",
            expectedRevision: closed.tasks[0]!.revision,
          },
        )
      ).tasks[0],
    ).toMatchObject({ status: "todo", owner: null });

    const postCommitCommand = {
      operation: "create" as const,
      idempotencyKey: crypto.randomUUID(),
      conversationId: channel.id,
      title: "Committed despite side-effect failures",
    };
    const failingSideEffects = new TaskBoard(db, {
      notifications: {
        async notifyMessage() {
          throw new Error("offline");
        },
      },
      realtime: {
        async memberChanged() {},
        async messageAvailable() {
          throw new Error("offline");
        },
      },
      publisher: {
        async publish() {
          throw new Error("offline");
        },
      },
    });
    const committed = await failingSideEffects.execute(
      { workspaceId: workspace.id, userId: alice.id },
      postCommitCommand,
    );
    const recovered = await failingSideEffects.execute(
      { workspaceId: workspace.id, userId: alice.id },
      postCommitCommand,
    );
    expect(recovered.tasks[0]!.messageId).toBe(committed.tasks[0]!.messageId);
    expect(
      await db.task.count({
        where: { requestId: postCommitCommand.idempotencyKey },
      }),
    ).toBe(1);

    const beforeInvalidBatch = await db.task.count({
      where: { conversationId: channel.id },
    });
    await expect(
      board.execute(
        { workspaceId: workspace.id, userId: alice.id },
        {
          operation: "create",
          idempotencyKey: crypto.randomUUID(),
          conversationId: channel.id,
          title: "mixed singular",
          titles: ["mixed batch"],
        },
      ),
    ).rejects.toThrow("INVALID_INPUT");
    expect(await db.task.count({ where: { conversationId: channel.id } })).toBe(beforeInvalidBatch);

    const batch = await board.execute(
      { workspaceId: workspace.id, agentId: agent.id },
      {
        operation: "create",
        idempotencyKey: crypto.randomUUID(),
        target: `#${channel.channelName}`,
        titles: ["batch one", "batch two"],
        assignee: `@${agent.name}`,
      },
    );
    expect(batch.tasks).toHaveLength(2);
    expect(batch.tasks.every((task) => task.status === "in_progress")).toBe(true);
    expect(batch.assignmentReceipt).toMatchObject({
      state: "started",
      assignee: `@${agent.name}`,
    });
    expect(batch.assignmentReceipt!.messageId).not.toBe(batch.tasks[0]!.messageId);
    const assignmentMessage = await db.message.findUniqueOrThrow({
      where: { id: batch.assignmentReceipt!.messageId },
      include: { deliveries: true },
    });
    expect(assignmentMessage.senderMemberId).toBeNull();
    expect(assignmentMessage.body).toBe(batch.assignmentReceipt!.content);
    expect(assignmentMessage.deliveries.map((delivery) => delivery.agentId)).toEqual([agent.id]);
    expect(batch.tasks[0]!.claimedAt).toEqual(expect.any(String));
    const allTasks = await board.execute(
      { workspaceId: workspace.id, agentId: agent.id },
      {
        operation: "list",
        idempotencyKey: crypto.randomUUID(),
        target: `#${channel.channelName}`,
        status: "all",
      },
    );
    expect(allTasks.tasks).toEqual(expect.arrayContaining(batch.tasks));
    const batchClosed = await board.execute(
      { workspaceId: workspace.id, agentId: agent.id },
      {
        operation: "update",
        idempotencyKey: crypto.randomUUID(),
        target: `#${channel.channelName}`,
        number: batch.tasks[1]!.number,
        status: "closed",
      },
    );
    const releasedClosed = await board.execute(
      { workspaceId: workspace.id, agentId: agent.id },
      {
        operation: "unclaim",
        idempotencyKey: crypto.randomUUID(),
        target: `#${channel.channelName}`,
        number: batchClosed.tasks[0]!.number,
      },
    );
    expect(releasedClosed.tasks[0]).toMatchObject({
      status: "closed",
      owner: null,
      claimedAt: null,
    });

    const releasedReview = await board.execute(
      { workspaceId: workspace.id, agentId: agent.id },
      {
        operation: "update",
        idempotencyKey: crypto.randomUUID(),
        target: `#${channel.channelName}`,
        number: batch.tasks[0]!.number,
        status: "in_review",
      },
    );
    await board.execute(
      { workspaceId: workspace.id, agentId: agent.id },
      {
        operation: "unclaim",
        idempotencyKey: crypto.randomUUID(),
        target: `#${channel.channelName}`,
        number: releasedReview.tasks[0]!.number,
      },
    );
    const partial = await board.execute(
      { workspaceId: workspace.id, agentId: agent.id },
      {
        operation: "claim",
        idempotencyKey: crypto.randomUUID(),
        target: `#${channel.channelName}`,
        numbers: [releasedReview.tasks[0]!.number, batchClosed.tasks[0]!.number],
      },
    );
    expect(partial.tasks[0]).toMatchObject({
      status: "in_review",
      owner: { kind: "agent" },
    });
    expect(partial.claims).toEqual([
      expect.objectContaining({
        number: releasedReview.tasks[0]!.number,
        success: true,
      }),
      expect.objectContaining({
        number: batchClosed.tasks[0]!.number,
        success: false,
      }),
    ]);
    const mixedSelectors = await board.execute(
      { workspaceId: workspace.id, agentId: agent.id },
      {
        operation: "claim",
        idempotencyKey: crypto.randomUUID(),
        target: `#${channel.channelName}`,
        number: releasedReview.tasks[0]!.number,
        numbers: [releasedReview.tasks[0]!.number],
        messageId: batchClosed.tasks[0]!.messageId,
      },
    );
    expect(mixedSelectors.claims).toEqual([
      expect.objectContaining({
        number: releasedReview.tasks[0]!.number,
        success: true,
      }),
      expect.objectContaining({
        messageId: batchClosed.tasks[0]!.messageId,
        success: false,
      }),
    ]);
    const singleClaim = await board.execute(
      { workspaceId: workspace.id, agentId: agent.id },
      {
        operation: "claim",
        idempotencyKey: crypto.randomUUID(),
        target: `#${channel.channelName}`,
        number: releasedReview.tasks[0]!.number,
      },
    );
    expect(singleClaim.claims).toEqual([
      {
        number: releasedReview.tasks[0]!.number,
        messageId: releasedReview.tasks[0]!.messageId,
        success: true,
      },
    ]);
    await expect(
      board.execute(
        { workspaceId: workspace.id, agentId: agent.id },
        {
          operation: "claim",
          idempotencyKey: crypto.randomUUID(),
          target: `#${channel.channelName}`,
          numbers: [batchClosed.tasks[0]!.number],
        },
      ),
    ).rejects.toThrow("CONFLICT");
    for (const changes of [
      { title: "   " },
      { title: "x".repeat(10_001) },
      { description: "x".repeat(50_001) },
    ]) {
      await expect(
        board.execute(
          { workspaceId: workspace.id, userId: alice.id },
          {
            operation: "amend",
            idempotencyKey: crypto.randomUUID(),
            conversationId: channel.id,
            number: batch.tasks[1]!.number,
            ...changes,
          },
        ),
      ).rejects.toThrow("INVALID_INPUT");
    }

    const amendment = await board.execute(
      { workspaceId: workspace.id, agentId: agent.id },
      {
        operation: "amend",
        idempotencyKey: crypto.randomUUID(),
        target: `#${channel.channelName}`,
        number: batch.tasks[1]!.number,
        title: "batch two amended",
        description: "exact acceptance criteria",
        expectedRevision: releasedClosed.tasks[0]!.revision,
      },
    );
    expect(amendment.history?.[0]).toMatchObject({
      eventType: "amended",
      payload: {
        changes: {
          title: { from: "batch two", to: "batch two amended" },
          description: { from: null, to: "exact acceptance criteria" },
        },
      },
    });
    const amendmentRace = await Promise.allSettled(
      ["writer a", "writer b"].map((title) =>
        board.execute(
          { workspaceId: workspace.id, agentId: agent.id },
          {
            operation: "amend",
            idempotencyKey: crypto.randomUUID(),
            target: `#${channel.channelName}`,
            number: batch.tasks[1]!.number,
            title,
            expectedRevision: amendment.tasks[0]!.revision,
          },
        ),
      ),
    );
    expect(amendmentRace.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);

    const resource = await board.execute(
      { workspaceId: workspace.id, agentId: agent.id },
      {
        operation: "create",
        idempotencyKey: crypto.randomUUID(),
        target: `#${channel.channelName}`,
        title: "temporary resource",
        assignee: `@${agent.name}`,
        createsResource: true,
      },
    );
    await expect(
      board.execute(
        { workspaceId: workspace.id, agentId: agent.id },
        {
          operation: "update",
          idempotencyKey: crypto.randomUUID(),
          target: `#${channel.channelName}`,
          number: resource.tasks[0]!.number,
          status: "done",
        },
      ),
    ).rejects.toThrow("CONFLICT");
    const receipt = await board.execute(
      { workspaceId: workspace.id, agentId: agent.id },
      {
        operation: "receipt",
        idempotencyKey: crypto.randomUUID(),
        target: `#${channel.channelName}`,
        number: resource.tasks[0]!.number,
        receipt: {
          object: "temporary test database",
          purpose: "integration verification",
          teardownOwner: `@${agent.name}`,
          securityPrivacy: "synthetic local data only",
          expiry: new Date(Date.now() + 86_400_000).toISOString(),
          runbook: "drop the temporary database",
          tracking: `task:${resource.tasks[0]!.messageId}`,
        },
      },
    );
    expect(receipt.resourceFollowup).toMatchObject({ ownerAgentId: agent.id });
    expect(receipt.tasks[0]).toMatchObject({
      requiresResourceReceipt: true,
      resourceReceiptRecordedAt: expect.any(String),
      resourceReceipt: expect.objectContaining({
        object: "temporary test database",
      }),
    });
    expect(
      (
        await board.execute(
          { workspaceId: workspace.id, agentId: agent.id },
          {
            operation: "update",
            idempotencyKey: crypto.randomUUID(),
            target: `#${channel.channelName}`,
            number: resource.tasks[0]!.number,
            status: "done",
          },
        )
      ).tasks[0]!.status,
    ).toBe("done");

    const deleted = await board.execute(
      { workspaceId: workspace.id, agentId: agent.id },
      {
        operation: "create",
        idempotencyKey: crypto.randomUUID(),
        target: `#${channel.channelName}`,
        title: "deleted number must stay reserved",
      },
    );
    await board.execute(
      { workspaceId: workspace.id, agentId: agent.id },
      {
        operation: "delete",
        idempotencyKey: crypto.randomUUID(),
        target: `#${channel.channelName}`,
        number: deleted.tasks[0]!.number,
      },
    );
    const afterDelete = await board.execute(
      { workspaceId: workspace.id, agentId: agent.id },
      {
        operation: "create",
        idempotencyKey: crypto.randomUUID(),
        target: `#${channel.channelName}`,
        title: "number after deletion",
      },
    );
    expect(afterDelete.tasks[0]!.number).toBe(deleted.tasks[0]!.number + 1);
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.computer.delete({ where: { id: computer.id } });
    await db.user.deleteMany({ where: { id: { in: [alice.id, bob.id] } } });
    await db.$disconnect();
  }
});

test("assignment receipts survive mute and disconnect without waking unrelated Agents", async () => {
  const connectionString = Bun.env.TASK_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("TASK_TEST_DATABASE_URL must point to local PostgreSQL");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID().slice(0, 8);
  const human = await db.user.create({ data: { username: `receipt-${suffix}` } });
  const workspace = await db.workspace.create({
    data: {
      slug: `receipt-${suffix}`,
      name: "Receipt test",
      members: { create: { userId: human.id, role: "owner" } },
      agents: {
        create: ["assigned", "muted"].map((name) => ({
          name: `${name}-${suffix}`,
          displayName: name,
          ownerId: human.id,
          runtimeConfig: {},
        })),
      },
    },
    include: { agents: true },
  });
  const [assigned, unrelated] = workspace.agents;
  const computer = await db.computer.create({
    data: { ownerId: human.id, machineId: crypto.randomUUID() },
  });
  await db.agent.updateMany({
    where: { workspaceId: workspace.id },
    data: { computerId: computer.id },
  });
  await db.workspaceComputer.create({
    data: { workspaceId: workspace.id, computerId: computer.id },
  });
  const channel = await db.conversation.create({
    data: {
      workspaceId: workspace.id,
      channelName: `receipt-${suffix}`,
      members: {
        create: [
          { userId: human.id },
          ...workspace.agents.map((agent) => ({ agentId: agent.id, channelMuted: true })),
        ],
      },
    },
  });
  const principal = { workspaceId: workspace.id, userId: human.id };
  const agentPrincipal = { workspaceId: workspace.id, agentId: assigned!.id };
  const target = `#${channel.channelName}`;
  const repo = new PrismaDirectConversationRepository(db);
  const published: ReturnType<typeof decodeAgentMessageDelivery>[] = [];
  const signaled: string[] = [];
  const board = new TaskBoard(db, {
    realtime: {
      async memberChanged() {},
      async messageAvailable(event) {
        signaled.push(event.messageId);
      },
    },
    publisher: {
      async publish(_channel, payload) {
        published.push(decodeAgentMessageDelivery(payload));
        throw new Error("connection lost");
      },
    },
  });
  try {
    const command = {
      operation: "create" as const,
      idempotencyKey: crypto.randomUUID(),
      conversationId: channel.id,
      titles: ["First reserved task", "Second reserved task"],
      assignee: `@${assigned!.name}`,
    };
    const created = await board.execute(principal, command);
    expect(created.tasks.map((task) => task.status)).toEqual(["todo", "todo"]);
    expect(created.tasks.map((task) => task.claimedAt)).toEqual([null, null]);
    expect(created.assignmentReceipt).toMatchObject({ state: "assigned" });
    const receipt = created.assignmentReceipt!;
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      messageId: receipt.messageId,
      latestSenderKind: "system",
      latestSenderHandle: "",
      latestSenderDescription: "",
      agentId: assigned!.id,
      target,
    });
    const retried = await board.execute(principal, command);
    expect(retried.assignmentReceipt).toEqual(receipt);
    expect(published).toHaveLength(1);
    // Two Task messages, the creation notice, and the one receipt; the retry wrote nothing.
    expect(await db.message.count({ where: { conversationId: channel.id } })).toBe(4);
    expect(await repo.readPendingAgentDeliveries(workspace.id, assigned!.id)).toEqual([
      expect.objectContaining({
        messageId: receipt.messageId,
        latestSenderKind: "system",
        latestSenderHandle: "",
        latestSenderDescription: "",
        target,
      }),
    ]);
    expect(await repo.readAgentRecoveryContext(workspace.id, unrelated!.id)).toEqual({
      resumeMessages: [],
      unreadSummary: {},
    });
    const recovery = await repo.readAgentRecoveryContext(workspace.id, assigned!.id);
    expect(recovery.unreadSummary).toEqual({ [target]: 1 });
    expect(recovery.resumeMessages.map((message) => message.messageId)).toEqual([
      receipt.messageId,
    ]);
    expect(
      (await repo.readPendingAgentContext(workspace.id, assigned!.id, target, 0)).map(
        (message) => message.senderKind,
      ),
    ).toEqual(["system"]);
    const page = await repo.readMessagesPage(workspace.id, assigned!.id, target, {
      around: receipt.messageId,
    });
    expect(page.messages.find((message) => message.id === receipt.messageId)).toMatchObject({
      senderKind: "system",
      body: receipt.content,
    });
    const browser = await new PublicChannels(db).open(workspace.id, human.id, channel.id);
    expect(browser.messages.find((message) => message.id === receipt.messageId)).toMatchObject({
      senderKind: "system",
      senderMemberId: null,
      senderName: "System",
    });
    await repo.advanceAgentReadThrough(
      workspace.id,
      assigned!.id,
      target,
      recovery.resumeMessages[0]!.sequence,
    );
    expect((await repo.readAgentRecoveryContext(workspace.id, assigned!.id)).unreadSummary).toEqual(
      {},
    );

    // The Agent owner being Workspace owner must not confer admin authority on the Agent.
    await expect(
      board.execute(agentPrincipal, {
        ...command,
        idempotencyKey: crypto.randomUUID(),
        conversationId: undefined,
        target,
        assignee: `@${unrelated!.name}`,
      }),
    ).rejects.toThrow("ACCESS_DENIED");
    const changed = await board.execute(principal, {
      operation: "assign",
      idempotencyKey: crypto.randomUUID(),
      conversationId: channel.id,
      number: created.tasks[0]!.number,
      assignee: `@${unrelated!.name}`,
    });
    expect(changed.assignmentReceipt!.messageId).not.toBe(receipt.messageId);
    await expect(
      board.execute(agentPrincipal, {
        operation: "assign",
        idempotencyKey: crypto.randomUUID(),
        target,
        number: created.tasks[0]!.number,
        assignee: `@${assigned!.name}`,
      }),
    ).rejects.toThrow("ACCESS_DENIED");
    // An Agent message with no Agent mention never wakes another Agent; an explicit Agent
    // mention is a directed handoff and does (PR #338's Agent-to-Agent wake).
    const beforeAgentSend = await repo.readPendingAgentDeliveries(workspace.id, unrelated!.id);
    await repo.sendAgentMessage(channel.id, assigned!.id, "ordinary Agent message, no mention");
    expect(await repo.readPendingAgentDeliveries(workspace.id, unrelated!.id)).toEqual(
      beforeAgentSend,
    );
    await repo.sendAgentMessage(
      channel.id,
      assigned!.id,
      `@${unrelated!.name} directed Agent handoff`,
    );
    const afterAgentMention = await repo.readPendingAgentDeliveries(workspace.id, unrelated!.id);
    expect(afterAgentMention).toHaveLength(beforeAgentSend.length + 1);
    expect(afterAgentMention).toContainEqual(
      expect.objectContaining({
        latestSenderKind: "agent",
        latestSenderHandle: assigned!.name,
        target,
        body: `@${unrelated!.name} directed Agent handoff`,
      }),
    );

    const mine = await board.execute(agentPrincipal, {
      operation: "list",
      idempotencyKey: crypto.randomUUID(),
      mine: true,
    });
    expect(mine.tasks).toEqual([
      expect.objectContaining({ number: created.tasks[1]!.number, channelRef: target }),
    ]);
    const direct = await repo.getOrCreateUserAgent(workspace.id, human.id, assigned!.id);
    const directCreated = await board.execute(agentPrincipal, {
      operation: "create",
      idempotencyKey: crypto.randomUUID(),
      target: `@${human.username}`,
      title: "Direct assignment",
      assignee: `@${assigned!.name}`,
    });
    expect(
      (await repo.readPendingAgentDeliveries(workspace.id, assigned!.id)).find(
        (message) => message.conversationId === direct.id,
      ),
    ).toMatchObject({
      target: `@${human.username}`,
      latestSenderKind: "system",
      latestSenderHandle: "",
      latestSenderDescription: "",
      messageId: directCreated.assignmentReceipt!.messageId,
    });
    const directMine = await board.execute(agentPrincipal, {
      operation: "list",
      idempotencyKey: crypto.randomUUID(),
      mine: true,
    });
    expect(directMine.tasks.find((task) => task.conversationId === direct.id)?.channelRef).toBe(
      `@${human.username}`,
    );
    expect(
      (await repo.readAgentRecoveryContext(workspace.id, assigned!.id)).resumeMessages.find(
        (message) => message.conversationId === direct.id,
      ),
    ).toMatchObject({
      messageId: directCreated.assignmentReceipt!.messageId,
      latestSenderKind: "system",
      latestSenderHandle: "",
      latestSenderDescription: "",
      target: `@${human.username}`,
    });
    await board.execute(agentPrincipal, {
      operation: "unclaim",
      idempotencyKey: crypto.randomUUID(),
      target: `@${human.username}`,
      number: directCreated.tasks[0]!.number,
    });
    const directBrowser = await repo.openForUser(workspace.id, human.id, assigned!.id);
    expect(
      directBrowser.messages.find(
        (message) => message.id === directCreated.assignmentReceipt!.messageId,
      )?.senderKind,
    ).toBe("system");
    const selfAssignCommand = {
      operation: "assign" as const,
      idempotencyKey: crypto.randomUUID(),
      target: `@${human.username}`,
      number: directCreated.tasks[0]!.number,
      assignee: `@${assigned!.name}`,
    };
    const selfAssigned = await board.execute(agentPrincipal, selfAssignCommand);
    await board.execute(principal, {
      ...selfAssignCommand,
      idempotencyKey: crypto.randomUUID(),
      target: undefined,
      conversationId: direct.id,
      assignee: `@${human.username}`,
    });
    const signalsBeforeRetry = signaled.length;
    const selfRetried = await board.execute(agentPrincipal, selfAssignCommand);
    expect(selfRetried.assignmentReceipt).toEqual(selfAssigned.assignmentReceipt);
    expect(signaled).toHaveLength(signalsBeforeRetry);
    await board.execute(principal, {
      operation: "delete",
      idempotencyKey: crypto.randomUUID(),
      conversationId: direct.id,
      number: directCreated.tasks[0]!.number,
    });
    expect(await board.execute(agentPrincipal, selfAssignCommand)).toMatchObject({
      tasks: [],
      assignmentReceipt: selfAssigned.assignmentReceipt,
    });

    const beforeRollback = await db.task.count({ where: { conversationId: channel.id } });
    const beforeRollbackMessages = await db.message.count({
      where: { conversationId: channel.id },
    });
    // A disposable-DB constraint fails exactly the system Message write, after Task insertion.
    await db.$executeRaw`ALTER TABLE "messages" ADD CONSTRAINT "test_reject_system_receipt" CHECK ("senderMemberId" IS NOT NULL) NOT VALID`;
    try {
      await expect(
        board.execute(principal, { ...command, idempotencyKey: crypto.randomUUID() }),
      ).rejects.toThrow();
      await expect(
        board.execute(principal, {
          operation: "assign",
          idempotencyKey: crypto.randomUUID(),
          conversationId: channel.id,
          number: created.tasks[1]!.number,
          assignee: `@${unrelated!.name}`,
        }),
      ).rejects.toThrow();
      expect(await db.task.count({ where: { conversationId: channel.id } })).toBe(beforeRollback);
      expect(await db.message.count({ where: { conversationId: channel.id } })).toBe(
        beforeRollbackMessages,
      );
      const afterRollback = await board.execute(agentPrincipal, {
        operation: "list",
        idempotencyKey: crypto.randomUUID(),
        mine: true,
      });
      expect(
        afterRollback.tasks.find((task) => task.conversationId === channel.id)?.owner?.memberId,
      ).toBe(created.tasks[1]!.owner!.memberId);
    } finally {
      await db.$executeRaw`ALTER TABLE "messages" DROP CONSTRAINT "test_reject_system_receipt"`;
    }
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.computer.delete({ where: { id: computer.id } });
    await db.user.delete({ where: { id: human.id } });
    await db.$disconnect();
  }
});

test("a created Task's title stores its references as tokens, and its own mention rows decide who a muted channel wakes", async () => {
  const connectionString = Bun.env.TASK_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("TASK_TEST_DATABASE_URL must point to local PostgreSQL");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID().slice(0, 8);
  const human = await db.user.create({ data: { username: `tokens-${suffix}` } });
  const workspace = await db.workspace.create({
    data: {
      slug: `task-tokens-${suffix}`,
      name: "Task tokens",
      members: { create: { userId: human.id, role: "owner" } },
      agents: {
        create: ["helper", "quiet", "open"].map((name) => ({
          name: `${name}-${suffix}`,
          displayName: name,
          ownerId: human.id,
          runtimeConfig: {},
        })),
      },
    },
    include: { agents: true },
  });
  const agentNamed = (name: string) =>
    workspace.agents.find((agent) => agent.name === `${name}-${suffix}`)!;
  const [helper, quiet, open] = [agentNamed("helper"), agentNamed("quiet"), agentNamed("open")];
  const computer = await db.computer.create({
    data: { ownerId: human.id, machineId: crypto.randomUUID() },
  });
  await db.agent.updateMany({
    where: { workspaceId: workspace.id },
    data: { computerId: computer.id },
  });
  try {
    const product = await db.conversation.create({
      data: { workspaceId: workspace.id, channelName: `product-${suffix}` },
    });
    const channel = await db.conversation.create({
      data: {
        workspaceId: workspace.id,
        channelName: `work-${suffix}`,
        members: {
          create: [
            { userId: human.id },
            { agentId: helper.id, channelMuted: true },
            { agentId: quiet.id, channelMuted: true },
            { agentId: open.id },
          ],
        },
      },
    });
    const published: ReturnType<typeof decodeAgentMessageDelivery>[] = [];
    const board = new TaskBoard(db, {
      publisher: {
        async publish(_channel, payload) {
          published.push(decodeAgentMessageDelivery(payload));
        },
      },
    });
    const principal = { workspaceId: workspace.id, userId: human.id };
    const existing = (
      await board.execute(principal, {
        operation: "create",
        idempotencyKey: crypto.randomUUID(),
        conversationId: channel.id,
        title: "Existing task",
      })
    ).tasks[0]!;
    published.length = 0;

    const created = await board.execute(principal, {
      operation: "create",
      idempotencyKey: crypto.randomUUID(),
      conversationId: channel.id,
      titles: [
        `@${helper.name} see #product-${suffix} and task #${existing.number}`,
        `not \`@${quiet.name}\` nor [ask @${quiet.name}](https://example.com)`,
      ],
      assignee: `@${helper.name}`,
    });
    const [referencing, codeOnly] = created.tasks;
    const rows = await db.message.findMany({
      where: { id: { in: [referencing!.messageId, codeOnly!.messageId] } },
      orderBy: { sequence: "asc" },
      select: {
        body: true,
        task: { select: { title: true } },
        mentions: { select: { actorId: true } },
        deliveries: { select: { agentId: true } },
      },
    });

    // The Task's message stores its references as tokens, and the Task keeps that same body as its
    // title, as a converted Task keeps its message's.
    const tokenized = `<@agent:${helper.id}> see <@channel:${product.id}:product-${suffix}> and <@task:${existing.number}>`;
    expect(rows.map((row) => [row.body, row.task!.title])).toEqual([
      [tokenized, tokenized],
      [
        `not \`@${quiet.name}\` nor [ask @${quiet.name}](https://example.com)`,
        `not \`@${quiet.name}\` nor [ask @${quiet.name}](https://example.com)`,
      ],
    ]);
    expect(rows.map((row) => row.mentions.map((mention) => mention.actorId))).toEqual([
      [helper.id],
      [],
    ]);
    // Every reader still sees text.
    const readable = `@${helper.name} see #product-${suffix} and task #${existing.number}`;
    expect(referencing!.title).toBe(readable);
    const notice = await db.message.findFirstOrThrow({
      where: { conversationId: channel.id, senderMemberId: null, body: { contains: "created" } },
      orderBy: { sequence: "desc" },
      select: { body: true },
    });
    expect(notice.body).toContain(`"${readable}"`);
    expect(notice.body).not.toContain("<@");

    // Each Task's message wakes every unmuted Agent, plus a muted Agent its own mention rows name.
    // The quiet Agent, written only in code and a link label, stays muted.
    expect(rows.map((row) => row.deliveries.map((delivery) => delivery.agentId).sort())).toEqual([
      [helper.id, open.id].sort(),
      [open.id],
    ]);
    const taskPayloads = published.filter(
      (payload) => payload.messageId === referencing!.messageId,
    );
    expect(taskPayloads.map((payload) => [payload.agentId, payload.body]).sort()).toEqual(
      [
        [helper.id, readable],
        [open.id, readable],
      ].sort(),
    );

    // The assignment receipt is unchanged: top level in the conversation, delivered only to the
    // assignee, on the conversation's own target.
    const receipt = await db.message.findUniqueOrThrow({
      where: { id: created.assignmentReceipt!.messageId },
      select: { threadRootId: true, deliveries: { select: { agentId: true } } },
    });
    expect(receipt).toEqual({ threadRootId: null, deliveries: [{ agentId: helper.id }] });
    expect(
      published
        .filter((payload) => payload.messageId === created.assignmentReceipt!.messageId)
        .map((payload) => [payload.agentId, payload.target]),
    ).toEqual([[helper.id, `#${channel.channelName}`]]);
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.computer.delete({ where: { id: computer.id } });
    await db.user.delete({ where: { id: human.id } });
    await db.$disconnect();
  }
});
