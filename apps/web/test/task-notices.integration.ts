import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import type { ConversationRealtimeMessage } from "#src/server/conversations/conversation-realtime.server";
import { TaskBoard } from "#src/server/tasks/task-board.server";

const connectionString = Bun.env.TASK_TEST_DATABASE_URL ?? Bun.env.DATABASE_URL;
if (!connectionString)
  throw new Error("TASK_TEST_DATABASE_URL or DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const handle = crypto.randomUUID().slice(0, 8);
const cleanup: Array<() => Promise<unknown>> = [];

afterAll(async () => {
  for (const step of cleanup.reverse()) await step();
  await db.$disconnect();
});

/**
 * One Workspace for every test here: Alice (owner, display name "Alice An"), Bob (member, no
 * display name, so he is named by his username), and an Agent. Each test takes its own channel.
 */
let alice: { id: string; username: string };
let bob: { id: string; username: string };
let agent: { id: string; name: string };
let workspaceId: string;
beforeAll(async () => {
  alice = await db.user.create({
    data: { username: `notice-alice-${handle}`, displayName: "Alice An" },
  });
  bob = await db.user.create({ data: { username: `notice-bob-${handle}` } });
  const workspace = await db.workspace.create({
    data: {
      slug: `task-notices-${handle}`,
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
  workspaceId = workspace.id;
  agent = workspace.agents[0]!;
  cleanup.push(
    () => db.user.deleteMany({ where: { id: { in: [alice.id, bob.id] } } }),
    () => db.workspace.delete({ where: { id: workspace.id } }),
  );
});

async function channelFixture(name: string) {
  const channel = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `${name}-${handle}`,
      members: {
        create: [{ userId: alice.id }, { userId: bob.id }, { agentId: agent.id }],
      },
    },
    include: { members: true },
  });
  const signaled: ConversationRealtimeMessage[] = [];
  const pushed: string[] = [];
  const board = new TaskBoard(db, {
    realtime: {
      async memberChanged() {},
      async messageAvailable(event) {
        signaled.push(event);
      },
    },
    notifications: {
      async notifyMessage(messageId) {
        pushed.push(messageId);
      },
    },
  });
  type Principal =
    | { workspaceId: string; userId: string }
    | { workspaceId: string; agentId: string };
  const run = (principal: Principal, command: Record<string, unknown>) =>
    board.execute(principal, {
      idempotencyKey: crypto.randomUUID(),
      ...("agentId" in principal
        ? { target: `#${channel.channelName}` }
        : { conversationId: channel.id }),
      ...command,
    } as Parameters<TaskBoard["execute"]>[1]);
  const latestSequence = async () =>
    (
      await db.message.findFirst({
        where: { conversationId: channel.id },
        orderBy: { sequence: "desc" },
        select: { sequence: true },
      })
    )?.sequence ?? 0;
  /** Server notices posted after `sequence`, oldest first, with where each one landed. */
  const noticesAfter = async (sequence: number) =>
    (
      await db.message.findMany({
        where: { conversationId: channel.id, senderMemberId: null, sequence: { gt: sequence } },
        orderBy: { sequence: "asc" },
        select: { body: true, threadRootId: true },
      })
    ).map(({ body, threadRootId }) => ({ body, thread: threadRootId }));
  /** Every server notice in the channel, with its delivery count. */
  const allNotices = () =>
    db.message.findMany({
      where: { conversationId: channel.id, senderMemberId: null },
      select: { id: true, _count: { select: { deliveries: true } } },
    });
  const memberId = (by: { userId?: string; agentId?: string }) =>
    channel.members.find((member) =>
      by.userId ? member.userId === by.userId : member.agentId === by.agentId,
    )!.id;
  return {
    channel,
    signaled,
    pushed,
    run,
    latestSequence,
    noticesAfter,
    allNotices,
    memberId,
    asAlice: { workspaceId, userId: alice.id },
    asBob: { workspaceId, userId: bob.id },
    asAgent: { workspaceId, agentId: agent.id },
  };
}

test("creating Tasks posts one channel notice naming each of them", async () => {
  const { run, latestSequence, noticesAfter, asAlice } = await channelFixture("created");
  let mark = await latestSequence();
  const shipTask = (await run(asAlice, { operation: "create", title: "Ship notices" })).tasks[0]!;
  expect(await noticesAfter(mark)).toEqual([
    { body: `📋 1 new task created: #${shipTask.number} "Ship notices"`, thread: null },
  ]);

  mark = await latestSequence();
  const longTitle = `Write the ${"very ".repeat(30)}long plan`;
  const [batchOne, batchTwo] = (
    await run(asAlice, { operation: "create", titles: ["Batch one\nwith details", longTitle] })
  ).tasks;
  // A notice quotes only a title's first line, cut to 80 characters.
  const cut = `${Array.from(longTitle).slice(0, 79).join("").trimEnd()}…`;
  expect(await noticesAfter(mark)).toEqual([
    {
      body: `📋 2 new tasks created: #${batchOne!.number} "Batch one", #${batchTwo!.number} "${cut}"`,
      thread: null,
    },
  ]);
});

test("a converted message's notices quote its first line with mentions read as @handles", async () => {
  const { channel, run, latestSequence, noticesAfter, memberId, asAlice, asAgent } =
    await channelFixture("converted");
  const body = `<@agent:${agent.id}> please fix the login flow\n\nSteps:\n- open the page`;
  const message = await db.message.create({
    data: {
      conversationId: channel.id,
      workspaceId,
      senderMemberId: memberId({ userId: bob.id }),
      body,
      sequence: (await latestSequence()) + 1,
      mentions: {
        create: {
          memberId: memberId({ agentId: agent.id }),
          workspaceId,
          kind: "agent",
          actorId: agent.id,
          handle: agent.name,
        },
      },
    },
  });
  const quoted = `"@${agent.name} please fix the login flow"`;

  let mark = await latestSequence();
  const converted = (await run(asAlice, { operation: "convert", messageId: message.id })).tasks[0]!;
  // Converting it again changes nothing, so it posts nothing.
  await run(asAlice, { operation: "convert", messageId: message.id });
  expect(await noticesAfter(mark)).toEqual([
    {
      body: `📋 Alice An converted a message to task #${converted.number} ${quoted}`,
      thread: null,
    },
  ]);

  // Every later notice for that Task quotes the same clean title.
  mark = await latestSequence();
  await run(asAgent, { operation: "claim", number: converted.number });
  expect(await noticesAfter(mark)).toEqual([
    { body: `📌 ${agent.name} claimed #${converted.number} ${quoted}`, thread: message.id },
  ]);
});

test("claims, moves, unassignment, release and deletion post in the Task's own thread", async () => {
  const { run, latestSequence, noticesAfter, asAlice, asBob, asAgent } =
    await channelFixture("thread");
  const [shipTask, docsTask, testsTask] = (
    await run(asAlice, { operation: "create", titles: ["Ship notices", "Write docs", "Add tests"] })
  ).tasks;
  const inThread = (task: typeof shipTask, body: string) => ({ body, thread: task!.messageId });

  // Claiming an unassigned Todo Task moves it to In Progress and says so once, as a claim.
  let mark = await latestSequence();
  await run(asAgent, { operation: "claim", number: shipTask!.number });
  expect(await noticesAfter(mark)).toEqual([
    inThread(shipTask, `📌 ${agent.name} claimed #${shipTask!.number} "Ship notices"`),
  ]);

  // Each status move names the actor by display name and the status by its label.
  mark = await latestSequence();
  await run(asAgent, { operation: "update", number: shipTask!.number, status: "in_review" });
  await run(asAgent, { operation: "update", number: shipTask!.number, status: "in_progress" });
  await run(asAlice, { operation: "update", number: shipTask!.number, status: "done" });
  await run(asAlice, { operation: "update", number: shipTask!.number, status: "todo" });
  await run(asAlice, { operation: "update", number: shipTask!.number, status: "closed" });
  // A status that does not change posts nothing.
  await run(asAlice, { operation: "update", number: shipTask!.number, status: "closed" });
  const moved = (actor: string, emoji: string, label: string) =>
    inThread(shipTask, `${emoji} ${actor} moved #${shipTask!.number} "Ship notices" to ${label}`);
  expect(await noticesAfter(mark)).toEqual([
    moved("Notice Agent", "👀", "In Review"),
    moved("Notice Agent", "🔄", "In Progress"),
    moved("Alice An", "✅", "Done"),
    moved("Alice An", "📝", "Todo"),
    moved("Alice An", "🚫", "Closed"),
  ]);

  // Clearing an assignee, by `unassign` or by assigning no one, names the actor.
  await run(asAlice, {
    operation: "assign",
    number: docsTask!.number,
    assignee: `@${bob.username}`,
  });
  mark = await latestSequence();
  await run(asAlice, { operation: "unassign", number: docsTask!.number });
  await run(asAlice, {
    operation: "assign",
    number: docsTask!.number,
    assignee: `@${bob.username}`,
  });
  await run(asAlice, { operation: "assign", number: docsTask!.number, assignee: null });
  const unassigned = inThread(docsTask, `🔓 Alice An unassigned #${docsTask!.number} "Write docs"`);
  expect(await noticesAfter(mark)).toEqual([
    unassigned,
    {
      body: `📌 Assigned @${bob.username} to task #${docsTask!.number} "Write docs"`,
      thread: null,
    },
    unassigned,
  ]);

  // Giving up one's own claim is a release; a member without a display name is named by username.
  await run(asBob, { operation: "claim", number: testsTask!.number });
  mark = await latestSequence();
  await run(asBob, { operation: "unclaim", number: testsTask!.number });
  expect(await noticesAfter(mark)).toEqual([
    inThread(testsTask, `${bob.username} released #${testsTask!.number} "Add tests"`),
  ]);

  // Deleting a Task says so in the thread of the message it was.
  mark = await latestSequence();
  await run(asAlice, { operation: "delete", number: testsTask!.number });
  expect(await noticesAfter(mark)).toEqual([
    inThread(testsTask, `Alice An deleted #${testsTask!.number} "Add tests"`),
  ]);
});

test("only the assignment receipt is delivered, pushed and fanned out to unread badges", async () => {
  const {
    channel,
    signaled,
    pushed,
    run,
    latestSequence,
    noticesAfter,
    allNotices,
    asAlice,
    asAgent,
  } = await channelFixture("receipts");

  // Created assigned to oneself, a Task starts at once. Its receipt is still the one assignment
  // notice in the channel (no claim line), so the Agent's delivery names the channel.
  let mark = await latestSequence();
  const started = await run(asAgent, {
    operation: "create",
    title: "Started by me",
    assignee: `@${agent.name}`,
  });
  const startedTask = started.tasks[0]!;
  const startedLine = `📌 Assigned @${agent.name} to task #${startedTask.number} "Started by me"`;
  expect(await noticesAfter(mark)).toEqual([
    { body: `📋 1 new task created: #${startedTask.number} "Started by me"`, thread: null },
    { body: startedLine, thread: null },
  ]);
  expect(started.assignmentReceipt).toMatchObject({ state: "started", content: startedLine });

  // Reserved for someone else, it is the same assignment notice. The assignee reads as its
  // resolved `@handle` however the caller wrote it.
  mark = await latestSequence();
  const reserved = await run(asAlice, {
    operation: "create",
    title: "Reserved",
    assignee: agent.name,
  });
  const reservedTask = reserved.tasks[0]!;
  const assignLine = `📌 Assigned @${agent.name} to task #${reservedTask.number} "Reserved"`;
  expect(await noticesAfter(mark)).toEqual([
    { body: `📋 1 new task created: #${reservedTask.number} "Reserved"`, thread: null },
    { body: assignLine, thread: null },
  ]);
  expect(reserved.assignmentReceipt).toMatchObject({ state: "assigned", content: assignLine });

  await run(asAlice, { operation: "update", number: reservedTask.number, status: "closed" });
  await run(asAlice, { operation: "unassign", number: reservedTask.number });

  const receiptIds = [started, reserved].map((result) => result.assignmentReceipt!.messageId);
  const notices = await allNotices();
  // Each receipt carries its one delivery to the Agent and its push; no other notice has either.
  const receiptsFirst = [...receiptIds].sort();
  expect(
    notices
      .filter((notice) => notice._count.deliveries > 0)
      .map((notice) => [notice.id, notice._count.deliveries])
      .sort(),
  ).toEqual(receiptsFirst.map((id) => [id, 1]));
  expect(pushed.filter((id) => notices.some((notice) => notice.id === id)).sort()).toEqual(
    receiptsFirst,
  );

  // A notice reaches the open conversation only; the Workspace-wide signal that drives unread
  // badges is for the receipt alone.
  for (const notice of notices) {
    const events = signaled.filter((event) => event.messageId === notice.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.conversationId).toBe(channel.id);
    if (receiptIds.includes(notice.id)) expect(events[0]!.workspaceId).toBe(workspaceId);
    else expect(events[0]).not.toHaveProperty("workspaceId");
  }
});
