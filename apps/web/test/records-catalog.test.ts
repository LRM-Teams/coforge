import { expect, test } from "bun:test";
import type { PrismaClient } from "../generated/client";
import { RecordCatalog } from "../src/server/records/record-catalog.server";

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
        settingsId: "settings-1",
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
      findFirst: async (query: { where?: { applied?: boolean; id?: string } }) => {
        if (query.where?.applied === false) return null;
        expect(query.where?.id).toBe("settings-1");
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
    settingsId: "settings-1",
    title: "2026 W38 工作周报",
  });
  expect(created[1]).toMatchObject({
    kind: "member",
    authorId: "member-a",
    sourceTemplateId: "created-1",
    title: "Alice 2026 W38 工作周报",
  });
  expect(created[2]).toMatchObject({
    kind: "member",
    authorId: "leader",
    sourceTemplateId: "created-1",
    title: "Boss 2026 W38 工作周报",
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
        settingsId: "settings-1",
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
        settingsId: "settings-1",
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
        settingsId: "settings-1",
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

test("sendWeeklyAssignments rejects when the format has no settings stream", async () => {
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "owner" }),
    },
    weeklyReport: {
      findFirst: async () => ({
        id: "source-1",
        settingsId: null,
        content: { tabs: { Summary: { markdown: "# Outline" } } },
      }),
    },
  } as unknown as PrismaClient;

  await expect(
    new RecordCatalog(db).sendWeeklyAssignments({
      workspaceId: "workspace-1",
      userId: "leader",
      sourceReportId: "source-1",
    }),
  ).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
});

test("applyTemplate toggles off and allows zero applied rows", async () => {
  const updates: Array<Record<string, unknown>> = [];
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "owner" }),
    },
    weeklyReportTemplate: {
      findFirst: async () => ({
        id: "settings-1",
        name: "算法汇报",
        applied: true,
        dimensions: [],
      }),
      update: async (query: { where: { id: string }; data: Record<string, unknown> }) => {
        updates.push(query);
        return {};
      },
    },
  } as unknown as PrismaClient;

  const result = await new RecordCatalog(db).applyTemplate({
    workspaceId: "workspace-1",
    userId: "leader",
    templateId: "settings-1",
  });

  expect(result).toEqual({ id: "settings-1", active: false });
  expect(updates).toEqual([
    { where: { id: "settings-1" }, data: { applied: false, scheduleEnabled: false } },
  ]);
});

test("applyTemplate activates one stream without clearing other applied rows", async () => {
  const ops: string[] = [];
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "owner" }),
    },
    weeklyReportTemplate: {
      findFirst: async () => ({
        id: "settings-2",
        name: "产品汇报",
        applied: false,
        dimensions: [],
      }),
      updateMany: async () => {
        ops.push("updateMany");
        return { count: 1 };
      },
      update: async (query: { where: object; data: object }) => {
        ops.push(`update:${JSON.stringify(query)}`);
        return {};
      },
    },
    weeklyReport: {
      findFirst: async () => ({ id: "existing-format" }),
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
    'update:{"where":{"id":"settings-2"},"data":{"applied":true,"scheduleEnabled":true}}',
    'update:{"where":{"id":"existing-format"},"data":{"title":"产品汇报"}}',
  ]);
  expect(ops).not.toContain("updateMany");
});

test("setTemplateScheduleEnabled keeps applied in sync with scheduleEnabled", async () => {
  let updated: Record<string, unknown> | undefined;
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "owner" }),
    },
    weeklyReportTemplate: {
      findFirst: async () => ({
        id: "settings-1",
        name: "算法汇报",
        applied: false,
        dimensions: [],
      }),
      update: async (query: { data: Record<string, unknown> }) => {
        updated = query.data;
        return {};
      },
    },
    weeklyReport: {
      findFirst: async () => ({ id: "format-1" }),
      update: async () => ({}),
    },
  } as unknown as PrismaClient;

  const result = await new RecordCatalog(db).setTemplateScheduleEnabled({
    workspaceId: "workspace-1",
    userId: "leader",
    templateId: "settings-1",
    scheduleEnabled: true,
  });

  expect(result).toEqual({ id: "settings-1", scheduleEnabled: true, active: true });
  expect(updated).toEqual({ scheduleEnabled: true, applied: true });
});

test("createTemplate with scheduleEnabled writes applied and ensures a format", async () => {
  const createdTemplates: Array<Record<string, unknown>> = [];
  const createdReports: Array<Record<string, unknown>> = [];
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "member" }),
      count: async () => 0,
    },
    weeklyReportTemplate: {
      create: async (query: { data: Record<string, unknown> }) => {
        createdTemplates.push(query.data);
        return { id: "settings-new", name: query.data.name, dimensions: query.data.dimensions };
      },
    },
    weeklyReport: {
      findFirst: async () => null,
      create: async (query: { data: Record<string, unknown> }) => {
        createdReports.push(query.data);
        return { id: "format-new" };
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
  } as unknown as PrismaClient;

  const result = await new RecordCatalog(db).createTemplate({
    workspaceId: "workspace-1",
    userId: "leader-b",
    name: "算法汇报",
    frequency: "weekly",
    sendTime: "15:00",
    sendWeekday: 5,
    scheduleEnabled: true,
    sections: [{ title: "Summary", children: ["Current Works"] }],
    allMembers: true,
    recipientUserIds: [],
  });

  expect(result).toEqual({ id: "settings-new" });
  expect(createdTemplates[0]).toMatchObject({
    applied: true,
    scheduleEnabled: true,
    name: "算法汇报",
  });
  expect(createdReports[0]).toMatchObject({
    kind: "template",
    settingsId: "settings-new",
    authorId: "leader-b",
  });
});

