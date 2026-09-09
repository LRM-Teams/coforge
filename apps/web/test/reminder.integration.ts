import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  decodeAgentReminderOperationResponse,
  decodeReminderFireResponse,
  decodeReminderSync,
  encodeAgentReminderOperationRequest,
  encodeReminderFireRequest,
  encodeReminderSnapshotRequest,
  encodeReminderSync,
  type AgentReminderOperationRequest,
} from "@coforge/protocol";
import { PrismaClient } from "../generated/client";
import { ReminderNotices } from "../src/server/conversations/reminder-notices.server";
import {
  createAgentReminderMethod,
  createReminderFireMethod,
  createReminderSnapshotMethod,
} from "../src/server/centrifugo/rpc-handler.server";
import { PrismaReminderRepository } from "../src/server/db/repositories/reminder.repositories.server";
import { MAX_ACTIVE_REMINDERS, Reminders } from "../src/server/reminders/reminders.server";

const connectionString = Bun.env.REMINDER_TEST_DATABASE_URL;
if (!connectionString)
  throw new Error("REMINDER_TEST_DATABASE_URL is required (isolated PostgreSQL)");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
let now = new Date("2026-09-08T12:00:00.000Z");
const published: unknown[] = [];
const reminders = new Reminders(
  new PrismaReminderRepository(db),
  { supports: async () => true },
  async (sync) => void published.push(decodeReminderSync(encodeReminderSync(sync))),
  () => now,
);
const fixture = {} as {
  userId: string;
  workspaceId: string;
  computerId: string;
  agentId: string;
  target: string;
  messageId: string;
  conversationId: string;
  otherUserId: string;
  otherWorkspaceId: string;
  sharedAgentId: string;
  otherComputerAgentId: string;
  sameOwnerAgentId: string;
};

beforeAll(async () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const user = await db.user.create({
    data: { username: `reminder_${suffix}` },
  });
  const other = await db.user.create({ data: { username: `other_${suffix}` } });
  const workspace = await db.workspace.create({
    data: {
      slug: `reminder-${suffix}`,
      name: "Reminder integration",
      members: { create: { userId: user.id } },
    },
  });
  const otherWorkspace = await db.workspace.create({
    data: {
      slug: `other-${suffix}`,
      name: "Other",
      members: { create: { userId: other.id } },
    },
  });
  const computer = await db.computer.create({
    data: {
      ownerId: user.id,
      machineId: `machine-${suffix}`,
      workspaces: { create: { workspaceId: workspace.id } },
    },
  });
  await db.workspaceMembership.create({
    data: { workspaceId: workspace.id, userId: other.id },
  });
  const otherComputer = await db.computer.create({
    data: {
      ownerId: other.id,
      machineId: `other-machine-${suffix}`,
      workspaces: { create: { workspaceId: workspace.id } },
    },
  });
  const agent = await db.agent.create({
    data: {
      workspaceId: workspace.id,
      ownerId: user.id,
      computerId: computer.id,
      name: "helper",
      displayName: "Helper",
      runtimeConfig: {},
    },
  });
  const sameOwnerAgent = await db.agent.create({
    data: {
      workspaceId: workspace.id,
      ownerId: user.id,
      computerId: computer.id,
      name: "same-owner-helper",
      displayName: "Same owner helper",
      runtimeConfig: {},
    },
  });
  const sharedAgent = await db.agent.create({
    data: {
      workspaceId: workspace.id,
      ownerId: other.id,
      computerId: computer.id,
      name: "shared-helper",
      displayName: "Shared Helper",
      runtimeConfig: {},
    },
  });
  const otherComputerAgent = await db.agent.create({
    data: {
      workspaceId: workspace.id,
      ownerId: other.id,
      computerId: otherComputer.id,
      name: "elsewhere-helper",
      displayName: "Elsewhere Helper",
      runtimeConfig: {},
    },
  });
  const conversation = await db.conversation.create({
    data: {
      workspace: { connect: { id: workspace.id } },
      directKey: `${user.id}:${agent.id}`,
      members: {
        create: [
          {
            workspace: { connect: { id: workspace.id } },
            user: { connect: { id: user.id } },
          },
          {
            workspace: { connect: { id: workspace.id } },
            agent: {
              connect: {
                id_workspaceId: { id: agent.id, workspaceId: workspace.id },
              },
            },
          },
        ],
      },
    },
    include: { members: true },
  });
  const sender = conversation.members.find((member) => member.userId === user.id)!;
  const message = await db.message.create({
    data: {
      workspaceId: workspace.id,
      conversationId: conversation.id,
      senderMemberId: sender.id,
      sequence: 1,
      body: "Remember this",
    },
  });
  Object.assign(fixture, {
    userId: user.id,
    workspaceId: workspace.id,
    computerId: computer.id,
    agentId: agent.id,
    target: `@${user.username}`,
    messageId: message.id,
    conversationId: conversation.id,
    otherUserId: other.id,
    otherWorkspaceId: otherWorkspace.id,
    sharedAgentId: sharedAgent.id,
    otherComputerAgentId: otherComputerAgent.id,
    sameOwnerAgentId: sameOwnerAgent.id,
  });
});

