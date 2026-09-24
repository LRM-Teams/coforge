import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import type { TaskCommand, TaskPrincipal, TaskStatus } from "@lrm/coforge-sdk/internal";
import { PrismaClient } from "#src/generated/prisma/client";
import { refuseUnclaimed, TaskBoard } from "#src/server/tasks/task-board.server";

const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

test("A claim answers every selector, naming why a refused one failed and who holds a held Task", async () => {
  const connectionString = Bun.env.TASK_TEST_DATABASE_URL ?? Bun.env.DATABASE_URL;
  if (!connectionString)
    throw new Error("TASK_TEST_DATABASE_URL or DATABASE_URL must point to local PostgreSQL");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const handle = crypto.randomUUID().slice(0, 8);
  const alice = await db.user.create({ data: { username: `claim-alice-${handle}` } });
  const bob = await db.user.create({ data: { username: `claim-bob-${handle}` } });
  const workspace = await db.workspace.create({
    data: {
      slug: `task-claim-${handle}`,
      name: "Task claim",
      members: { create: [{ userId: alice.id, role: "owner" }, { userId: bob.id }] },
      agents: {
        create: [
          {
            name: `claimer-${handle}`,
            displayName: "Claimer",
            ownerId: alice.id,
            runtimeConfig: {},
          },
          { name: `holder-${handle}`, displayName: "Holder", ownerId: alice.id, runtimeConfig: {} },
        ],
      },
    },
    include: { agents: true },
  });
  const claimer = workspace.agents.find((agent) => agent.name.startsWith("claimer"))!;
  const holder = workspace.agents.find((agent) => agent.name.startsWith("holder"))!;
  const channel = await db.conversation.create({
    data: {
      workspaceId: workspace.id,
      channelName: `claims-${handle}`,
      members: {
        create: [
          { userId: alice.id },
          { userId: bob.id },
          { agentId: claimer.id },
          { agentId: holder.id },
        ],
      },
    },
  });
  const board = new TaskBoard(db);
  const target = `#${channel.channelName}`;
  const asAlice: TaskPrincipal = { workspaceId: workspace.id, userId: alice.id };
  const asClaimer: TaskPrincipal = { workspaceId: workspace.id, agentId: claimer.id };
  const asHolder: TaskPrincipal = { workspaceId: workspace.id, agentId: holder.id };
  const run = (principal: TaskPrincipal, command: Omit<TaskCommand, "idempotencyKey">) =>
    board.execute(principal, { idempotencyKey: crypto.randomUUID(), ...command });
  const byAgent = (command: Omit<TaskCommand, "idempotencyKey" | "target">) =>
    run(asClaimer, { target, ...command });

  try {
    const created = await run(asAlice, {
      operation: "create",
      conversationId: channel.id,
      titles: ["Open", "Held by an Agent", "Closed", "Done", "Reserved for Bob"],
    });
    const [open, held, closed, done, reserved] = created.tasks.map((task) => task.number) as [
      number,
      number,
      number,
      number,
      number,
    ];
    await run(asHolder, { operation: "claim", target, number: held });
    await run(asAlice, {
      operation: "update",
      conversationId: channel.id,
      number: closed,
      status: "closed",
    });
    await byAgent({ operation: "claim", number: done });
    await byAgent({ operation: "update", number: done, status: "done" });
    await run(asAlice, {
      operation: "assign",
      conversationId: channel.id,
      number: reserved,
      assignee: `@${bob.username}`,
    });

    const before = Date.now();
    const result = await byAgent({
      operation: "claim",
      numbers: [open, held, closed, done, reserved, 999],
      messageId: "deadbeef",
    });
    const conflict = (
      type: "user" | "agent",
      name: string,
      taskStatus: TaskStatus,
      claimed: boolean,
    ) => ({
      kind: "claim_conflict" as const,
      conflictScope: "implementation_execution" as const,
      blockedActions: ["start_conflicting_execution" as const],
      unblockedActionExamples: expect.arrayContaining([expect.any(String)]),
      currentAssignee: { type, name },
      taskStatus,
      claimedAt: claimed ? expect.stringMatching(ISO) : null,
      observedAt: expect.stringMatching(ISO),
    });
    expect(result.claims).toEqual([
      { number: open, messageId: created.tasks[0]!.messageId, success: true },
      {
        number: held,
        success: false,
        reason: "already claimed",
        conflict: conflict("agent", holder.name, "in_progress", true),
      },
      { number: closed, success: false, reason: "task is closed" },
      { number: done, success: false, reason: "task is done" },
      {
        number: reserved,
        success: false,
        reason: "already claimed",
        conflict: conflict("user", bob.username, "todo", false),
      },
      { number: 999, success: false, reason: "task not found" },
      { messageId: "deadbeef", success: false, reason: "message not found" },
    ]);
    expect(Date.parse(result.claims![1]!.conflict!.observedAt)).toBeGreaterThanOrEqual(
      before - 1000,
    );
    expect(result.tasks.map((task) => task.number)).toEqual([open]);

    // A refused Task named by its message still answers with its number.
    const doneMessage = created.tasks[3]!.messageId.slice(0, 8);
    const byMessage = await byAgent({ operation: "claim", messageId: doneMessage });
    expect(byMessage.claims).toEqual([
      { messageId: doneMessage, number: done, success: false, reason: "task is done" },
    ]);

    // One refused selector is still an answer, not an error; the browser's seam turns it into one.
    await db.agent.update({ where: { id: holder.id }, data: { deletedAt: new Date() } });
    const single = await byAgent({ operation: "claim", number: held });
    expect(single).toEqual({
      tasks: [],
      claims: [
        {
          number: held,
          success: false,
          reason: "already claimed",
          conflict: expect.objectContaining({
            currentAssignee: { type: "agent", name: holder.name, deleted: true },
          }),
        },
      ],
    });
    expect(() => refuseUnclaimed(single)).toThrow("CONFLICT");
    expect(() =>
      refuseUnclaimed({
        tasks: [],
        claims: [{ number: 999, success: false, reason: "task not found" }],
      }),
    ).toThrow("NOT_FOUND");
    expect(() => refuseUnclaimed(result)).not.toThrow();
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.deleteMany({ where: { id: { in: [alice.id, bob.id] } } });
    await db.$disconnect();
  }
});
