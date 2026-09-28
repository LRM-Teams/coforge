import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { ConversationHistory } from "#src/server/conversations/conversation-history.server";
import { TaskBoard } from "#src/server/tasks/task-board.server";

test("TaskBoard enforces conversation authorization, idempotency, and ownership under contention", async () => {
  const connectionString = Bun.env.TASK_TEST_DATABASE_URL ?? Bun.env.DATABASE_URL;
  if (!connectionString)
    throw new Error("TASK_TEST_DATABASE_URL or DATABASE_URL must point to local PostgreSQL");

  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const board = new TaskBoard(db);
  // Fixture messages take the next free sequence: Task writes also post server notices.
  const nextSequence = async (conversationId: string) =>
    ((
      await db.message.findFirst({
        where: { conversationId },
        orderBy: { sequence: "desc" },
        select: { sequence: true },
      })
    )?.sequence ?? 0) + 1;
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
        idempotencyKey: crypto.randomUUID(),
        conversationId: publicChannel.id,
        title: "Visible public task",
      },
    );
    await expect(
      board.execute(
        { workspaceId: workspace.id, userId: alice!.id },
        {
          operation: "unclaim",
          idempotencyKey: crypto.randomUUID(),
          conversationId: publicChannel.id,
          number: seed.tasks[0]!.number,
        },
      ),
    ).rejects.toThrow("ACCESS_DENIED");

    expect(
      await board.execute(
        { workspaceId: workspace.id, userId: bob!.id },
        {
          operation: "list",
          idempotencyKey: crypto.randomUUID(),
          conversationId: publicChannel.id,
        },
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
          { ...command, idempotencyKey: crypto.randomUUID(), conversationId: publicChannel.id },
        ),
      ).rejects.toThrow("ACCESS_DENIED");
    }
    await expect(
      board.execute(
        { workspaceId: otherWorkspace.id, userId: mallory!.id },
        {
          operation: "list",
          idempotencyKey: crypto.randomUUID(),
          conversationId: publicChannel.id,
        },
      ),
    ).rejects.toThrow("NOT_FOUND");
    await expect(
      board.execute(
        { workspaceId: workspace.id, userId: bob!.id },
        { operation: "list", idempotencyKey: crypto.randomUUID(), conversationId: direct.id },
      ),
    ).rejects.toThrow("ACCESS_DENIED");
    const unrelatedDirectMember = await db.conversationMember.create({
      data: { workspaceId: workspace.id, conversationId: direct.id, userId: bob!.id },
    });
    await expect(
      board.execute(
        { workspaceId: workspace.id, userId: bob!.id },
        { operation: "list", idempotencyKey: crypto.randomUUID(), conversationId: direct.id },
      ),
    ).rejects.toThrow("ACCESS_DENIED");
    await db.conversationMember.delete({ where: { id: unrelatedDirectMember.id } });
    await expect(
      board.execute(
        { workspaceId: workspace.id, agentId: agent!.id },
        { operation: "list", idempotencyKey: crypto.randomUUID(), target: `@${bob!.username}` },
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
        sequence: await nextSequence(publicChannel.id),
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
            idempotencyKey: crypto.randomUUID(),
            conversationId: publicChannel.id,
            messageId,
          },
        ),
      ).rejects.toThrow("NOT_FOUND");
    }
    const ambiguousSequence = await nextSequence(publicChannel.id);
    await db.message.createMany({
      data: [1, 2].map((tail, index) => ({
        id: `${ambiguousPrefix}-0000-4000-8000-00000000000${tail}`,
        workspaceId: workspace.id,
        conversationId: publicChannel.id,
        senderMemberId: aliceChannelMember.id,
        sequence: ambiguousSequence + index,
        body: `Ambiguous ${tail}`,
      })),
    });
    await expect(
      board.execute(
        { workspaceId: workspace.id, userId: alice!.id },
        {
          operation: "convert",
          idempotencyKey: crypto.randomUUID(),
          conversationId: publicChannel.id,
          messageId: ambiguousPrefix,
        },
      ),
    ).rejects.toThrow("CONFLICT");

    const agentCreated = await board.execute(
      { workspaceId: workspace.id, agentId: agent!.id },
      {
        operation: "create",
        idempotencyKey: crypto.randomUUID(),
        target: `@${alice!.username}`,
        title: "Agent-owned DM task",
      },
    );
    expect(
      (
        await board.execute(
          { workspaceId: workspace.id, agentId: agent!.id },
          { operation: "list", idempotencyKey: crypto.randomUUID(), target: `@${alice!.username}` },
        )
      ).tasks,
    ).toEqual(agentCreated.tasks);
    const agentClaimed = await board.execute(
      { workspaceId: workspace.id, agentId: agent!.id },
      {
        operation: "claim",
        idempotencyKey: crypto.randomUUID(),
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
        { operation: "list", idempotencyKey: crypto.randomUUID(), target: `@${bob!.username}` },
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
        sequence: await nextSequence(direct.id),
        body: "Uses attachment",
        attachments: { connect: [{ id: usedAttachment.id }] },
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
        { operation: "list", idempotencyKey: crypto.randomUUID(), conversationId: direct.id },
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
            idempotencyKey: crypto.randomUUID(),
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
          { operation: "list", idempotencyKey: crypto.randomUUID(), conversationId: direct.id },
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
            idempotencyKey: requestId,
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
            idempotencyKey: sameRequest,
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
        idempotencyKey: crypto.randomUUID(),
        target: `#${publicChannel.channelName}`,
        number: ownership.number,
      },
    );
    const repeatedClaim = await board.execute(
      { workspaceId: workspace.id, agentId: agent!.id },
      {
        operation: "claim",
        idempotencyKey: crypto.randomUUID(),
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
                idempotencyKey: crypto.randomUUID(),
                target: `#${publicChannel.channelName}`,
                number: ownership.number,
                expectedRevision: claimed.tasks[0]!.revision,
              }
            : {
                operation,
                idempotencyKey: crypto.randomUUID(),
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
        idempotencyKey: crypto.randomUUID(),
        target: `#${publicChannel.channelName}`,
        number: ownership.number,
        expectedRevision: claimed.tasks[0]!.revision,
      },
    );
    // Releasing assignment is independent from workflow state in the published contract.
    expect(unclaimed.tasks[0]).toMatchObject({ status: "in_progress", owner: null });

    const reclaimed = await board.execute(
      { workspaceId: workspace.id, agentId: agent!.id },
      {
        operation: "claim",
        idempotencyKey: crypto.randomUUID(),
        target: `#${publicChannel.channelName}`,
        number: ownership.number,
      },
    );
    await expect(
      board.execute(
        { workspaceId: workspace.id, agentId: agent!.id },
        {
          operation: "unclaim",
          idempotencyKey: crypto.randomUUID(),
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
        idempotencyKey: crypto.randomUUID(),
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
        idempotencyKey: crypto.randomUUID(),
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
            idempotencyKey: crypto.randomUUID(),
            target: `#${publicChannel.channelName}`,
            number: ownership.number,
            expectedRevision,
          },
        ),
      ).rejects.toThrow("CONFLICT");
    }
    expect(
      (
        await board.execute(
          { workspaceId: workspace.id, agentId: agent!.id },
          {
            operation: "claim",
            idempotencyKey: crypto.randomUUID(),
            target: `#${publicChannel.channelName}`,
            number: ownership.number,
          },
        )
      ).claims,
    ).toEqual([{ number: ownership.number, success: false, reason: "task is done" }]);
    const reset = await board.execute(
      { workspaceId: workspace.id, userId: alice!.id },
      {
        operation: "update",
        idempotencyKey: crypto.randomUUID(),
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
            idempotencyKey: crypto.randomUUID(),
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
            idempotencyKey: crypto.randomUUID(),
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
        idempotencyKey: crypto.randomUUID(),
        conversationId: publicChannel.id,
        number: closedTask.number,
        status: "closed",
        expectedRevision: closedTask.revision,
      },
    );
    expect(
      (
        await board.execute(
          { workspaceId: workspace.id, agentId: agent!.id },
          {
            operation: "claim",
            idempotencyKey: crypto.randomUUID(),
            target: `#${publicChannel.channelName}`,
            number: closedTask.number,
          },
        )
      ).claims,
    ).toEqual([{ number: closedTask.number, success: false, reason: "task is closed" }]);

    const ownerRace = concurrent[1]!.tasks[0]!;
    const ownerClaim = await board.execute(
      { workspaceId: workspace.id, agentId: agent!.id },
      {
        operation: "claim",
        idempotencyKey: crypto.randomUUID(),
        target: `#${publicChannel.channelName}`,
        number: ownerRace.number,
      },
    );
    const ownerReset = await board.execute(
      { workspaceId: workspace.id, userId: alice!.id },
      {
        operation: "update",
        idempotencyKey: crypto.randomUUID(),
        conversationId: publicChannel.id,
        number: ownerRace.number,
        status: "todo",
        expectedRevision: ownerClaim.tasks[0]!.revision,
      },
    );
    const releaseCommand = {
      operation: "assign" as const,
      idempotencyKey: crypto.randomUUID(),
      conversationId: publicChannel.id,
      number: ownerRace.number,
      assignee: null,
      expectedRevision: ownerReset.tasks[0]!.revision,
    };
    // Another Agent may not take the Task away from the Agent holding it.
    await expect(
      board.execute(
        { workspaceId: workspace.id, agentId: peerAgent!.id },
        {
          operation: "assign",
          idempotencyKey: crypto.randomUUID(),
          target: `#${publicChannel.channelName}`,
          number: ownerRace.number,
          assignee: null,
          expectedRevision: ownerReset.tasks[0]!.revision,
        },
      ),
    ).rejects.toThrow("ACCESS_DENIED");
    // Any human member of the conversation may, with no Workspace role needed.
    const ownerReleased = await board.execute(
      { workspaceId: workspace.id, userId: alice!.id },
      releaseCommand,
    );
    expect(ownerReleased.tasks[0]!.owner).toBeNull();
    await board.execute(
      { workspaceId: workspace.id, agentId: peerAgent!.id },
      {
        operation: "claim",
        idempotencyKey: crypto.randomUUID(),
        target: `#${publicChannel.channelName}`,
        number: ownerRace.number,
      },
    );
    await expect(
      board.execute(
        { workspaceId: workspace.id, agentId: agent!.id },
        {
          operation: "update",
          idempotencyKey: crypto.randomUUID(),
          target: `#${publicChannel.channelName}`,
          number: ownerRace.number,
          status: "done",
          expectedRevision: ownerReleased.tasks[0]!.revision,
        },
      ),
    ).rejects.toThrow();
  } finally {
    await db.workspace.deleteMany({ where: { id: { in: [workspace.id, otherWorkspace.id] } } });
    await db.user.deleteMany({ where: { id: { in: users.map(({ id }) => id) } } });
    await db.$disconnect();
  }
});