test("Agent operation credential cannot act as another same-owner Agent", async () => {
  const result = await createAgentReminderMethod(reminders)(
    encodeAgentReminderOperationRequest({
      ...schedule("spoofed-agent-operation"),
      agentId: fixture.sameOwnerAgentId,
      operation: "list",
      title: undefined,
      target: undefined,
      messageId: undefined,
      fireAt: undefined,
    }),
    {
      principal: {
        userId: fixture.userId,
        workspaceId: fixture.workspaceId,
        computerId: fixture.computerId,
        agentId: fixture.agentId,
      },
    },
  );
  expect(result).toBeInstanceOf(Uint8Array);
  if (!(result instanceof Uint8Array)) throw new Error("expected encoded reminder response");
  expect(decodeAgentReminderOperationResponse(result)).toMatchObject({
    accepted: false,
    reason: "reminder operation principal scope is not authorized",
  });
});

afterAll(async () => {
  const workspaceIds = [fixture.workspaceId, fixture.otherWorkspaceId].filter(Boolean);
  const userIds = [fixture.userId, fixture.otherUserId].filter(Boolean);
  if (workspaceIds.length) await db.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
  if (userIds.length) await db.computer.deleteMany({ where: { ownerId: { in: userIds } } });
  if (userIds.length) await db.user.deleteMany({ where: { id: { in: userIds } } });
  await db.$disconnect();
});

const schedule = (
  requestId: string,
  extra: Partial<AgentReminderOperationRequest> = {},
): AgentReminderOperationRequest => ({
  protocolMajor: 1,
  requestId,
  workspaceId: fixture.workspaceId,
  computerId: fixture.computerId,
  agentId: fixture.agentId,
  operation: "schedule",
  title: "Follow up",
  target: fixture.target,
  messageId: fixture.messageId,
  fireAt: "2026-09-08T13:00:00.000Z",
  ...extra,
});
const fire = async (reminderId: string, version: number, requestId: string) =>
  decodeReminderFireResponse(
    await reminders.fire(
      {
        protocolMajor: 1,
        requestId,
        workspaceId: fixture.workspaceId,
        computerId: fixture.computerId,
        agentId: fixture.agentId,
        reminderId,
        version,
        firedAtClient: now.toISOString(),
      },
      fixture.userId,
    ),
  );

