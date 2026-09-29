import { expect, test } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";
import { WeeklyReportWorkflow } from "#src/server/records/weekly-report-workflow.server";

test("template discovery distinguishes reusable workspace formats from owned settings", async () => {
  let query: unknown;
  const db = {
    workspaceMembership: { findUnique: async () => ({ role: "member" }) },
    weeklyReportTemplate: {
      findMany: async (input: unknown) => {
        query = input;
        return [
          {
            id: "format",
            name: "Foundation Models Weekly",
            dimensions: [{ title: "Summary", children: ["Next steps"] }],
            ownerId: "owner",
            owner: { displayName: "Owner", username: "owner" },
            updatedAt: new Date("2026-09-29T00:00:00Z"),
            recipients: [],
          },
        ];
      },
    },
  } as unknown as PrismaClient;
  const result = await new WeeklyReportWorkflow(db).execute(
    { workspaceId: "workspace", userId: "owner" },
    { type: "templates" },
  );
  expect(result).toMatchObject({
    templates: [
      {
        id: "format",
        name: "Foundation Models Weekly",
        sections: [{ title: "Summary", children: ["Next steps"] }],
      },
    ],
    nextCursor: null,
  });
  expect(query).toMatchObject({ where: { workspaceId: "workspace" } });
});

test("a removed workspace member cannot discover templates", async () => {
  const db = { workspaceMembership: { findUnique: async () => null } } as unknown as PrismaClient;
  await expect(
    new WeeklyReportWorkflow(db).execute(
      { workspaceId: "workspace", userId: "owner" },
      { type: "templates" },
    ),
  ).rejects.toThrow();
});

test("page context and DM expose the same formats without other owners' delivery settings", async () => {
  const { RecordCatalog } = await import("#src/server/records/record-catalog.server");
  const db = {
    workspaceMembership: { findUnique: async () => ({ role: "member" }) },
    weeklyReportCycle: {
      findFirst: async () => ({
        id: "cycle",
        year: 2026,
        week: 40,
        title: "Week",
        createdAt: new Date(),
        _count: { reports: 0 },
      }),
    },
    weeklyReportTemplate: {
      findMany: async () => [
        {
          id: "foreign-format",
          name: "Research",
          dimensions: [{ title: "Summary", children: [] }],
          ownerId: "another-owner",
          owner: { displayName: "Another owner", username: "other" },
          updatedAt: new Date("2026-09-29T00:00:00Z"),
          applied: true,
          scheduleEnabled: true,
          sendTime: "15:00",
          sendWeekday: 5,
          allMembers: false,
          recipients: [{ userId: "private-recipient" }],
        },
      ],
    },
  } as unknown as PrismaClient;
  const actor = { workspaceId: "workspace", userId: "owner" };
  const result = (await new WeeklyReportWorkflow(db).execute(actor, { type: "templates" })) as {
    templates: unknown[];
  };
  const context = await new RecordCatalog(db).loadAssistantContextManifest({
    ...actor,
    subjectType: "cycle",
    subjectId: "cycle",
  });
  expect(result.templates).toEqual(context.templateFormats);
  expect(result.templates).toEqual([
    expect.objectContaining({ id: "foreign-format", canManage: false, owner: "Another owner" }),
  ]);
  expect(result.templates[0]).not.toHaveProperty("recipientUserIds");
  expect(result.templates[0]).not.toHaveProperty("sendTime");
});