test("TaskBoard lets any human member reassign or unassign a Task and enforces revision", async () => {
  const connectionString = Bun.env.TASK_TEST_DATABASE_URL ?? Bun.env.DATABASE_URL;
  if (!connectionString)
    throw new Error("TASK_TEST_DATABASE_URL or DATABASE_URL must point to local PostgreSQL");

  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const board = new TaskBoard(db);
  const suffix = crypto.randomUUID();
  const short = suffix.slice(0, 8);
  const [alice, bob, carol] = await Promise.all(
    ["alice", "bob", "carol"].map((name) =>
      db.user.create({ data: { username: `tu-${name}-${short}` } }),
    ),
  );
  const workspace = await db.workspace.create({
    data: {
      slug: `task-unassign-${suffix}`,
      name: "Task unassign",
      members: {
        create: [{ userId: alice!.id, role: "owner" }, { userId: bob!.id }, { userId: carol!.id }],
      },
    },
  });
  const channel = await db.conversation.create({
    data: {
      workspaceId: workspace.id,
      channelName: `unassign-${short}`,
      members: { create: [{ userId: alice!.id }, { userId: bob!.id }, { userId: carol!.id }] },
    },
  });

  try {
    const createdA = await board.execute(
      { workspaceId: workspace.id, userId: alice!.id },
      {
        operation: "create",
        idempotencyKey: crypto.randomUUID(),
        conversationId: channel.id,
        title: "Task A",
      },
    );
    const taskANumber = createdA.tasks[0]!.number;
    const bobAssigned = await board.execute(
      { workspaceId: workspace.id, userId: bob!.id },
      {
        operation: "assign",
        idempotencyKey: crypto.randomUUID(),
        conversationId: channel.id,
        number: taskANumber,
        assignee: `@${bob!.username}`,
      },
    );
    expect(bobAssigned.tasks[0]!.owner?.memberId).toBeDefined();

    // A stale expectedRevision is a CONFLICT even for the owner.
    await expect(
      board.execute(
        { workspaceId: workspace.id, userId: bob!.id },
        {
          operation: "unassign",
          idempotencyKey: crypto.randomUUID(),
          conversationId: channel.id,
          number: taskANumber,
          expectedRevision: bobAssigned.tasks[0]!.revision + 1,
        },
      ),
    ).rejects.toThrow("CONFLICT");

    // The owner may unassign their own task.
    const unassigned = await board.execute(
      { workspaceId: workspace.id, userId: bob!.id },
      {
        operation: "unassign",
        idempotencyKey: crypto.randomUUID(),
        conversationId: channel.id,
        number: taskANumber,
        expectedRevision: bobAssigned.tasks[0]!.revision,
      },
    );
    expect(unassigned.tasks[0]!.owner).toBeNull();

    // Unassigning an already-unowned Task is a no-op, not an error.
    const noop = await board.execute(
      { workspaceId: workspace.id, userId: carol!.id },
      {
        operation: "unassign",
        idempotencyKey: crypto.randomUUID(),
        conversationId: channel.id,
        number: taskANumber,
      },
    );
    expect(noop.tasks[0]!.owner).toBeNull();
    expect(noop.tasks[0]!.revision).toBe(unassigned.tasks[0]!.revision);

    // A plain member may clear someone else's assignment and hand the Task to someone else.
    const createdB = await board.execute(
      { workspaceId: workspace.id, userId: alice!.id },
      {
        operation: "create",
        idempotencyKey: crypto.randomUUID(),
        conversationId: channel.id,
        title: "Task B",
      },
    );
    const taskBNumber = createdB.tasks[0]!.number;
    await board.execute(
      { workspaceId: workspace.id, userId: carol!.id },
      {
        operation: "assign",
        idempotencyKey: crypto.randomUUID(),
        conversationId: channel.id,
        number: taskBNumber,
        assignee: `@${carol!.username}`,
      },
    );
    const memberUnassigned = await board.execute(
      { workspaceId: workspace.id, userId: bob!.id },
      {
        operation: "unassign",
        idempotencyKey: crypto.randomUUID(),
        conversationId: channel.id,
        number: taskBNumber,
      },
    );
    expect(memberUnassigned.tasks[0]!.owner).toBeNull();
    const memberReassigned = await board.execute(
      { workspaceId: workspace.id, userId: bob!.id },
      {
        operation: "assign",
        idempotencyKey: crypto.randomUUID(),
        conversationId: channel.id,
        number: taskBNumber,
        assignee: `@${alice!.username}`,
      },
    );
    expect(memberReassigned.tasks[0]!.owner?.handle).toBe(alice!.username);
    // Creating a Task for someone else needs no Workspace role either.
    const createdForCarol = await board.execute(
      { workspaceId: workspace.id, userId: bob!.id },
      {
        operation: "create",
        idempotencyKey: crypto.randomUUID(),
        conversationId: channel.id,
        title: "Task C",
        assignee: `@${carol!.username}`,
      },
    );
    expect(createdForCarol.tasks[0]!.owner?.handle).toBe(carol!.username);
    // Deleting a Task someone else created still needs a Workspace owner or admin.
    await expect(
      board.execute(
        { workspaceId: workspace.id, userId: bob!.id },
        {
          operation: "delete",
          idempotencyKey: crypto.randomUUID(),
          conversationId: channel.id,
          number: taskBNumber,
        },
      ),
    ).rejects.toThrow("ACCESS_DENIED");
    // Someone who left the channel is no longer a member, so they cannot take a Task off anyone.
    await db.conversationMember.updateMany({
      where: { conversationId: channel.id, userId: carol!.id },
      data: { leftAt: new Date() },
    });
    await expect(
      board.execute(
        { workspaceId: workspace.id, userId: carol!.id },
        {
          operation: "unassign",
          idempotencyKey: crypto.randomUUID(),
          conversationId: channel.id,
          number: taskBNumber,
        },
      ),
    ).rejects.toThrow("ACCESS_DENIED");
  } finally {
    await db.workspace.deleteMany({ where: { id: workspace.id } });
    await db.user.deleteMany({ where: { id: { in: [alice!.id, bob!.id, carol!.id] } } });
    await db.$disconnect();
  }
});