test("createTemplate with scheduleEnabled false stays inactive", async () => {
  const createdTemplates: Array<Record<string, unknown>> = [];
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "member" }),
    },
    weeklyReportTemplate: {
      create: async (query: { data: Record<string, unknown> }) => {
        createdTemplates.push(query.data);
        return { id: "settings-off" };
      },
    },
    weeklyReport: {
      create: async () => {
        throw new Error("should not ensure format");
      },
    },
  } as unknown as PrismaClient;

  await new RecordCatalog(db).createTemplate({
    workspaceId: "workspace-1",
    userId: "leader-b",
    name: "算法汇报",
    frequency: "weekly",
    sendTime: "12:00",
    sendWeekday: 5,
    scheduleEnabled: false,
    sections: [{ title: "Summary", children: [] }],
    allMembers: true,
    recipientUserIds: [],
  });

  expect(createdTemplates[0]).toMatchObject({
    applied: false,
    scheduleEnabled: false,
  });
});

test("updateTemplate syncs applied with scheduleEnabled and ensures format when enabling", async () => {
  const updates: Array<Record<string, unknown>> = [];
  const createdReports: Array<Record<string, unknown>> = [];
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "member" }),
      count: async () => 0,
    },
    weeklyReportTemplate: {
      findFirst: async () => ({
        id: "settings-1",
        applied: false,
        name: "旧名",
      }),
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        weeklyReportTemplateRecipient: {
          deleteMany: async () => ({ count: 0 }),
        },
        weeklyReportTemplate: {
          update: async (query: { data: Record<string, unknown> }) => {
            updates.push(query.data);
            return {};
          },
        },
      };
      return fn(tx);
    },
    weeklyReport: {
      findFirst: async () => null,
      create: async (query: { data: Record<string, unknown> }) => {
        createdReports.push(query.data);
        return { id: "format-from-update" };
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
  } as unknown as PrismaClient;

  await new RecordCatalog(db).updateTemplate({
    workspaceId: "workspace-1",
    userId: "leader-b",
    templateId: "settings-1",
    name: "算法汇报",
    frequency: "weekly",
    sendTime: "15:00",
    sendWeekday: 5,
    scheduleEnabled: true,
    sections: [{ title: "Summary", children: [] }],
    allMembers: true,
    recipientUserIds: [],
  });

  expect(updates[0]).toMatchObject({
    applied: true,
    scheduleEnabled: true,
    name: "算法汇报",
  });
  expect(createdReports[0]).toMatchObject({
    settingsId: "settings-1",
    kind: "template",
  });
});

test("runDueScheduledWeeklyAssignments skips when not due", async () => {
  const db = {
    weeklyReportTemplate: {
      findMany: async () => [
        {
          id: "settings-1",
          name: "算法汇报",
          workspaceId: "workspace-1",
          ownerId: "leader",
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
          name: "算法汇报",
          workspaceId: "workspace-1",
          ownerId: "leader",
          sendTime: "15:00",
          sendWeekday: 5,
        },
      ],
    },
    weeklyReport: {
      findFirst: async (query: {
        where?: { settingsId?: string; submissions?: { some?: unknown } };
      }) => {
        expect(query.where?.settingsId).toBe("settings-1");
        expect(query.where?.submissions?.some).toBeTruthy();
        return { id: "already-parent" };
      },
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
          name: "算法汇报",
          workspaceId: "workspace-1",
          ownerId: "leader",
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
      findFirst: async (query: {
        where?: {
          id?: string;
          settingsId?: string;
          submissions?: { some?: unknown; none?: unknown };
        };
      }) => {
        if (query.where?.submissions?.some) return null;
        return {
          id: "source-1",
          authorId: "leader",
          settingsId: "settings-1",
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
  expect(created[0]).toMatchObject({
    kind: "template",
    settingsId: "settings-1",
  });
  expect(sendCalls).toBeGreaterThan(0);
});

test("runDueScheduledWeeklyAssignments skips when Leader edited the format this week", async () => {
  const db = {
    weeklyReportTemplate: {
      findMany: async () => [
        {
          id: "settings-1",
          name: "算法汇报",
          workspaceId: "workspace-1",
          ownerId: "leader",
          sendTime: "15:00",
          sendWeekday: 5,
        },
      ],
    },
    weeklyReport: {
      findFirst: async (query: {
        where?: { submissions?: { some?: unknown; none?: unknown } };
      }) => {
        if (query.where?.submissions?.some) return null;
        return {
          id: "format-1",
          content: {
            tabs: { Summary: { markdown: "edited" } },
            schedule: { cancelledYear: 2026, cancelledWeek: 38 },
          },
        };
      },
    },
  } as unknown as PrismaClient;

  const result = await new RecordCatalog(db).runDueScheduledWeeklyAssignments({
    now: new Date("2026-09-18T07:30:00.000Z"),
  });

  expect(result.sent).toBe(0);
  expect(result.results[0]).toMatchObject({
    status: "skipped",
    reason: "auto-send-cancelled",
  });
});

test("saveReportContent rejects when a Leader edits a submitted member assignment", async () => {
  let updated = false;
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "owner" }),
    },
    weeklyReport: {
      findFirst: async () => ({
        id: "assignment-1",
        authorId: "member-a",
        kind: "member",
        status: "submitted",
      }),
      update: async () => {
        updated = true;
        return { id: "assignment-1", status: "submitted", updatedAt: new Date() };
      },
    },
  } as unknown as PrismaClient;

  await expect(
    new RecordCatalog(db).saveReportContent({
      workspaceId: "workspace-1",
      userId: "leader",
      reportId: "assignment-1",
      content: { tabs: { Summary: { markdown: "Leader rewrite" } } },
    }),
  ).rejects.toThrow("ACCESS_DENIED");
  expect(updated).toBe(false);
});

