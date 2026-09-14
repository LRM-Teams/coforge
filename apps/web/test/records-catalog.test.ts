import { expect, test } from "bun:test";
import type { PrismaClient } from "../generated/client";
import { RecordCatalog } from "../src/server/records/record-catalog.server";

test("new member reports copy the latest template outline and body rows", async () => {
  let createdData: Record<string, unknown> | undefined;
  let templateQuery: object | undefined;
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "member" }),
    },
    weeklyReportCycle: {
      findUnique: async () => ({
        id: "cycle-1",
        year: 2026,
        week: 37,
        title: "2026 W37 工作周报",
      }),
    },
    weeklyReport: {
      findFirst: async (query: object) => {
        templateQuery = query;
        return {
          content: {
            tabs: {
              Summary: {
                markdown: "# Current Work\n\n## Next Steps\nWrite updates here",
              },
            },
          },
        };
      },
      create: async (query: { data: Record<string, unknown> }) => {
        createdData = query.data;
        return { id: "report-1", title: query.data.title };
      },
    },
  } as unknown as PrismaClient;

  await new RecordCatalog(db).createMemberReport({
    workspaceId: "workspace-1",
    userId: "user-1",
    title: "My weekly report",
  });

  expect(templateQuery).toEqual({
    where: { workspaceId: "workspace-1", kind: "template" },
    orderBy: { createdAt: "desc" },
    select: { content: true },
  });
  expect(createdData?.content).toEqual({
    tabs: {
      Summary: {
        markdown: "# Current Work\n\n## Next Steps\nWrite updates here",
      },
    },
  });
});

test("sendWeeklyAssignments creates a new parent and unread assignments for recipients", async () => {
  const created: Array<Record<string, unknown>> = [];
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "owner" }),
      findMany: async () => [{ userId: "leader" }, { userId: "member-a" }, { userId: "member-b" }],
    },
    weeklyReport: {
      findFirst: async () => ({
        id: "source-1",
        content: { tabs: { Summary: { markdown: "# Outline" } } },
      }),
      update: async () => ({}),
      create: async (query: { data: Record<string, unknown> }) => {
        created.push(query.data);
        return {
          id: `created-${created.length}`,
          title: query.data.title,
        };
      },
    },
    weeklyReportCycle: {
      findUnique: async () => ({
        id: "cycle-1",
        year: 2026,
        week: 38,
        title: "2026 W38 工作周报",
      }),
    },
    weeklyReportTemplate: {
      findFirst: async (query: { where?: { applied?: boolean } }) => {
        if (query.where?.applied === false) return null;
        return {
          id: "settings-1",
          allMembers: false,
          recipients: [{ userId: "member-a" }, { userId: "leader" }],
        };
      },
    },
    user: {
      findMany: async () => [
        { id: "member-a", displayName: "Alice", username: "alice" },
        { id: "leader", displayName: "Boss", username: "boss" },
      ],
    },
  } as unknown as PrismaClient;

  const result = await new RecordCatalog(db).sendWeeklyAssignments({
    workspaceId: "workspace-1",
    userId: "leader",
    sourceReportId: "source-1",
    content: { tabs: { Summary: { markdown: "# Outline" } } },
    now: new Date("2026-09-14T12:00:00+08:00"),
  });

  expect(result).toEqual({
    parentId: "created-1",
    title: "2026 W38 工作周报",
    year: 2026,
    week: 38,
    assignmentCount: 2,
  });
  expect(created).toHaveLength(3);
  expect(created[0]).toMatchObject({
    kind: "template",
    authorId: "leader",
    title: "2026 W38 工作周报",
  });
  expect(created[1]).toMatchObject({
    kind: "member",
    authorId: "member-a",
    sourceTemplateId: "created-1",
    title: "Alice的周报 · W38",
  });
  expect(created[2]).toMatchObject({
    kind: "member",
    authorId: "leader",
    sourceTemplateId: "created-1",
    title: "Boss的周报 · W38",
    status: "draft",
    content: {
      tabs: { Summary: { markdown: "# Outline" } },
      assignment: { unread: true },
    },
  });
});

