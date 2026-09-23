import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import type { ConversationRealtimeMessage } from "#src/server/conversations/conversation-realtime.server";
import { TaskBoard } from "#src/server/tasks/task-board.server";

test("Task changes post server notices in the channel and in the Task's own thread", async () => {
  const connectionString = Bun.env.TASK_TEST_DATABASE_URL ?? Bun.env.DATABASE_URL;
  if (!connectionString)
    throw new Error("TASK_TEST_DATABASE_URL or DATABASE_URL must point to local PostgreSQL");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID();
  const handle = suffix.slice(0, 8);
  const alice = await db.user.create({
    data: { username: `notice-alice-${handle}`, displayName: "Alice An" },
  });
  // No display name: a person without one is named by their username.
  const bob = await db.user.create({ data: { username: `notice-bob-${handle}` } });
  const workspace = await db.workspace.create({
    data: {
      slug: `task-notices-${suffix}`,
      name: "Task notices",
      members: {
        create: [
          { userId: alice.id, role: "owner" },
          { userId: bob.id, role: "member" },
        ],
      },
      agents: {
        create: {
          name: `notice-agent-${handle}`,
          displayName: "Notice Agent",
          ownerId: alice.id,
          runtimeConfig: {},
        },
      },
    },
    include: { agents: true },
  });
  const agent = workspace.agents[0]!;
  const channel = await db.conversation.create({
    data: {
      workspaceId: workspace.id,
      channelName: `notices-${handle}`,
      members: {
        create: [{ userId: alice.id }, { userId: bob.id }, { agentId: agent.id }],
      },
    },
  });
  const signaled: ConversationRealtimeMessage[] = [];
  const board = new TaskBoard(db, {
    realtime: {
      async memberChanged() {},
      async messageAvailable(event) {
        signaled.push(event);
      },
    },
  });
  const asAlice = { workspaceId: workspace.id, userId: alice.id };
  const asBob = { workspaceId: workspace.id, userId: bob.id };
  const asAgent = { workspaceId: workspace.id, agentId: agent.id };
  const run = (principal: typeof asAlice | typeof asAgent, command: Record<string, unknown>) =>
    board.execute(principal, {
      idempotencyKey: crypto.randomUUID(),
      ...("agentId" in principal
        ? { target: `#${channel.channelName}` }
        : { conversationId: channel.id }),
      ...command,
    } as Parameters<TaskBoard["execute"]>[1]);
  /** Server notices posted after `sequence`, oldest first, with where each one landed. */
  const noticesAfter = async (sequence: number) =>
    (
      await db.message.findMany({
        where: { conversationId: channel.id, senderMemberId: null, sequence: { gt: sequence } },
        orderBy: { sequence: "asc" },
        select: { body: true, threadRootId: true },
      })
    ).map(({ body, threadRootId }) => ({ body, thread: threadRootId }));
  const latestSequence = async () =>
    (
      await db.message.findFirst({
        where: { conversationId: channel.id },
        orderBy: { sequence: "desc" },
        select: { sequence: true },
      })
    )?.sequence ?? 0;

  try {
    // Creation posts one channel notice naming every new Task.
    let mark = await latestSequence();
    const one = (await run(asAlice, { operation: "create", title: "Ship notices" })).tasks[0]!;
    expect(await noticesAfter(mark)).toEqual([
      { body: `📋 1 new task created: #${one.number} "Ship notices"`, thread: null },
    ]);
    mark = await latestSequence();
    const [first, second] = (
      await run(asAlice, { operation: "create", titles: ["Batch one", "Batch two"] })
    ).tasks;
    expect(await noticesAfter(mark)).toEqual([
      {
        body: `📋 2 new tasks created: #${first!.number} "Batch one", #${second!.number} "Batch two"`,
        thread: null,
      },
    ]);

    // Claiming an unassigned Todo Task moves it to In Progress and says so once, as a claim.
    mark = await latestSequence();
    signaled.length = 0;
    await run(asAgent, { operation: "claim", number: one.number });
    const claimed = await noticesAfter(mark);
    expect(claimed).toEqual([
      { body: `📌 ${agent.name} claimed #${one.number} "Ship notices"`, thread: one.messageId },
    ]);
    // The thread notice reaches open pages as a thread reply, like any other one.
    expect(signaled).toContainEqual(
      expect.objectContaining({ conversationId: channel.id, threadRootId: one.messageId }),
    );

    // Each status move names the actor by display name and the status by its label.
    mark = await latestSequence();
    await run(asAgent, { operation: "update", number: one.number, status: "in_review" });
    await run(asAgent, { operation: "update", number: one.number, status: "in_progress" });
    await run(asAlice, { operation: "update", number: one.number, status: "done" });
    await run(asAlice, { operation: "update", number: one.number, status: "todo" });
    await run(asAlice, { operation: "update", number: one.number, status: "closed" });
    // A status that does not change posts nothing.
    await run(asAlice, { operation: "update", number: one.number, status: "closed" });
    const moved = (actor: string, emoji: string, label: string) => ({
      body: `${emoji} ${actor} moved #${one.number} "Ship notices" to ${label}`,
      thread: one.messageId,
    });
    expect(await noticesAfter(mark)).toEqual([
      moved("Notice Agent", "👀", "In Review"),
      moved("Notice Agent", "🔄", "In Progress"),
      moved("Alice An", "✅", "Done"),
      moved("Alice An", "📝", "Todo"),
      moved("Alice An", "🚫", "Closed"),
    ]);

    // Assigning another member is a channel notice naming the assignee by @handle.
    mark = await latestSequence();
    await run(asAlice, {
      operation: "assign",
      number: first!.number,
      assignee: `@${bob.username}`,
    });
    expect(await noticesAfter(mark)).toEqual([
      { body: `📌 Assigned @${bob.username} to task #${first!.number} "Batch one"`, thread: null },
    ]);

    // Clearing the assignee is a thread notice naming the actor by display name.
    mark = await latestSequence();
    await run(asAlice, { operation: "unassign", number: first!.number });
    expect(await noticesAfter(mark)).toEqual([
      { body: `🔓 Alice An unassigned #${first!.number} "Batch one"`, thread: first!.messageId },
    ]);

    // Giving up one's own claim is a release; a name falls back to the username.
    await run(asBob, { operation: "claim", number: second!.number });
    mark = await latestSequence();
    await run(asBob, { operation: "unclaim", number: second!.number });
    expect(await noticesAfter(mark)).toEqual([
      {
        body: `${bob.username} released #${second!.number} "Batch two"`,
        thread: second!.messageId,
      },
    ]);

    // Deleting a Task says so in the thread of the message it was.
    mark = await latestSequence();
    await run(asAlice, { operation: "delete", number: second!.number });
    expect(await noticesAfter(mark)).toEqual([
      { body: `Alice An deleted #${second!.number} "Batch two"`, thread: second!.messageId },
    ]);

    // Converting an ordinary message is a channel notice; converting it again posts nothing.
    const plain = await db.message.create({
      data: {
        conversationId: channel.id,
        workspaceId: workspace.id,
        senderMemberId: (
          await db.conversationMember.findFirstOrThrow({
            where: { conversationId: channel.id, userId: bob.id },
          })
        ).id,
        body: "Fix the login bug",
        sequence: (await latestSequence()) + 1,
      },
    });
    mark = await latestSequence();
    const converted = (await run(asAlice, { operation: "convert", messageId: plain.id })).tasks[0]!;
    await run(asAlice, { operation: "convert", messageId: plain.id });
    expect(await noticesAfter(mark)).toEqual([
      {
        body: `📋 Alice An converted a message to task #${converted.number} "Fix the login bug"`,
        thread: null,
      },
    ]);

    // Creating a Task assigned to oneself starts it: that is a claim, in the Task's thread, and
    // it stays the assignment receipt an Agent assignee is delivered.
    mark = await latestSequence();
    const started = await run(asAgent, {
      operation: "create",
      title: "Started by me",
      assignee: `@${agent.name}`,
    });
    const startedTask = started.tasks[0]!;
    const claimLine = `📌 ${agent.name} claimed #${startedTask.number} "Started by me"`;
    expect(await noticesAfter(mark)).toEqual([
      { body: `📋 1 new task created: #${startedTask.number} "Started by me"`, thread: null },
      { body: claimLine, thread: startedTask.messageId },
    ]);
    expect(started.assignmentReceipt).toMatchObject({ state: "started", content: claimLine });
    const receipt = await db.message.findUniqueOrThrow({
      where: { id: started.assignmentReceipt!.messageId },
      include: { deliveries: true },
    });
    expect(receipt.deliveries.map((delivery) => delivery.agentId)).toEqual([agent.id]);

    // Creating a Task for someone else reserves it: an assignment in the channel.
    mark = await latestSequence();
    const reserved = await run(asAlice, {
      operation: "create",
      title: "Reserved",
      assignee: `@${agent.name}`,
    });
    const reservedTask = reserved.tasks[0]!;
    const assignLine = `📌 Assigned @${agent.name} to task #${reservedTask.number} "Reserved"`;
    expect(await noticesAfter(mark)).toEqual([
      { body: `📋 1 new task created: #${reservedTask.number} "Reserved"`, thread: null },
      { body: assignLine, thread: null },
    ]);
    expect(reserved.assignmentReceipt).toMatchObject({ state: "assigned", content: assignLine });
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.deleteMany({ where: { id: { in: [alice.id, bob.id] } } });
    await db.$disconnect();
  }
});