test("PostgreSQL preserves full multiline Unicode reminder titles through create, update, list, and fire", async () => {
  const originalTitle =
    "请在明天的产品例会上核对智能代理提醒功能：确认数据库、同步协议、个人资料页和到期通知都保留完整标题。\t负责人需要逐项记录验证结果，不能只检查截断预览。\r\n第二行请复核中文标点、制表符和换行符，并确认来源会话、准确时间、相对时间与每天重复计划全部一致。";
  const updatedTitle =
    "更新后的任务：请完成提醒标题全链路回归，检查创建、更新、列表和触发后的历史快照。\t任何界面预览都不能覆盖云端保存的原文。\r\n第二行继续保留中文内容和全部空白字符，并把验证证据附到对应来源会话中，确保这段标题明显超过一百二十个字符；最后再次核对每日计划推进后的标题仍然字节完整。";
  expect(originalTitle.length).toBeGreaterThan(120);
  expect(updatedTitle.length).toBeGreaterThan(120);

  const previousNow = now;
  const created = (
    await reminders.execute(
      schedule(`full-title-create-${crypto.randomUUID()}`, {
        title: originalTitle,
        fireAt: "2026-09-10T12:00:00.000Z",
        repeat: "every:1d",
        timezone: "Asia/Shanghai",
      }),
      fixture.userId,
    )
  ).reminders[0]!;
  try {
    expect(created.title).toBe(originalTitle);
    expect(
      await db.reminder.findUniqueOrThrow({
        where: { id: created.reminderId },
        select: { title: true },
      }),
    ).toEqual({ title: originalTitle });
    expect(
      (
        await reminders.execute(
          {
            ...schedule(`full-title-list-before-${crypto.randomUUID()}`),
            operation: "list",
            title: undefined,
            target: undefined,
            messageId: undefined,
            fireAt: undefined,
          },
          fixture.userId,
        )
      ).reminders.find((reminder) => reminder.reminderId === created.reminderId)?.title,
    ).toBe(originalTitle);

    const updated = (
      await reminders.execute(
        {
          ...schedule(`full-title-update-${crypto.randomUUID()}`),
          operation: "update",
          reminderId: created.reminderId,
          title: updatedTitle,
          target: undefined,
          messageId: undefined,
          fireAt: undefined,
        },
        fixture.userId,
      )
    ).reminders[0]!;
    expect(updated.title).toBe(updatedTitle);
    expect(
      (
        await reminders.execute(
          {
            ...schedule(`full-title-list-after-${crypto.randomUUID()}`),
            operation: "list",
            title: undefined,
            target: undefined,
            messageId: undefined,
            fireAt: undefined,
          },
          fixture.userId,
        )
      ).reminders.find((reminder) => reminder.reminderId === created.reminderId)?.title,
    ).toBe(updatedTitle);
    expect(
      await db.reminderEvent.findFirstOrThrow({
        where: { reminderId: created.reminderId, type: "created" },
        select: { title: true },
      }),
    ).toEqual({ title: originalTitle });

    now = new Date("2026-09-10T12:00:00.000Z");
    expect(
      (await fire(created.reminderId, updated.version, `full-title-fire-${crypto.randomUUID()}`))
        .result,
    ).toBe("accepted");
    expect(
      await db.reminderEvent.findFirstOrThrow({
        where: { reminderId: created.reminderId, type: "fired" },
        select: { title: true },
      }),
    ).toEqual({ title: updatedTitle });
  } finally {
    now = previousNow;
    await db.reminder.delete({ where: { id: created.reminderId } });
  }
});

test("Daemon reminder RPC derives the assigned Agent owner and rejects another Computer's Agent", async () => {
  const row = await db.reminder.create({
    data: {
      workspaceId: fixture.workspaceId,
      ownerAgentId: fixture.sharedAgentId,
      computerId: fixture.computerId,
      title: "Shared Computer reminder",
      target: fixture.target,
      messageId: fixture.messageId,
      fireAt: now,
      status: "scheduled",
      version: 1,
    },
  });
  const metadata = {
    principal: {
      userId: fixture.userId,
      workspaceId: fixture.workspaceId,
      computerId: fixture.computerId,
    },
  };
  const snapshot = await createReminderSnapshotMethod(reminders)(
    encodeReminderSnapshotRequest({
      protocolMajor: 1,
      requestId: "shared-snapshot",
      workspaceId: fixture.workspaceId,
      computerId: fixture.computerId,
      agentId: fixture.sharedAgentId,
    }),
    metadata,
  );
  expect(snapshot).toBeInstanceOf(Uint8Array);
  if (!(snapshot instanceof Uint8Array)) throw new Error("expected encoded reminder snapshot");
  expect(decodeReminderSync(snapshot).jobs).toEqual([
    expect.objectContaining({
      reminderId: row.id,
      ownerAgentId: fixture.sharedAgentId,
    }),
  ]);

  const fired = await createReminderFireMethod(reminders)(
    encodeReminderFireRequest({
      protocolMajor: 1,
      requestId: "shared-fire",
      workspaceId: fixture.workspaceId,
      computerId: fixture.computerId,
      agentId: fixture.sharedAgentId,
      reminderId: row.id,
      version: 1,
      firedAtClient: now.toISOString(),
    }),
    metadata,
  );
  expect(fired).toBeInstanceOf(Uint8Array);
  if (!(fired instanceof Uint8Array)) throw new Error("expected encoded reminder fire response");
  expect(decodeReminderFireResponse(fired).result).toBe("accepted");

  expect(
    await createReminderSnapshotMethod(reminders)(
      encodeReminderSnapshotRequest({
        protocolMajor: 1,
        requestId: "wrong-assignment",
        workspaceId: fixture.workspaceId,
        computerId: fixture.computerId,
        agentId: fixture.otherComputerAgentId,
      }),
      metadata,
    ),
  ).toEqual({ code: 403, message: "reminder snapshot is not authorized" });
});