test("getSubject marks a submitted member assignment read-only for the Leader", async () => {
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "owner" }),
    },
    weeklyReport: {
      findFirst: async () => ({
        id: "assignment-1",
        kind: "member",
        title: "Alice 2026 W38 工作周报",
        status: "submitted",
        content: { tabs: { Summary: { markdown: "Done" } } },
        submittedAt: new Date("2026-09-18T08:00:00.000Z"),
        updatedAt: new Date("2026-09-18T08:00:00.000Z"),
        sourceTemplateId: "parent-1",
        sourceTemplate: { authorId: "leader" },
        author: { id: "member-a", username: "alice", displayName: "Alice" },
        cycle: { id: "cycle-1", year: 2026, week: 38, title: "2026 W38 工作周报" },
      }),
    },
    weeklyReportFavorite: {
      findUnique: async () => null,
    },
  } as unknown as PrismaClient;

  const subject = await new RecordCatalog(db).getSubject({
    workspaceId: "workspace-1",
    userId: "leader",
    id: "assignment-1",
  });

  expect(subject).toMatchObject({
    type: "report",
    report: { id: "assignment-1", kind: "member", editable: false },
  });
});

test("getSubject keeps a submitted assignment editable for its author", async () => {
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "member" }),
    },
    weeklyReport: {
      findFirst: async () => ({
        id: "assignment-1",
        kind: "member",
        title: "Alice 2026 W38 工作周报",
        status: "submitted",
        content: { tabs: { Summary: { markdown: "Done" } } },
        submittedAt: new Date("2026-09-18T08:00:00.000Z"),
        updatedAt: new Date("2026-09-18T08:00:00.000Z"),
        sourceTemplateId: "parent-1",
        sourceTemplate: { authorId: "leader" },
        author: { id: "member-a", username: "alice", displayName: "Alice" },
        cycle: { id: "cycle-1", year: 2026, week: 38, title: "2026 W38 工作周报" },
      }),
    },
    weeklyReportFavorite: {
      findUnique: async () => null,
    },
  } as unknown as PrismaClient;

  const subject = await new RecordCatalog(db).getSubject({
    workspaceId: "workspace-1",
    userId: "member-a",
    id: "assignment-1",
  });

  expect(subject).toMatchObject({
    type: "report",
    report: { id: "assignment-1", kind: "member", editable: true },
  });
});

test("listTemplates only returns settings owned by the viewer", async () => {
  const queried: Array<Record<string, unknown>> = [];
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "member" }),
    },
    weeklyReportTemplate: {
      findMany: async (query: { where: Record<string, unknown> }) => {
        queried.push(query.where);
        return [];
      },
    },
  } as unknown as PrismaClient;

  await new RecordCatalog(db).listTemplates({
    workspaceId: "workspace-1",
    userId: "leader-b",
  });

  expect(queried).toEqual([{ workspaceId: "workspace-1", ownerId: "leader-b" }]);
});

test("createTemplate rejects a send time that is not an on-the-hour slot", async () => {
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "member" }),
    },
    weeklyReportTemplate: {
      create: async () => {
        throw new Error("should not create");
      },
    },
  } as unknown as PrismaClient;

  await expect(
    new RecordCatalog(db).createTemplate({
      workspaceId: "workspace-1",
      userId: "leader-b",
      name: "算法汇报",
      frequency: "weekly",
      sendTime: "15:30",
      sendWeekday: 5,
      scheduleEnabled: true,
      sections: [{ title: "Summary", children: [] }],
      allMembers: true,
      recipientUserIds: [],
    }),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });
});

