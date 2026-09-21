import { expect, test } from "bun:test";
import type { PrismaClient } from "../generated/client";
import { RecordCatalog } from "../src/server/records/record-catalog.server";

test("deleteMemberWeek removes the viewer's templates and submissions only", async () => {
  const deletedReports: string[] = [];
  let deletedCycleId: string | null = null;

  const reports = [
    {
      id: "tpl-mine",
      workspaceId: "ws-1",
      cycleId: "cycle-1",
      kind: "template",
      authorId: "user-1",
    },
    {
      id: "member-under-mine",
      workspaceId: "ws-1",
      cycleId: "cycle-1",
      kind: "member",
      authorId: "user-2",
      sourceTemplateId: "tpl-mine",
    },
    {
      id: "tpl-other",
      workspaceId: "ws-1",
      cycleId: "cycle-1",
      kind: "template",
      authorId: "user-9",
    },
    {
      id: "member-under-other",
      workspaceId: "ws-1",
      cycleId: "cycle-1",
      kind: "member",
      authorId: "user-3",
      sourceTemplateId: "tpl-other",
    },
  ];

  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "member" }),
    },
    weeklyReportCycle: {
      findFirst: async () => ({ id: "cycle-1", workspaceId: "ws-1" }),
      delete: async ({ where }: { where: { id: string } }) => {
        deletedCycleId = where.id;
        return { id: where.id };
      },
    },
    weeklyReport: {
      findMany: async ({
        where,
      }: {
        where: {
          workspaceId: string;
          cycleId: string;
          kind?: string;
          authorId?: string;
          sourceTemplateId?: { in: string[] };
        };
      }) =>
        reports.filter((row) => {
          if (row.workspaceId !== where.workspaceId || row.cycleId !== where.cycleId) return false;
          if (where.kind && row.kind !== where.kind) return false;
          if (where.authorId && row.authorId !== where.authorId) return false;
          if (where.sourceTemplateId?.in) {
            return (
              row.kind === "member" &&
              where.sourceTemplateId.in.includes(row.sourceTemplateId ?? "")
            );
          }
          return true;
        }),
      deleteMany: async ({
        where,
      }: {
        where: { id?: { in: string[] }; workspaceId?: string; cycleId?: string };
      }) => {
        const ids = where.id?.in ?? [];
        for (const id of ids) deletedReports.push(id);
        return { count: ids.length };
      },
      count: async ({ where }: { where: { workspaceId: string; cycleId: string } }) =>
        reports.filter(
          (row) =>
            row.workspaceId === where.workspaceId &&
            row.cycleId === where.cycleId &&
            !deletedReports.includes(row.id),
        ).length,
    },
    $transaction: async (fn: (tx: typeof db) => Promise<unknown>) => fn(db),
  } as unknown as PrismaClient;

  const result = await new RecordCatalog(db).deleteMemberWeek({
    workspaceId: "ws-1",
    userId: "user-1",
    cycleId: "cycle-1",
  });

  expect(result).toEqual({ ok: true });
  expect(deletedReports.sort()).toEqual(["member-under-mine", "tpl-mine"].sort());
  expect(deletedReports).not.toContain("tpl-other");
  expect(deletedReports).not.toContain("member-under-other");
  // Other leaders still have reports → cycle row stays.
  expect(deletedCycleId).toBeNull();
});

test("deleteMemberWeek removes cycle when the viewer owned the only reports", async () => {
  const deletedReports: string[] = [];
  const deletedCycles: string[] = [];

  const reports = [
    {
      id: "tpl-mine",
      workspaceId: "ws-1",
      cycleId: "cycle-1",
      kind: "template",
      authorId: "user-1",
    },
    {
      id: "member-under-mine",
      workspaceId: "ws-1",
      cycleId: "cycle-1",
      kind: "member",
      authorId: "user-2",
      sourceTemplateId: "tpl-mine",
    },
  ];

  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "member" }),
    },
    weeklyReportCycle: {
      findFirst: async () => ({ id: "cycle-1", workspaceId: "ws-1" }),
      delete: async ({ where }: { where: { id: string } }) => {
        deletedCycles.push(where.id);
        return { id: where.id };
      },
    },
    weeklyReport: {
      findMany: async ({
        where,
      }: {
        where: {
          workspaceId: string;
          cycleId: string;
          kind?: string;
          authorId?: string;
          sourceTemplateId?: { in: string[] };
        };
      }) =>
        reports.filter((row) => {
          if (row.workspaceId !== where.workspaceId || row.cycleId !== where.cycleId) return false;
          if (where.kind && row.kind !== where.kind) return false;
          if (where.authorId && row.authorId !== where.authorId) return false;
          if (where.sourceTemplateId?.in) {
            return (
              row.kind === "member" &&
              where.sourceTemplateId.in.includes(row.sourceTemplateId ?? "")
            );
          }
          return true;
        }),
      deleteMany: async ({ where }: { where: { id?: { in: string[] } } }) => {
        const ids = where.id?.in ?? [];
        for (const id of ids) deletedReports.push(id);
        return { count: ids.length };
      },
      count: async ({ where }: { where: { workspaceId: string; cycleId: string } }) =>
        reports.filter(
          (row) =>
            row.workspaceId === where.workspaceId &&
            row.cycleId === where.cycleId &&
            !deletedReports.includes(row.id),
        ).length,
    },
    $transaction: async (fn: (tx: typeof db) => Promise<unknown>) => fn(db),
  } as unknown as PrismaClient;

  const result = await new RecordCatalog(db).deleteMemberWeek({
    workspaceId: "ws-1",
    userId: "user-1",
    cycleId: "cycle-1",
  });

  expect(result).toEqual({ ok: true });
  expect(deletedReports.sort()).toEqual(["member-under-mine", "tpl-mine"].sort());
  expect(deletedCycles).toEqual(["cycle-1"]);
});

