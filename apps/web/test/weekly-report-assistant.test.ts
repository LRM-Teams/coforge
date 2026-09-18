import { expect, test } from "bun:test";
import type { PrismaClient } from "../generated/client";
import { RecordCatalog } from "../src/server/records/record-catalog.server";
import {
  WEEKLY_REPORT_ASSISTANT_DISPLAY_NAME,
  ensureWeeklyReportAssistant,
  weeklyReportAssistantAgentName,
} from "../src/server/records/weekly-report-assistant.server";

test("weekly report assistants keep a fixed display name and User-scoped Agent identity", () => {
  expect(WEEKLY_REPORT_ASSISTANT_DISPLAY_NAME).toBe("周报助手");
  expect(weeklyReportAssistantAgentName("user-a")).toBe("weekly-report-assistant-user-a");
  expect(weeklyReportAssistantAgentName("user-b")).not.toBe(
    weeklyReportAssistantAgentName("user-a"),
  );
});

test("assistant context manifests expose structure without report bodies", async () => {
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "member" }),
    },
    weeklyReport: {
      findFirst: async () => ({
        id: "report-1",
        workspaceId: "workspace-1",
        cycleId: "cycle-1",
        authorId: "user-1",
        sourceTemplateId: null,
        kind: "member",
        title: "Alice 2026 W38",
        status: "submitted",
        content: {
          tabs: {
            Progress: { markdown: "private body must not escape" },
            Plans: { markdown: "next" },
          },
        },
        submittedAt: new Date("2026-09-18T00:00:00.000Z"),
        updatedAt: new Date("2026-09-18T00:00:00.000Z"),
        author: { id: "user-1", username: "alice", displayName: "Alice" },
        cycle: { id: "cycle-1", year: 2026, week: 38, title: "2026 W38" },
        sourceTemplate: null,
        settingsId: null,
      }),
      count: async () => 0,
      findMany: async () => [],
    },
    weeklyReportFavorite: {
      findUnique: async () => null,
    },
  } as unknown as PrismaClient;

  const manifest = await new RecordCatalog(db).loadAssistantContextManifest({
    workspaceId: "workspace-1",
    userId: "user-1",
    subjectType: "report",
    subjectId: "report-1",
  });

  expect(manifest).toEqual({
    subjectType: "report",
    subjectId: "report-1",
    cycle: { id: "cycle-1", year: 2026, week: 38, title: "2026 W38" },
    status: "submitted",
    structure: ["Progress", "Plans"],
    availableData: [
      "current_report",
      "template",
      "submission_status",
      "visible_member_reports",
      "favorites",
    ],
    contextVersion: "2026-09-18T00:00:00.000Z",
  });
  expect(JSON.stringify(manifest)).not.toContain("private body");
});

test("assistant report lists are visible-only and cursor bounded", async () => {
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "member" }),
    },
    weeklyReport: {
      findMany: async (query: { take: number }) =>
        Array.from({ length: query.take }, (_, index) => ({
          id: `report-${index}`,
          cycleId: "cycle-1",
          authorId: "user-2",
          title: `Report ${index}`,
          status: "submitted",
          submittedAt: new Date("2026-09-18T00:00:00.000Z"),
          updatedAt: new Date(`2026-09-${18 - index}T00:00:00.000Z`),
          author: { username: "alice", displayName: "Alice" },
          cycle: { year: 2026, week: 38, title: "2026 W38" },
        })),
    },
  } as unknown as PrismaClient;

  const result = await new RecordCatalog(db).listAssistantVisibleReports({
    workspaceId: "workspace-1",
    userId: "user-1",
    limit: 2,
  });

  expect(result.reports).toHaveLength(2);
  expect(result.reports[0]).toMatchObject({
    id: "report-0",
    author: { displayName: "Alice" },
    source: { kind: "weekly_report", reportId: "report-0", userId: "user-2" },
  });
  expect(result.nextCursor).toBe("report-1");
});