test("loadCatalog hides other leaders' template parents under 成员周报", async () => {
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "member" }),
    },
    weeklyReportCycle: {
      findMany: async () => [
        {
          id: "cycle-1",
          year: 2026,
          week: 38,
          title: "2026 W38 工作周报",
          reports: [
            {
              id: "leader-a-format",
              kind: "template",
              authorId: "leader-a",
              title: "Format A",
              status: "draft",
              content: { tabs: { Summary: { markdown: "" } } },
              sourceTemplateId: null,
              createdAt: new Date("2026-09-14T02:00:00.000Z"),
              author: { id: "leader-a", username: "a", displayName: "A" },
            },
            {
              id: "leader-b-format",
              kind: "template",
              authorId: "leader-b",
              title: "Format B",
              status: "draft",
              content: { tabs: { Summary: { markdown: "" } } },
              sourceTemplateId: null,
              createdAt: new Date("2026-09-14T03:00:00.000Z"),
              author: { id: "leader-b", username: "b", displayName: "B" },
            },
            {
              id: "leader-b-overview",
              kind: "template",
              authorId: "leader-b",
              title: "2026 W38 工作周报",
              status: "draft",
              content: { tabs: { Summary: { markdown: "" } } },
              sourceTemplateId: null,
              createdAt: new Date("2026-09-14T01:00:00.000Z"),
              author: { id: "leader-b", username: "b", displayName: "B" },
            },
            {
              id: "submission-under-b",
              kind: "member",
              authorId: "member-a",
              title: "Alice 2026 W38 工作周报",
              status: "submitted",
              content: { tabs: { Summary: { markdown: "Done" } } },
              sourceTemplateId: "leader-b-overview",
              createdAt: new Date("2026-09-14T04:00:00.000Z"),
              author: { id: "member-a", username: "alice", displayName: "Alice" },
            },
            {
              id: "mine",
              kind: "member",
              authorId: "leader-b",
              title: "B 2026 W38 工作周报",
              status: "draft",
              content: { tabs: { Summary: { markdown: "" } }, assignment: { unread: true } },
              sourceTemplateId: "leader-a-format",
              createdAt: new Date("2026-09-14T05:00:00.000Z"),
              author: { id: "leader-b", username: "b", displayName: "B" },
            },
          ],
        },
      ],
    },
    weeklyReportFavorite: { findMany: async () => [] },
    recordNote: { findMany: async () => [] },
    user: {
      findUnique: async () => ({ id: "leader-b", username: "b", displayName: "B" }),
    },
    weeklyReportTemplate: {
      findMany: async (query: { where?: { ownerId?: string; applied?: boolean } }) => {
        expect(query.where?.ownerId).toBe("leader-b");
        expect(query.where?.applied).toBe(true);
        return [];
      },
    },
  } as unknown as PrismaClient;

  const catalog = await new RecordCatalog(db).loadCatalog({
    workspaceId: "workspace-1",
    userId: "leader-b",
  });

  expect(catalog.memberWeeks).toEqual([
    {
      year: 2026,
      week: 38,
      title: "2026 W38 工作周报",
      cycleId: "cycle-1",
      overviewReportId: "leader-b-overview",
      submissions: [
        expect.objectContaining({
          id: "submission-under-b",
          title: "Alice 2026 W38 工作周报",
          author: expect.objectContaining({ displayName: "Alice" }),
        }),
      ],
    },
  ]);
  expect(catalog.formatChips).toEqual([
    expect.objectContaining({
      id: null,
      interactive: false,
      sendArmed: false,
    }),
  ]);
  expect(catalog.myReports.map((row) => row.id)).toEqual(["mine"]);
});

test("loadCatalog creates a personal format when send settings are applied", async () => {
  const created: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "member" }),
    },
    weeklyReportCycle: {
      findMany: async () => [],
      findUnique: async () => ({
        id: "cycle-1",
        year: 2026,
        week: 38,
        title: "2026 W38 工作周报",
      }),
      create: async () => {
        throw new Error("cycle should already exist");
      },
    },
    weeklyReportFavorite: { findMany: async () => [] },
    recordNote: { findMany: async () => [] },
    user: {
      findUnique: async () => ({ id: "leader-b", username: "b", displayName: "B" }),
    },
    weeklyReportTemplate: {
      findMany: async () => [
        {
          id: "settings-b",
          name: "算法汇报",
          sendWeekday: 5,
          sendTime: "15:00",
          scheduleEnabled: false,
          dimensions: [],
        },
      ],
    },
    weeklyReport: {
      findFirst: async () => null,
      create: async (query: { data: Record<string, unknown> }) => {
        created.push(query.data);
        return { id: "format-new" };
      },
      update: async (query: { data: Record<string, unknown> }) => {
        updates.push(query.data);
        return {};
      },
    },
  } as unknown as PrismaClient;

  const catalog = await new RecordCatalog(db).loadCatalog({
    workspaceId: "workspace-1",
    userId: "leader-b",
  });

  expect(catalog.formatChips).toEqual([
    expect.objectContaining({
      id: "format-new",
      settingsId: "settings-b",
      name: "算法汇报",
      interactive: true,
    }),
  ]);
  expect(created[0]).toMatchObject({
    kind: "template",
    authorId: "leader-b",
    settingsId: "settings-b",
    title: "算法汇报",
  });
});