test("deleteOverviewReport drops the leader week node but keeps member reports and favorites", async () => {
  const deletedReports: string[] = [];
  const unlinked: string[] = [];
  const reports: Array<{
    id: string;
    workspaceId: string;
    cycleId: string;
    kind: string;
    authorId: string;
    sourceTemplateId?: string | null;
  }> = [
    {
      id: "overview-1",
      workspaceId: "ws-1",
      cycleId: "cycle-1",
      kind: "template",
      authorId: "user-1",
    },
    {
      id: "format-1",
      workspaceId: "ws-1",
      cycleId: "cycle-1",
      kind: "template",
      authorId: "user-1",
    },
    {
      id: "kept-favorite",
      workspaceId: "ws-1",
      cycleId: "cycle-1",
      kind: "member",
      authorId: "user-2",
      sourceTemplateId: "overview-1",
    },
    {
      id: "removed-child",
      workspaceId: "ws-1",
      cycleId: "cycle-1",
      kind: "member",
      authorId: "user-3",
      sourceTemplateId: "overview-1",
    },
  ];

  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "member" }),
    },
    weeklyReport: {
      findFirst: async () => reports.find((row) => row.id === "overview-1"),
      findMany: async () =>
        reports.filter((row) => row.kind === "member" && row.sourceTemplateId === "overview-1"),
      updateMany: async ({
        where,
        data,
      }: {
        where: { sourceTemplateId?: string; kind?: string };
        data: { sourceTemplateId: null };
      }) => {
        const matched = reports.filter(
          (row) =>
            row.kind === where.kind &&
            "sourceTemplateId" in row &&
            row.sourceTemplateId === where.sourceTemplateId,
        );
        for (const row of matched) {
          if ("sourceTemplateId" in row) row.sourceTemplateId = data.sourceTemplateId;
          unlinked.push(row.id);
        }
        return { count: matched.length };
      },
      deleteMany: async ({ where }: { where: { id?: { in: string[] } } }) => {
        for (const id of where.id?.in ?? []) deletedReports.push(id);
        return { count: where.id?.in.length ?? 0 };
      },
      count: async () => reports.filter((row) => !deletedReports.includes(row.id)).length,
    },
    weeklyReportFavorite: {
      findMany: async () => [{ reportId: "kept-favorite" }],
    },
    weeklyReportCycle: {
      delete: async () => {
        throw new Error("cycle must stay while a favorited report remains");
      },
    },
    $transaction: async (fn: (tx: typeof db) => Promise<unknown>) => fn(db),
  } as unknown as PrismaClient;

  const result = await new RecordCatalog(db).deleteOverviewReport({
    workspaceId: "ws-1",
    userId: "user-1",
    reportId: "overview-1",
  });

  expect(result).toEqual({ ok: true });
  expect(deletedReports).toEqual(["overview-1"]);
  expect(unlinked.sort()).toEqual(["kept-favorite", "removed-child"].sort());
  expect(deletedReports).not.toContain("kept-favorite");
  expect(deletedReports).not.toContain("removed-child");
  expect(deletedReports).not.toContain("format-1");
});

test("deleteMemberWeek refuses a cycle where the viewer owns no template parent", async () => {
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "member" }),
    },
    weeklyReportCycle: {
      findFirst: async () => ({ id: "cycle-1", workspaceId: "ws-1" }),
    },
    weeklyReport: {
      findMany: async () => [],
    },
  } as unknown as PrismaClient;

  await expect(
    new RecordCatalog(db).deleteMemberWeek({
      workspaceId: "ws-1",
      userId: "user-1",
      cycleId: "cycle-1",
    }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});