test("sendWeeklyAssignments notifies the channel delivery after assignments exist", async () => {
  const notified: Array<Record<string, unknown>> = [];
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "owner" }),
      findMany: async () => [{ userId: "leader" }, { userId: "member-a" }],
    },
    weeklyReport: {
      findFirst: async () => ({
        id: "source-1",
        content: { tabs: { Summary: { markdown: "# Outline" } } },
      }),
      update: async () => ({}),
      create: async (query: { data: Record<string, unknown> }) => ({
        id: query.data.kind === "template" ? "parent-1" : "child-1",
        title: query.data.title,
      }),
    },
    weeklyReportCycle: {
      findUnique: async () => ({
        id: "cycle-1",
        year: 2026,
        week: 38,
        title: "2026 W38 工作周报",
      }),
    },
    weeklyReportTemplate: {
      findFirst: async () => ({
        id: "settings-1",
        allMembers: false,
        recipients: [{ userId: "member-a" }],
      }),
    },
    user: {
      findMany: async () => [{ id: "member-a", displayName: "Alice", username: "alice" }],
      findUnique: async () => ({ displayName: "Boss", username: "boss" }),
    },
  } as unknown as PrismaClient;

  await new RecordCatalog(db, {
    notifyChannel: async (input) => {
      notified.push(input);
    },
  }).sendWeeklyAssignments({
    workspaceId: "workspace-1",
    userId: "leader",
    sourceReportId: "source-1",
    now: new Date("2026-09-14T12:00:00+08:00"),
  });

  expect(notified).toEqual([
    {
      workspaceId: "workspace-1",
      senderUserId: "leader",
      parentReportId: "parent-1",
      week: 38,
      senderDisplayName: "Boss",
    },
  ]);
});

test("sendWeeklyAssignments still succeeds when channel delivery fails", async () => {
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "owner" }),
      findMany: async () => [{ userId: "leader" }, { userId: "member-a" }],
    },
    weeklyReport: {
      findFirst: async () => ({
        id: "source-1",
        content: { tabs: { Summary: { markdown: "# Outline" } } },
      }),
      update: async () => ({}),
      create: async (query: { data: Record<string, unknown> }) => ({
        id: query.data.kind === "template" ? "parent-1" : "child-1",
        title: query.data.title,
      }),
    },
    weeklyReportCycle: {
      findUnique: async () => ({
        id: "cycle-1",
        year: 2026,
        week: 38,
        title: "2026 W38 工作周报",
      }),
    },
    weeklyReportTemplate: {
      findFirst: async () => ({
        id: "settings-1",
        allMembers: false,
        recipients: [{ userId: "member-a" }],
      }),
    },
    user: {
      findMany: async () => [{ id: "member-a", displayName: "Alice", username: "alice" }],
      findUnique: async () => ({ displayName: "Boss", username: "boss" }),
    },
  } as unknown as PrismaClient;

  const result = await new RecordCatalog(db, {
    notifyChannel: async () => {
      throw new Error("channel down");
    },
  }).sendWeeklyAssignments({
    workspaceId: "workspace-1",
    userId: "leader",
    sourceReportId: "source-1",
    now: new Date("2026-09-14T12:00:00+08:00"),
  });

  expect(result.parentId).toBe("parent-1");
  expect(result.assignmentCount).toBe(1);
});

test("sendWeeklyAssignments rejects when no send settings are applied", async () => {
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "owner" }),
    },
    weeklyReport: {
      findFirst: async () => ({
        id: "source-1",
        content: { tabs: { Summary: { markdown: "# Outline" } } },
      }),
      update: async () => ({}),
      create: async () => {
        throw new Error("should not create reports without applied settings");
      },
    },
    weeklyReportTemplate: {
      findFirst: async () => null,
    },
  } as unknown as PrismaClient;

  await expect(
    new RecordCatalog(db).sendWeeklyAssignments({
      workspaceId: "workspace-1",
      userId: "leader",
      sourceReportId: "source-1",
    }),
  ).rejects.toMatchObject({
    code: "INVALID_INPUT",
  });
});

test("applyTemplate toggles off and allows zero applied rows", async () => {
  const updates: Array<Record<string, unknown>> = [];
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "owner" }),
    },
    weeklyReportTemplate: {
      findFirst: async () => ({ id: "settings-1", applied: true }),
      update: async (query: { where: { id: string }; data: Record<string, unknown> }) => {
        updates.push(query);
        return {};
      },
      updateMany: async () => ({ count: 0 }),
    },
  } as unknown as PrismaClient;

  const result = await new RecordCatalog(db).applyTemplate({
    workspaceId: "workspace-1",
    userId: "leader",
    templateId: "settings-1",
  });

  expect(result).toEqual({ id: "settings-1", active: false });
  expect(updates).toEqual([{ where: { id: "settings-1" }, data: { applied: false } }]);
});

test("applyTemplate activates one row and clears other applied rows", async () => {
  const ops: string[] = [];
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "owner" }),
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
    weeklyReportTemplate: {
      findFirst: async () => ({ id: "settings-2", applied: false }),
      updateMany: async (query: { where: object; data: object }) => {
        ops.push(`updateMany:${JSON.stringify(query)}`);
        return { count: 1 };
      },
      update: async (query: { where: object; data: object }) => {
        ops.push(`update:${JSON.stringify(query)}`);
        return {};
      },
    },
  } as unknown as PrismaClient;

  const result = await new RecordCatalog(db).applyTemplate({
    workspaceId: "workspace-1",
    userId: "leader",
    templateId: "settings-2",
  });

  expect(result).toEqual({ id: "settings-2", active: true });
  expect(ops).toEqual([
    'updateMany:{"where":{"workspaceId":"workspace-1","applied":true},"data":{"applied":false}}',
    'update:{"where":{"id":"settings-2"},"data":{"applied":true}}',
  ]);
});