test("loadCatalog exposes one chip per applied settings stream", async () => {
  const created: Array<Record<string, unknown>> = [];
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "member" }),
    },
    weeklyReportCycle: {
      findMany: async () => [
        {
          id: "cycle-1",
          year: 2026,
          week: 38,
          title: "2026 W38 工作周报",
          reports: [
            {
              id: "overview-algo",
              kind: "template",
              authorId: "leader-b",
              title: "2026 W38 工作周报",
              status: "draft",
              content: { tabs: { Summary: { markdown: "" } } },
              sourceTemplateId: null,
              settingsId: "settings-algo",
              createdAt: new Date("2026-09-14T01:00:00.000Z"),
              author: { id: "leader-b", username: "b", displayName: "B" },
            },
            {
              id: "assignment-algo",
              kind: "member",
              authorId: "member-a",
              title: "Alice 2026 W38 工作周报",
              status: "draft",
              content: { tabs: { Summary: { markdown: "" } } },
              sourceTemplateId: "overview-algo",
              settingsId: null,
              createdAt: new Date("2026-09-14T02:00:00.000Z"),
              author: { id: "member-a", username: "alice", displayName: "Alice" },
            },
          ],
        },
      ],
      findUnique: async () => ({
        id: "cycle-1",
        year: 2026,
        week: 38,
        title: "2026 W38 工作周报",
      }),
    },
    weeklyReportFavorite: { findMany: async () => [] },
    recordNote: { findMany: async () => [] },
    user: {
      findUnique: async () => ({ id: "leader-b", username: "b", displayName: "B" }),
    },
    weeklyReportTemplate: {
      findMany: async () => [
        {
          id: "settings-algo",
          name: "算法汇报",
          sendWeekday: 5,
          sendTime: "15:00",
          scheduleEnabled: false,
          dimensions: [],
        },
        {
          id: "settings-product",
          name: "产品汇报",
          sendWeekday: 5,
          sendTime: "15:00",
          scheduleEnabled: false,
          dimensions: [],
        },
      ],
    },
    weeklyReport: {
      findFirst: async (query: { where?: { settingsId?: string | null } }) => {
        if (query.where?.settingsId === "settings-algo") return { id: "format-algo" };
        return null;
      },
      create: async (query: { data: Record<string, unknown> }) => {
        created.push(query.data);
        return { id: "format-product" };
      },
      update: async () => ({}),
    },
  } as unknown as PrismaClient;

  const catalog = await new RecordCatalog(db).loadCatalog({
    workspaceId: "workspace-1",
    userId: "leader-b",
  });

  expect(catalog.formatChips).toEqual([
    expect.objectContaining({
      id: "format-algo",
      settingsId: "settings-algo",
      name: "算法汇报",
      alreadySent: true,
      interactive: true,
    }),
    expect.objectContaining({
      id: "format-product",
      settingsId: "settings-product",
      name: "产品汇报",
      alreadySent: false,
      interactive: true,
    }),
  ]);
  expect(created[0]).toMatchObject({
    settingsId: "settings-product",
    title: "产品汇报",
  });
});

test("applyTemplate ensures a personal format when activating settings", async () => {
  const created: Array<Record<string, unknown>> = [];
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "member" }),
    },
    weeklyReportTemplate: {
      findFirst: async () => ({
        id: "settings-b",
        name: "算法汇报",
        applied: false,
        dimensions: [{ title: "Summary", children: ["Current Works"] }],
      }),
      update: async () => ({}),
    },
    weeklyReport: {
      findFirst: async () => null,
      create: async (query: { data: Record<string, unknown> }) => {
        created.push(query.data);
        return { id: "format-from-apply" };
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
  } as unknown as PrismaClient;

  const result = await new RecordCatalog(db).applyTemplate({
    workspaceId: "workspace-1",
    userId: "leader-b",
    templateId: "settings-b",
  });

  expect(result).toEqual({ id: "settings-b", active: true });
  expect(created[0]).toMatchObject({
    kind: "template",
    authorId: "leader-b",
    settingsId: "settings-b",
    title: "算法汇报",
  });
  expect(
    (created[0]?.content as { tabs?: { Summary?: { markdown?: string } } })?.tabs?.Summary
      ?.markdown,
  ).toContain("## Current Works");
});

