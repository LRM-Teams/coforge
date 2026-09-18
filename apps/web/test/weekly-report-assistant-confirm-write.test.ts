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
