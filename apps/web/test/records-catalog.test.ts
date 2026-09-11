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