test("getSubject rejects unrelated members opening another leader's format", async () => {
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "member" }),
    },
    weeklyReport: {
      findFirst: async (query: { where?: { sourceTemplateId?: string; authorId?: string } }) => {
        if (query.where?.sourceTemplateId) return null;
        return {
          id: "leader-a-format",
          kind: "template",
          title: "Format A",
          status: "draft",
          content: { tabs: { Summary: { markdown: "secret" } } },
          submittedAt: null,
          updatedAt: new Date("2026-09-14T02:00:00.000Z"),
          sourceTemplateId: null,
          sourceTemplate: null,
          author: { id: "leader-a", username: "a", displayName: "A" },
          cycle: { id: "cycle-1", year: 2026, week: 38, title: "2026 W38 工作周报" },
        };
      },
    },
  } as unknown as PrismaClient;

  await expect(
    new RecordCatalog(db).getSubject({
      workspaceId: "workspace-1",
      userId: "outsider",
      id: "leader-a-format",
    }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("getSubject rejects unrelated members opening another member's assignment", async () => {
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "member" }),
    },
    weeklyReport: {
      findFirst: async () => ({
        id: "assignment-1",
        kind: "member",
        title: "Alice 2026 W38 工作周报",
        status: "submitted",
        content: { tabs: { Summary: { markdown: "Done" } } },
        submittedAt: new Date("2026-09-18T08:00:00.000Z"),
        updatedAt: new Date("2026-09-18T08:00:00.000Z"),
        sourceTemplateId: "parent-1",
        sourceTemplate: { authorId: "leader" },
        author: { id: "member-a", username: "alice", displayName: "Alice" },
        cycle: { id: "cycle-1", year: 2026, week: 38, title: "2026 W38 工作周报" },
      }),
    },
  } as unknown as PrismaClient;

  await expect(
    new RecordCatalog(db).getSubject({
      workspaceId: "workspace-1",
      userId: "member-b",
      id: "assignment-1",
    }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("getSubject overview children only include the assignee's own submission", async () => {
  const childQueries: Array<Record<string, unknown>> = [];
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "member" }),
    },
    weeklyReport: {
      findFirst: async (query: { where?: { sourceTemplateId?: string; authorId?: string } }) => {
        if (query.where?.sourceTemplateId === "parent-1" && query.where?.authorId === "member-a") {
          return { id: "assignment-1" };
        }
        return {
          id: "parent-1",
          kind: "template",
          title: "2026 W38 工作周报",
          status: "draft",
          content: { tabs: { Summary: { markdown: "Outline" } } },
          submittedAt: null,
          updatedAt: new Date("2026-09-14T02:00:00.000Z"),
          sourceTemplateId: null,
          sourceTemplate: null,
          author: { id: "leader", username: "boss", displayName: "Boss" },
          cycle: { id: "cycle-1", year: 2026, week: 38, title: "2026 W38 工作周报" },
        };
      },
      count: async () => 2,
      findMany: async (query: { where: Record<string, unknown> }) => {
        childQueries.push(query.where);
        return [
          {
            id: "assignment-1",
            title: "Alice 2026 W38 工作周报",
            status: "submitted",
            author: { id: "member-a", username: "alice", displayName: "Alice" },
          },
        ];
      },
    },
  } as unknown as PrismaClient;

  const subject = await new RecordCatalog(db).getSubject({
    workspaceId: "workspace-1",
    userId: "member-a",
    id: "parent-1",
  });

  expect(subject).toMatchObject({
    type: "report",
    report: {
      id: "parent-1",
      surface: "overview",
      children: [{ id: "assignment-1" }],
    },
  });
  expect(childQueries[0]).toMatchObject({
    sourceTemplateId: "parent-1",
    authorId: "member-a",
  });
});

test("applyTemplate scopes activation to the owner without clearing peers", async () => {
  const ops: string[] = [];
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "member" }),
    },
    weeklyReportTemplate: {
      findFirst: async (query: { where?: { ownerId?: string } }) => {
        expect(query.where?.ownerId).toBe("leader-b");
        return {
          id: "settings-b",
          name: "算法汇报",
          applied: false,
          dimensions: [],
        };
      },
      updateMany: async () => {
        ops.push("updateMany");
        return { count: 1 };
      },
      update: async (query: { where: object; data: object }) => {
        ops.push(`update:${JSON.stringify(query)}`);
        return {};
      },
    },
    weeklyReport: {
      findFirst: async () => ({ id: "existing-format" }),
      update: async (query: { where: object; data: object }) => {
        ops.push(`update:${JSON.stringify(query)}`);
        return {};
      },
    },
  } as unknown as PrismaClient;

  await new RecordCatalog(db).applyTemplate({
    workspaceId: "workspace-1",
    userId: "leader-b",
    templateId: "settings-b",
  });

  expect(ops).toEqual([
    'update:{"where":{"id":"settings-b"},"data":{"applied":true,"scheduleEnabled":true}}',
    'update:{"where":{"id":"existing-format"},"data":{"title":"算法汇报"}}',
  ]);
  expect(ops).not.toContain("updateMany");
});

test("saveReportContent syncs H1/H2 outline back to applied settings", async () => {
  const updates: Array<Record<string, unknown>> = [];
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "member" }),
    },
    weeklyReport: {
      findFirst: async () => ({
        id: "format-1",
        authorId: "leader",
        kind: "template",
        settingsId: "settings-1",
        submissions: [],
      }),
      update: async () => ({
        id: "format-1",
        status: "draft",
        updatedAt: new Date("2026-09-14T10:00:00.000Z"),
      }),
    },
    weeklyReportTemplate: {
      findFirst: async (query: { where?: { id?: string } }) => {
        expect(query.where?.id).toBe("settings-1");
        return { id: "settings-1" };
      },
      update: async (query: { data: Record<string, unknown> }) => {
        updates.push(query.data);
        return {};
      },
    },
  } as unknown as PrismaClient;

  await new RecordCatalog(db).saveReportContent({
    workspaceId: "workspace-1",
    userId: "leader",
    reportId: "format-1",
    content: {
      tabs: {
        Summary: {
          markdown: "# Summary\n## Current Works\n# Technique",
        },
      },
    },
  });

  expect(updates[0]).toEqual({
    dimensions: [
      { title: "Summary", children: ["Current Works"] },
      { title: "Technique", children: [] },
    ],
    mainTitles: [],
  });
});