test("setTemplateScheduleEnabled updates the schedule checkbox independently", async () => {
  let updated: Record<string, unknown> | undefined;
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "owner" }),
    },
    weeklyReportTemplate: {
      findFirst: async () => ({ id: "settings-1" }),
      update: async (query: { data: Record<string, unknown> }) => {
        updated = query.data;
        return {};
      },
    },
  } as unknown as PrismaClient;

  const result = await new RecordCatalog(db).setTemplateScheduleEnabled({
    workspaceId: "workspace-1",
    userId: "leader",
    templateId: "settings-1",
    scheduleEnabled: true,
  });

  expect(result).toEqual({ id: "settings-1", scheduleEnabled: true });
  expect(updated).toEqual({ scheduleEnabled: true });
});

test("runDueScheduledWeeklyAssignments skips when not due", async () => {
  const db = {
    weeklyReportTemplate: {
      findMany: async () => [
        {
          id: "settings-1",
          workspaceId: "workspace-1",
          sendTime: "15:00",
          sendWeekday: 5,
        },
      ],
    },
  } as unknown as PrismaClient;

  // Thursday 15:00 Asia/Shanghai
  const result = await new RecordCatalog(db).runDueScheduledWeeklyAssignments({
    now: new Date("2026-09-17T07:00:00.000Z"),
  });

  expect(result.sent).toBe(0);
  expect(result.results).toEqual([
    {
      workspaceId: "workspace-1",
      templateId: "settings-1",
      status: "skipped",
      reason: "not-due",
    },
  ]);
});

test("runDueScheduledWeeklyAssignments skips when the ISO week already has assignments", async () => {
  const db = {
    weeklyReportTemplate: {
      findMany: async () => [
        {
          id: "settings-1",
          workspaceId: "workspace-1",
          sendTime: "15:00",
          sendWeekday: 5,
        },
      ],
    },
    weeklyReport: {
      findFirst: async () => ({ id: "already-parent" }),
    },
  } as unknown as PrismaClient;

  const result = await new RecordCatalog(db).runDueScheduledWeeklyAssignments({
    now: new Date("2026-09-18T07:30:00.000Z"),
  });

  expect(result.sent).toBe(0);
  expect(result.results[0]).toMatchObject({
    status: "skipped",
    reason: "already-sent",
  });
});

test("runDueScheduledWeeklyAssignments sends when due and not yet sent", async () => {
  let sendCalls = 0;
  const created: Array<Record<string, unknown>> = [];
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "owner", userId: "leader" }),
      findMany: async () => [{ userId: "leader" }, { userId: "member-a" }],
    },
    weeklyReportTemplate: {
      findMany: async () => [
        {
          id: "settings-1",
          workspaceId: "workspace-1",
          sendTime: "15:00",
          sendWeekday: 5,
        },
      ],
      findFirst: async () => ({
        id: "settings-1",
        allMembers: false,
        recipients: [{ userId: "member-a" }],
      }),
    },
    weeklyReport: {
      findFirst: async (query: { where?: { submissions?: unknown; kind?: string } }) => {
        if (query.where?.submissions) return null;
        return {
          id: "source-1",
          authorId: "leader",
          content: { tabs: { Summary: { markdown: "# Outline" } } },
        };
      },
      update: async () => ({}),
      create: async (query: { data: Record<string, unknown> }) => {
        sendCalls += 1;
        created.push(query.data);
        return {
          id: query.data.kind === "template" ? "parent-1" : `child-${created.length}`,
          title: query.data.title,
        };
      },
    },
    weeklyReportCycle: {
      findUnique: async () => ({
        id: "cycle-1",
        year: 2026,
        week: 38,
        title: "2026 W38 工作周报",
      }),
    },
    user: {
      findMany: async () => [{ id: "member-a", displayName: "Alice", username: "alice" }],
      findUnique: async () => ({ displayName: "Boss", username: "boss" }),
    },
  } as unknown as PrismaClient;

  const result = await new RecordCatalog(db).runDueScheduledWeeklyAssignments({
    now: new Date("2026-09-18T07:30:00.000Z"),
  });

  expect(result.sent).toBe(1);
  expect(result.results[0]).toMatchObject({
    status: "sent",
    parentId: "parent-1",
    assignmentCount: 1,
  });
  expect(sendCalls).toBeGreaterThan(0);
});
