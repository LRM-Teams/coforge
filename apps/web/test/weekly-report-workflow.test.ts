import { expect, test } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";
import { WeeklyReportWorkflow } from "#src/server/records/weekly-report-workflow.server";

test("template discovery works before any cycle and is scoped to the assistant owner's settings", async () => {
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
  expect(query).toMatchObject({ where: { workspaceId: "workspace", ownerId: "owner" } });
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
