import { expect, test } from "bun:test";
import type { PrismaClient } from "../generated/client";
import { RecordCatalog } from "../src/server/records/record-catalog.server";

test("applyConfirmedReportBody writes only after the author confirms a suggestion", async () => {
  const updates: Array<Record<string, unknown>> = [];
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "member" }),
    },
    weeklyReport: {
      findFirst: async () => ({
        id: "11111111-1111-1111-1111-111111111111",
        authorId: "user-1",
        kind: "member",
        settingsId: null,
        content: { tabs: { Progress: { markdown: "- old\n" } } },
        cycle: { year: 2026, week: 38 },
        submissions: [],
      }),
      update: async (query: { data: Record<string, unknown> }) => {
        updates.push(query.data);
        return {
          id: "11111111-1111-1111-1111-111111111111",
          status: "draft",
          updatedAt: new Date("2026-09-16T12:00:00.000Z"),
        };
      },
    },
  } as unknown as PrismaClient;

  const result = await new RecordCatalog(db).applyConfirmedReportBody({
    workspaceId: "workspace-1",
    userId: "user-1",
    reportId: "11111111-1111-1111-1111-111111111111",
    content: { tabs: { Progress: { markdown: "- shipped assistant confirms\n" } } },
  });

  expect(result.id).toBe("11111111-1111-1111-1111-111111111111");
  expect(updates[0]).toMatchObject({
    content: { tabs: { Progress: { markdown: "- shipped assistant confirms\n" } } },
  });
});

test("applyConfirmedHighlight upserts cycle highlights from a confirmed suggestion", async () => {
  let created: Record<string, unknown> | undefined;
  let updated: Record<string, unknown> | undefined;
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "owner" }),
    },
    weeklyReportCycle: {
      findFirst: async () => ({
        id: "22222222-2222-2222-2222-222222222222",
        year: 2026,
        week: 38,
        title: "2026 W38",
      }),
    },
    weeklyReportHighlight: {
      findUnique: async () => null,
      findFirst: async () => null,
      create: async (query: { data: Record<string, unknown> }) => {
        created = query.data;
        return {
          id: "33333333-3333-3333-3333-333333333333",
          completedAt: query.data.completedAt ?? null,
          updatedAt: new Date("2026-09-16T12:00:00.000Z"),
        };
      },
      update: async (query: { data: Record<string, unknown> }) => {
        updated = query.data;
        return {
          id: "33333333-3333-3333-3333-333333333333",
          completedAt: query.data.completedAt ?? null,
          updatedAt: new Date("2026-09-16T12:00:00.000Z"),
        };
      },
    },
  } as unknown as PrismaClient;

  const result = await new RecordCatalog(db).applyConfirmedHighlight({
    workspaceId: "workspace-1",
    userId: "user-1",
    cycleId: "22222222-2222-2222-2222-222222222222",
    content: {
      blocks: [
        {
          id: "progress",
          heading: "一、本周进展",
          paragraphs: [],
          items: [{ text: "Confirmed highlight", sources: [] }],
        },
      ],
    },
    markCompleted: true,
  });

  expect(result.highlightId).toBe("33333333-3333-3333-3333-333333333333");
  expect(created).toMatchObject({
    workspaceId: "workspace-1",
    cycleId: "22222222-2222-2222-2222-222222222222",
    content: {
      blocks: [
        {
          id: "progress",
          items: [{ text: "Confirmed highlight", sources: [] }],
        },
      ],
    },
  });
  expect(created?.completedAt).toBeInstanceOf(Date);
  expect(updated).toBeUndefined();
});
