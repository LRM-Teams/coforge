import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { decodeAgentMessageDelivery } from "@coforge/protocol";
import { PrismaClient } from "../generated/client";
import { TaskBoard } from "../src/server/tasks/task-board.server";

test("TaskBoard atomically creates, converts, claims and revision-checks message Tasks", async () => {
  const connectionString = Bun.env.TASK_TEST_DATABASE_URL ?? Bun.env.DATABASE_URL;
  if (!connectionString)
    throw new Error("TASK_TEST_DATABASE_URL or DATABASE_URL must point to local PostgreSQL");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID();
  const handle = suffix.slice(0, 8);
  const alice = await db.user.create({ data: { username: `task-alice-${suffix}` } });
  const bob = await db.user.create({ data: { username: `task-bob-${suffix}` } });
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
  await db.agent.update({ where: { id: agent.id }, data: { computerId: computer.id } });
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
      async messageAvailable(event) {
        realtime.push(event);
      },
    },
  });
  const command = {
    operation: "create" as const,
    requestId: crypto.randomUUID(),
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
        requestId: crypto.randomUUID(),
        conversationId: direct.id,
        title: "DM attachment task",
        attachmentId: attachment.id,
      },
    );
    expect(delivered[0]).toMatchObject({ target: `@${alice.username}` });
    expect(
      await db.message.findUnique({
        where: { id: directTask.tasks[0]!.messageId },
        select: { attachment: { select: { id: true } }, deliveries: { select: { agentId: true } } },
      }),
    ).toEqual({ attachment: { id: attachment.id }, deliveries: [{ agentId: agent.id }] });

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
      await db.message.count({ where: { conversationId: channel.id, body: command.title } }),
    ).toBe(1);
    const competingClaims = await Promise.allSettled(
      [alice.id, bob.id].map((userId) =>
        board.execute(
          { workspaceId: workspace.id, userId },
          {
            operation: "claim",
            requestId: crypto.randomUUID(),
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
        requestId: crypto.randomUUID(),
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
            requestId: crypto.randomUUID(),
            target: `#${channel.channelName}`,
            number: 2,
          },
        )
      ).tasks[0],
    ).toMatchObject({ status: "in_progress", revision: 1, owner: { kind: "agent" } });

    await expect(
      board.execute(
        { workspaceId: workspace.id, userId: bob.id },
        {
          operation: "claim",
          requestId: crypto.randomUUID(),
          conversationId: channel.id,
          number: 2,
        },
      ),
    ).rejects.toThrow("CONFLICT");
    const review = await board.execute(
      { workspaceId: workspace.id, agentId: agent.id },
      {
        operation: "update",
        requestId: crypto.randomUUID(),
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
          requestId: crypto.randomUUID(),
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
            requestId: crypto.randomUUID(),
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
        requestId: crypto.randomUUID(),
        conversationId: channel.id,
        title: "Close without claiming",
      },
    );
    const closed = await board.execute(
      { workspaceId: workspace.id, userId: alice.id },
      {
        operation: "update",
        requestId: crypto.randomUUID(),
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
            requestId: crypto.randomUUID(),
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
      requestId: crypto.randomUUID(),
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
    expect(await db.task.count({ where: { requestId: postCommitCommand.requestId } })).toBe(1);
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.computer.delete({ where: { id: computer.id } });
    await db.user.deleteMany({ where: { id: { in: [alice.id, bob.id] } } });
    await db.$disconnect();
  }
});