test("sendWeeklyAssignments rejects sending another leader's format", async () => {
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "member" }),
    },
    weeklyReport: {
      findFirst: async () => null,
      create: async () => {
        throw new Error("should not create");
      },
    },
  } as unknown as PrismaClient;

  await expect(
    new RecordCatalog(db).sendWeeklyAssignments({
      workspaceId: "workspace-1",
      userId: "leader-b",
      sourceReportId: "leader-a-format",
    }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("getSubject reports whether the viewer favorited a member report", async () => {
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "member" }),
    },
    weeklyReport: {
      findFirst: async () => ({
        id: "assignment-1",
        kind: "member",
        title: "Alice 2026 W38 工作周报",
        status: "submitted",
        content: { tabs: { Summary: { markdown: "Done" } } },
        submittedAt: new Date("2026-09-18T08:00:00.000Z"),
        updatedAt: new Date("2026-09-18T08:00:00.000Z"),
        sourceTemplateId: "parent-1",
        sourceTemplate: { authorId: "leader" },
        author: { id: "member-a", username: "alice", displayName: "Alice" },
        cycle: { id: "cycle-1", year: 2026, week: 38, title: "2026 W38 工作周报" },
      }),
      count: async () => 0,
    },
    weeklyReportFavorite: {
      findUnique: async (query: {
        where?: { userId_reportId?: { userId: string; reportId: string } };
      }) => {
        expect(query.where?.userId_reportId).toEqual({
          userId: "leader",
          reportId: "assignment-1",
        });
        return { userId: "leader", reportId: "assignment-1" };
      },
    },
  } as unknown as PrismaClient;

  const subject = await new RecordCatalog(db).getSubject({
    workspaceId: "workspace-1",
    userId: "leader",
    id: "assignment-1",
  });

  expect(subject).toMatchObject({
    type: "report",
    report: { id: "assignment-1", kind: "member", favorited: true },
  });
});

test("setReportFavorite adds and removes a favorite for an accessible member report", async () => {
  const creates: Array<Record<string, unknown>> = [];
  const deletes: Array<Record<string, unknown>> = [];
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "member" }),
    },
    weeklyReport: {
      findFirst: async () => ({
        id: "assignment-1",
        kind: "member",
        authorId: "member-a",
        sourceTemplate: { authorId: "leader" },
      }),
    },
    weeklyReportFavorite: {
      upsert: async (query: { where: unknown; create: Record<string, unknown> }) => {
        creates.push(query.create);
        return query.create;
      },
      deleteMany: async (query: { where: Record<string, unknown> }) => {
        deletes.push(query.where);
        return { count: 1 };
      },
    },
  } as unknown as PrismaClient;

  const catalog = new RecordCatalog(db);
  await expect(
    catalog.setReportFavorite({
      workspaceId: "workspace-1",
      userId: "leader",
      reportId: "assignment-1",
      favorited: true,
    }),
  ).resolves.toEqual({ favorited: true });
  expect(creates).toEqual([{ userId: "leader", reportId: "assignment-1" }]);

  await expect(
    catalog.setReportFavorite({
      workspaceId: "workspace-1",
      userId: "leader",
      reportId: "assignment-1",
      favorited: false,
    }),
  ).resolves.toEqual({ favorited: false });
  expect(deletes).toEqual([{ userId: "leader", reportId: "assignment-1" }]);
});