test("PostgreSQL reminder lifecycle is scoped, idempotent, concurrent, and chronological", async () => {
  const request = schedule("create-replay");
  const created = (await reminders.execute(request, fixture.userId)).reminders[0]!;
  now = new Date("2026-09-08T14:00:00.000Z");
  expect((await reminders.execute(request, fixture.userId)).reminders[0]).toEqual(created);
  expect(await db.reminder.count({ where: { ownerAgentId: fixture.agentId } })).toBe(1);

  const prematureRequest = schedule("premature-create", {
    fireAt: "2026-09-08T15:00:00.000Z",
  });
  const premature = (await reminders.execute(prematureRequest, fixture.userId)).reminders[0]!;
  expect((await fire(premature.reminderId, 1, "same-fire-id")).result).toBe("premature");
  now = new Date("2026-09-08T15:00:00.000Z");
  expect((await fire(premature.reminderId, 1, "same-fire-id")).result).toBe("accepted");
  expect((await fire(premature.reminderId, 1, "repeat-fire")).result).toBe("obsolete");

  const concurrent = (
    await reminders.execute(
      schedule("concurrent-create", { fireAt: "2026-09-08T15:01:00.000Z" }),
      fixture.userId,
    )
  ).reminders[0]!;
  now = new Date("2026-09-08T15:02:00.000Z");
  const same = await Promise.all([
    fire(concurrent.reminderId, 1, "concurrent-same"),
    fire(concurrent.reminderId, 1, "concurrent-same"),
  ]);
  expect(same.map((value) => value.result)).toEqual(["accepted", "accepted"]);
  expect(
    await db.reminderEvent.count({
      where: { reminderId: concurrent.reminderId, type: "fired" },
    }),
  ).toBe(1);

  const recurring = (
    await reminders.execute(
      schedule("repeat-create", {
        fireAt: "2026-09-08T16:00:00.000Z",
        repeat: "every:1h",
        timezone: "UTC",
      }),
      fixture.userId,
    )
  ).reminders[0]!;
  now = new Date("2026-09-08T18:20:00.000Z");
  const different = await Promise.all([
    fire(recurring.reminderId, 1, "fire-a"),
    fire(recurring.reminderId, 1, "fire-b"),
  ]);
  expect(different.map((value) => value.result).sort()).toEqual(["accepted", "obsolete"]);
  const advanced = await db.reminder.findUniqueOrThrow({
    where: { id: recurring.reminderId },
  });
  expect(advanced.fireAt.toISOString()).toBe("2026-09-08T19:00:00.000Z");
  expect(published.at(-1)).toMatchObject({
    operation: "upsert",
    jobs: [{ version: 2, title: "Follow up", fireAt: "2026-09-08T19:00:00.000Z" }],
  });

  const timezoneRecurring = (
    await reminders.execute(
      schedule("timezone-recurring-create", {
        fireAt: "2026-09-08T19:00:00.000Z",
        repeat: "daily@09:00",
        timezone: "UTC",
      }),
      fixture.userId,
    )
  ).reminders[0]!;
  const timezoneUpdated = (
    await reminders.execute(
      {
        ...schedule("timezone-recurring-update"),
        operation: "update",
        reminderId: timezoneRecurring.reminderId,
        title: undefined,
        target: undefined,
        messageId: undefined,
        fireAt: undefined,
        timezone: "Asia/Shanghai",
      },
      fixture.userId,
    )
  ).reminders[0]!;
  expect(timezoneUpdated.fireAt).toBe("2026-09-09T01:00:00.000Z");
  expect(timezoneUpdated.timezone).toBe("Asia/Shanghai");

  const oneTime = (
    await reminders.execute(
      schedule("timezone-one-time-create", {
        fireAt: "2026-09-08T20:00:00.000Z",
      }),
      fixture.userId,
    )
  ).reminders[0]!;
  await expect(
    reminders.execute(
      {
        ...schedule("timezone-one-time-update"),
        operation: "update",
        reminderId: oneTime.reminderId,
        title: undefined,
        target: undefined,
        messageId: undefined,
        fireAt: undefined,
        timezone: "UTC",
      },
      fixture.userId,
    ),
  ).rejects.toThrow("timezone requires a recurring reminder");
  await expect(
    reminders.execute(
      {
        ...schedule("timezone-none-update"),
        operation: "update",
        reminderId: timezoneRecurring.reminderId,
        title: undefined,
        target: undefined,
        messageId: undefined,
        fireAt: undefined,
        repeat: "none",
        timezone: "UTC",
      },
      fixture.userId,
    ),
  ).rejects.toThrow("repeat none cannot include timezone");

  const updated = (
    await reminders.execute(
      {
        ...schedule("update-title"),
        operation: "update",
        reminderId: recurring.reminderId,
        title: "Changed",
        target: undefined,
        messageId: undefined,
        fireAt: undefined,
      },
      fixture.userId,
    )
  ).reminders[0]!;
  expect(updated.title).toBe("Changed");
  expect(
    await db.reminderEvent.findFirstOrThrow({
      where: { reminderId: recurring.reminderId, type: "updated" },
      select: { title: true, scheduledFor: true, nextFireAt: true },
    }),
  ).toEqual({
    title: "Changed",
    scheduledFor: new Date("2026-09-08T19:00:00.000Z"),
    nextFireAt: null,
  });
  const historicalNotices = (
    await new ReminderNotices(db).list(
      fixture.workspaceId,
      fixture.userId,
      fixture.conversationId,
      undefined,
      50,
    )
  ).notices.filter(
    (notice) =>
      notice.title === "Follow up" && notice.fireAt.toISOString() === "2026-09-08T16:00:00.000Z",
  );
  expect(historicalNotices).toEqual([
    expect.objectContaining({
      type: "fired",
      title: "Follow up",
      fireAt: new Date("2026-09-08T16:00:00.000Z"),
      nextFireAt: new Date("2026-09-08T19:00:00.000Z"),
    }),
    expect.objectContaining({
      type: "created",
      title: "Follow up",
      fireAt: new Date("2026-09-08T16:00:00.000Z"),
      nextFireAt: null,
    }),
  ]);
  const noRepeat = (
    await reminders.execute(
      {
        ...schedule("update-none"),
        operation: "update",
        reminderId: recurring.reminderId,
        repeat: "none",
        target: undefined,
        messageId: undefined,
        fireAt: undefined,
      },
      fixture.userId,
    )
  ).reminders[0]!;
  expect(noRepeat.repeat).toBeUndefined();
  const snoozeRequest: AgentReminderOperationRequest = {
    protocolMajor: 1,
    requestId: "snooze-replay",
    workspaceId: fixture.workspaceId,
    computerId: fixture.computerId,
    agentId: fixture.agentId,
    operation: "snooze",
    reminderId: premature.reminderId,
    delaySeconds: 60,
  };
  const snoozed = (await reminders.execute(snoozeRequest, fixture.userId)).reminders[0]!;
  now = new Date("2026-09-09T00:00:00.000Z");
  expect((await reminders.execute(snoozeRequest, fixture.userId)).reminders[0]).toEqual(snoozed);

  await expect(
    reminders.execute(
      schedule("wrong-workspace", { workspaceId: fixture.otherWorkspaceId }),
      fixture.userId,
    ),
  ).rejects.toThrow("not authorized");
  await expect(reminders.execute(schedule("wrong-user"), fixture.otherUserId)).rejects.toThrow(
    "not authorized",
  );
  await expect(fire(crypto.randomUUID(), 1, "missing-fire")).resolves.toMatchObject({
    result: "obsolete",
  });
  await expect(
    reminders.execute(schedule("wrong-prefix", { messageId: "deadbeef" }), fixture.userId),
  ).rejects.toThrow("missing or ambiguous");

  const currentlyActive = await db.reminder.count({
    where: { ownerAgentId: fixture.agentId, status: "scheduled" },
  });
  const attempts = Array.from({ length: MAX_ACTIVE_REMINDERS - currentlyActive + 2 }, (_, index) =>
    reminders.execute(
      schedule(`cap-${index}`, {
        fireAt: new Date(now.getTime() + 3_600_000 + index * 1000).toISOString(),
      }),
      fixture.userId,
    ),
  );
  const settled = await Promise.allSettled(attempts);
  expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(
    MAX_ACTIVE_REMINDERS - currentlyActive,
  );
  expect(
    await db.reminder.count({
      where: { ownerAgentId: fixture.agentId, status: "scheduled" },
    }),
  ).toBe(MAX_ACTIVE_REMINDERS);
  await expect(
    reminders.execute(
      {
        ...snoozeRequest,
        requestId: "snooze-at-cap",
        reminderId: concurrent.reminderId,
      },
      fixture.userId,
    ),
  ).rejects.toThrow("active reminder limit");
  await expect(
    reminders.execute(
      {
        protocolMajor: 1,
        requestId: "missing-update",
        workspaceId: fixture.workspaceId,
        computerId: fixture.computerId,
        agentId: fixture.agentId,
        operation: "update",
        reminderId: crypto.randomUUID(),
        title: "Missing",
      },
      fixture.userId,
    ),
  ).rejects.toThrow("reminder not found");
});
