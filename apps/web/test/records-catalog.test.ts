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
      findFirst: async (query: { where?: { id?: string; ownerId?: string } }) => {
        if (query.where?.id === "settings-2" && !query.where?.ownerId) {
          return { id: "settings-2", dimensions: [] };
        }
        return { id: "settings-2", applied: false };
      },
      updateMany: async (query: { where: object; data: object }) => {
        ops.push(`updateMany:${JSON.stringify(query)}`);
        return { count: 1 };
      },
      update: async (query: { where: object; data: object }) => {
        ops.push(`update:${JSON.stringify(query)}`);
        return {};
      },
    },
    weeklyReport: {
      findFirst: async () => ({ id: "existing-format" }),
    },
  } as unknown as PrismaClient;

  const result = await new RecordCatalog(db).applyTemplate({
    workspaceId: "workspace-1",
    userId: "leader",
    templateId: "settings-2",
  });

  expect(result).toEqual({ id: "settings-2", active: true });
  expect(ops).toEqual([
    'updateMany:{"where":{"workspaceId":"workspace-1","ownerId":"leader","applied":true},"data":{"applied":false}}',
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
          workspaceId: "workspace-1",
          ownerId: "leader",
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
        title: "Alice的周报 · W38",
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
        title: "Alice的周报 · W38",
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
          highlight: null,
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
              title: "Alice的周报 · W38",
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
              title: "B的周报 · W38",
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
      findFirst: async (query: { where?: { ownerId?: string } }) => {
        expect(query.where?.ownerId).toBe("leader-b");
        return null;
      },
    },
  } as unknown as PrismaClient;

  const catalog = await new RecordCatalog(db).loadCatalog({
    workspaceId: "workspace-1",
    userId: "leader-b",
  });

  expect(catalog.memberTemplates.map((row) => row.id)).toEqual(["leader-b-overview"]);
  expect(catalog.memberTemplates.map((row) => row.id)).not.toContain("leader-a-format");
  expect(catalog.currentWeekTemplate).toMatchObject({
    id: null,
    interactive: false,
    sendArmed: false,
  });
  expect(catalog.myReports.map((row) => row.id)).toEqual(["mine"]);
});

test("loadCatalog creates a personal format when send settings are applied", async () => {
  const created: Array<Record<string, unknown>> = [];
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
      findFirst: async () => ({
        sendWeekday: 5,
        sendTime: "15:00",
        scheduleEnabled: false,
      }),
    },
    weeklyReport: {
      findFirst: async () => null,
      create: async (query: { data: Record<string, unknown> }) => {
        created.push(query.data);
        return { id: "format-new" };
      },
    },
  } as unknown as PrismaClient;

  const catalog = await new RecordCatalog(db).loadCatalog({
    workspaceId: "workspace-1",
    userId: "leader-b",
  });

  expect(catalog.currentWeekTemplate).toMatchObject({
    id: "format-new",
    interactive: true,
  });
  expect(created[0]).toMatchObject({
    kind: "template",
    authorId: "leader-b",
    title: "2026 W38 周报模板",
  });
});

test("applyTemplate ensures a personal format when activating settings", async () => {
  const created: Array<Record<string, unknown>> = [];
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "member" }),
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
    weeklyReportTemplate: {
      findFirst: async (query: { where?: { id?: string; ownerId?: string } }) => {
        if (query.where?.id === "settings-b" && !query.where?.ownerId) {
          return {
            id: "settings-b",
            dimensions: [{ title: "Summary", children: ["Current Works"] }],
          };
        }
        return { id: "settings-b", applied: false };
      },
      updateMany: async () => ({ count: 0 }),
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
  });
  expect((created[0]?.content as { tabs?: { Summary?: { markdown?: string } } })?.tabs?.Summary?.markdown).toContain(
    "# Summary",
  );
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
        title: "Alice的周报 · W38",
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
            title: "Alice的周报 · W38",
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

test("applyTemplate clears only the same owner's other applied rows", async () => {
  const ops: string[] = [];
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "member" }),
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
    weeklyReportTemplate: {
      findFirst: async (query: { where?: { ownerId?: string; id?: string } }) => {
        if (query.where?.id === "settings-b" && !query.where?.ownerId) {
          return { id: "settings-b", dimensions: [] };
        }
        expect(query.where?.ownerId).toBe("leader-b");
        return { id: "settings-b", applied: false };
      },
      updateMany: async (query: { where: object; data: object }) => {
        ops.push(`updateMany:${JSON.stringify(query)}`);
        return { count: 1 };
      },
      update: async (query: { where: object; data: object }) => {
        ops.push(`update:${JSON.stringify(query)}`);
        return {};
      },
    },
    weeklyReport: {
      findFirst: async () => ({ id: "existing-format" }),
    },
  } as unknown as PrismaClient;

  await new RecordCatalog(db).applyTemplate({
    workspaceId: "workspace-1",
    userId: "leader-b",
    templateId: "settings-b",
  });

  expect(ops[0]).toContain('"ownerId":"leader-b"');
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
        submissions: [],
      }),
      update: async () => ({
        id: "format-1",
        status: "draft",
        updatedAt: new Date("2026-09-14T10:00:00.000Z"),
      }),
    },
    weeklyReportTemplate: {
      findFirst: async () => ({ id: "settings-1" }),
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