test("assistant report reads are section-scoped, bounded, and source-backed", async () => {
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "member" }),
    },
    weeklyReportFavorite: {
      findUnique: async () => null,
    },
    weeklyReport: {
      findFirst: async () => ({
        id: "report-1",
        workspaceId: "workspace-1",
        cycleId: "cycle-1",
        authorId: "user-1",
        sourceTemplateId: null,
        kind: "member",
        title: "Alice 2026 W38",
        status: "submitted",
        content: {
          tabs: {
            Summary: { markdown: "0123456789ABCDEFGHIJ" },
          },
        },
        submittedAt: new Date("2026-09-18T00:00:00.000Z"),
        updatedAt: new Date("2026-09-18T00:00:00.000Z"),
        author: { id: "user-1", username: "alice", displayName: "Alice" },
        cycle: { id: "cycle-1", year: 2026, week: 38, title: "2026 W38" },
        sourceTemplate: null,
      }),
    },
  } as unknown as PrismaClient;

  const result = await new RecordCatalog(db).readAssistantReportSection({
    workspaceId: "workspace-1",
    userId: "user-1",
    reportId: "report-1",
    section: "Summary",
    maxCharacters: 10,
  });

  expect(result).toEqual({
    reportId: "report-1",
    section: "Summary",
    markdown: "0123456789",
    truncated: true,
    source: {
      kind: "weekly_report",
      reportId: "report-1",
      userId: "user-1",
      displayName: "Alice",
      cycle: { id: "cycle-1", year: 2026, week: 38, title: "2026 W38" },
    },
  });
});

test("ensureWeeklyReportAssistant creates one assistant per User in a Workspace", async () => {
  const assistants: Array<{
    id: string;
    workspaceId: string;
    userId: string;
    agentId: string;
    createdAt: Date;
    updatedAt: Date;
  }> = [];
  const agents: Array<Record<string, unknown>> = [];
  let agentSequence = 0;
  const tx = {
    weeklyReportAssistant: {
      findUnique: async ({
        where,
      }: {
        where: { workspaceId_userId: { workspaceId: string; userId: string } };
      }) =>
        assistants.find(
          (assistant) =>
            assistant.workspaceId === where.workspaceId_userId.workspaceId &&
            assistant.userId === where.workspaceId_userId.userId,
        ) ?? null,
      create: async ({
        data,
      }: {
        data: { workspaceId: string; userId: string; agentId: string };
      }) => {
        const record = {
          id: `assistant-${assistants.length + 1}`,
          workspaceId: data.workspaceId,
          userId: data.userId,
          agentId: data.agentId,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        };
        assistants.push(record);
        return record;
      },
    },
    agent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const agent = { ...data, id: `agent-${++agentSequence}` };
        agents.push(agent);
        return agent;
      },
      findMany: async () => agents.map((agent) => ({ id: agent.id })),
    },
    conversation: {
      createMany: async () => ({ count: 1 }),
      findUniqueOrThrow: async () => ({ id: "general-1" }),
    },
    workspaceMembership: {
      findMany: async () => [],
    },
    conversationMember: {
      createMany: async () => ({ count: 0 }),
    },
    message: {
      findFirst: async () => undefined,
    },
  };
  const db = {
    $transaction: async <T>(callback: (transaction: typeof tx) => Promise<T>) => callback(tx),
  };

  const first = await ensureWeeklyReportAssistant(db as never, {
    workspaceId: "workspace-1",
    userId: "user-1",
  });
  const second = await ensureWeeklyReportAssistant(db as never, {
    workspaceId: "workspace-1",
    userId: "user-1",
  });
  const otherUser = await ensureWeeklyReportAssistant(db as never, {
    workspaceId: "workspace-1",
    userId: "user-2",
  });

  expect(second).toBe(first);
  expect(otherUser.agentId).not.toBe(first.agentId);
  expect(agents).toHaveLength(2);
  expect(agents[0]).toMatchObject({
    workspaceId: "workspace-1",
    ownerId: "user-1",
    name: weeklyReportAssistantAgentName("user-1"),
    displayName: WEEKLY_REPORT_ASSISTANT_DISPLAY_NAME,
    runtimeConfig: {
      runtime: "coforge",
      provider: { kind: "default" },
      model: "",
      modelProvider: "",
      reasoning: "",
    },
  });
});