test("setReportFavorite rejects reports the viewer cannot open", async () => {
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "member" }),
    },
    weeklyReport: {
      findFirst: async () => ({
        id: "assignment-1",
        kind: "member",
        authorId: "member-a",
        sourceTemplate: { authorId: "leader" },
      }),
    },
    weeklyReportFavorite: {
      upsert: async () => {
        throw new Error("should not upsert");
      },
    },
  } as unknown as PrismaClient;

  await expect(
    new RecordCatalog(db).setReportFavorite({
      workspaceId: "workspace-1",
      userId: "outsider",
      reportId: "assignment-1",
      favorited: true,
    }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("saveReportContent with askToSend posts an offer-send assistant card when eligible", async () => {
  const comments: Array<Record<string, unknown>> = [];
  const contentUpdates: Array<Record<string, unknown>> = [];
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "member" }),
    },
    weeklyReport: {
      findFirst: async (query: {
        where?: {
          id?: string;
          settingsId?: string;
          submissions?: { some?: unknown; none?: unknown };
        };
      }) => {
        if (query.where?.submissions?.some) return null;
        if (query.where?.submissions?.none) return { id: "format-1" };
        if (query.where?.id === "format-1" || query.where?.settingsId) {
          return {
            id: "format-1",
            authorId: "leader",
            kind: "template",
            settingsId: "settings-1",
            content: { tabs: { Summary: { markdown: "old" } } },
            cycle: { year: 2026, week: 38 },
            submissions: [],
          };
        }
        return null;
      },
      update: async (query: { data: Record<string, unknown> }) => {
        contentUpdates.push(query.data);
        return {
          id: "format-1",
          status: "draft",
          updatedAt: new Date("2026-09-18T04:00:00.000Z"),
        };
      },
    },
    weeklyReportTemplate: {
      findFirst: async () => ({
        id: "settings-1",
        sendWeekday: 5,
        sendTime: "15:00",
        scheduleEnabled: true,
        applied: true,
      }),
      update: async () => ({}),
    },
    recordComment: {
      create: async (query: { data: Record<string, unknown> }) => {
        comments.push(query.data);
        return { id: `c-${comments.length}` };
      },
    },
  } as unknown as PrismaClient;

  const result = await new RecordCatalog(db).saveReportContent({
    workspaceId: "workspace-1",
    userId: "leader",
    reportId: "format-1",
    content: { tabs: { Summary: { markdown: "new body" } } },
    askToSend: true,
    // Friday 14:30 Shanghai = inside preview hour for 15:00 send
    now: new Date("2026-09-18T06:30:00.000Z"),
  });

  expect(result.assistantPosted).toBe(true);
  expect(result.autoSendJustCancelled).toBe(true);
  expect(comments[0]).toMatchObject({
    authorType: "assistant",
    body: "已取消本周自动发送。保存后请手动发送周报模板。",
  });
  expect(comments[1]).toMatchObject({
    authorType: "assistant",
    payload: { kind: "offer-send" },
  });
  expect(
    (contentUpdates[0]?.content as { schedule?: { cancelledWeek?: number } })?.schedule
      ?.cancelledWeek,
  ).toBe(38);
});

test("saveReportContent autosave does not ask to send", async () => {
  const comments: Array<Record<string, unknown>> = [];
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "member" }),
    },
    weeklyReport: {
      findFirst: async () => ({
        id: "format-1",
        authorId: "leader",
        kind: "template",
        settingsId: "settings-1",
        content: { tabs: { Summary: { markdown: "old" } } },
        cycle: { year: 2026, week: 38 },
        submissions: [],
      }),
      update: async () => ({
        id: "format-1",
        status: "draft",
        updatedAt: new Date("2026-09-18T04:00:00.000Z"),
      }),
    },
    weeklyReportTemplate: {
      findFirst: async () => ({
        id: "settings-1",
        sendWeekday: 5,
        sendTime: "15:00",
        scheduleEnabled: false,
      }),
      update: async () => ({}),
    },
    recordComment: {
      create: async (query: { data: Record<string, unknown> }) => {
        comments.push(query.data);
        return { id: `c-${comments.length}` };
      },
    },
  } as unknown as PrismaClient;

  const result = await new RecordCatalog(db).saveReportContent({
    workspaceId: "workspace-1",
    userId: "leader",
    reportId: "format-1",
    content: { tabs: { Summary: { markdown: "new body" } } },
    now: new Date("2026-09-18T04:00:00.000Z"),
  });

  expect(result.assistantPosted).toBe(false);
  expect(comments).toHaveLength(0);
});

test("loadNavAttention reads every applied stream with two batched queries", async () => {
  // Wednesday 09:30 in Asia/Shanghai: inside the preview hour of a 10:00 send, not of a 15:00 one.
  const now = new Date("2026-09-16T01:30:00Z");
  let findManyCalls = 0;
  const db = {
    workspaceMembership: { findUnique: async () => ({ role: "member" }) },
    weeklyReportTemplate: {
      findMany: async () => [
        { id: "settings-late", sendWeekday: 3, sendTime: "15:00" },
        { id: "settings-soon", sendWeekday: 3, sendTime: "10:00" },
        { id: "settings-sent", sendWeekday: 3, sendTime: "10:00" },
      ],
    },
    weeklyReport: {
      findMany: async (args: { where: { submissions: { some?: unknown; none?: unknown } } }) => {
        findManyCalls += 1;
        return args.where.submissions.some
          ? [{ settingsId: "settings-sent" }]
          : [{ settingsId: "settings-soon", content: null }];
      },
    },
  } as unknown as PrismaClient;

  const result = await new RecordCatalog(db).loadNavAttention({
    workspaceId: "workspace-1",
    userId: "leader",
    now,
  });

  expect(result).toEqual({ preview: true });
  expect(findManyCalls).toBe(2);
});

test("loadNavAttention stays quiet when the only armed stream was already sent", async () => {
  const now = new Date("2026-09-16T01:30:00Z");
  const db = {
    workspaceMembership: { findUnique: async () => ({ role: "member" }) },
    weeklyReportTemplate: {
      findMany: async () => [{ id: "settings-sent", sendWeekday: 3, sendTime: "10:00" }],
    },
    weeklyReport: {
      findMany: async (args: { where: { submissions: { some?: unknown } } }) =>
        args.where.submissions.some ? [{ settingsId: "settings-sent" }] : [],
    },
  } as unknown as PrismaClient;

  const result = await new RecordCatalog(db).loadNavAttention({
    workspaceId: "workspace-1",
    userId: "leader",
    now,
  });

  expect(result).toEqual({ preview: false });
});
