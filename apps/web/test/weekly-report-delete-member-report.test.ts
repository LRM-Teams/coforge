import { expect, test } from "bun:test";
import type { PrismaClient } from "@/generated/prisma/client";
import { RecordCatalog } from "@/server/records/record-catalog.server";

test("deleteMemberReport hides a sent submission from the author and keeps the leader copy", async () => {
  const deleted: string[] = [];
  const updates: Array<{ id: string; hiddenFromAuthor?: boolean }> = [];
  const report = {
    id: "sent-1",
    workspaceId: "ws-1",
    kind: "member",
    authorId: "member-1",
    status: "submitted",
    hiddenFromAuthor: false,
    sourceTemplateId: "overview-1",
  };

  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "member" }),
    },
    weeklyReport: {
      findFirst: async () => report,
      delete: async ({ where }: { where: { id: string } }) => {
        deleted.push(where.id);
        return report;
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: { hiddenFromAuthor?: boolean };
      }) => {
        updates.push({ id: where.id, ...data });
        report.hiddenFromAuthor = data.hiddenFromAuthor === true;
        return report;
      },
    },
  } as unknown as PrismaClient;

  const result = await new RecordCatalog(db).deleteMemberReport({
    workspaceId: "ws-1",
    userId: "member-1",
    reportId: "sent-1",
  });

  expect(result).toEqual({ ok: true });
  expect(deleted).toEqual([]);
  expect(updates).toEqual([{ id: "sent-1", hiddenFromAuthor: true }]);
  expect(report.hiddenFromAuthor).toBe(true);
  expect(report.sourceTemplateId).toBe("overview-1");
});

test("loadCatalog omits an author-hidden submission from 我的周报 and keeps it on the leader week", async () => {
  const cycles = [
    {
      id: "cycle-1",
      year: 2026,
      week: 39,
      title: "2026 W39 工作周报",
      reports: [
        {
          id: "overview-1",
          kind: "template",
          authorId: "leader-1",
          title: "2026 W39 工作周报",
          status: "draft",
          content: { tabs: { Summary: { markdown: "" } } },
          sourceTemplateId: null,
          settingsId: null,
          hiddenFromAuthor: false,
          createdAt: new Date("2026-09-21T01:00:00.000Z"),
          author: { id: "leader-1", username: "leader", displayName: "Leader" },
        },
        {
          id: "sent-1",
          kind: "member",
          authorId: "member-1",
          title: "Member 2026 W39 工作周报",
          status: "submitted",
          content: { tabs: { Summary: { markdown: "Done" } } },
          sourceTemplateId: "overview-1",
          hiddenFromAuthor: true,
          createdAt: new Date("2026-09-21T02:00:00.000Z"),
          author: { id: "member-1", username: "member", displayName: "Member" },
        },
      ],
    },
  ];
  const db = {
    workspaceMembership: { findUnique: async () => ({ role: "member" }) },
    weeklyReportCycle: { findMany: async () => cycles },
    weeklyReportFavorite: {
      findMany: async ({ where }: { where: { userId: string } }) =>
        [
          {
            report: {
              id: "sent-1",
              authorId: "member-1",
              hiddenFromAuthor: true,
              author: { id: "member-1", username: "member", displayName: "Member" },
              cycle: { year: 2026, week: 39 },
            },
            createdAt: new Date("2026-09-21T03:00:00.000Z"),
          },
        ].filter(() => where.userId === "member-1" || where.userId === "leader-1"),
    },
    recordNote: { findMany: async () => [] },
    user: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === "leader-1"
          ? { id: "leader-1", username: "leader", displayName: "Leader" }
          : { id: "member-1", username: "member", displayName: "Member" },
    },
    weeklyReportTemplate: { findMany: async () => [] },
  } as unknown as PrismaClient;

  const authorCatalog = await new RecordCatalog(db).loadCatalog({
    workspaceId: "ws-1",
    userId: "member-1",
  });
  const leaderCatalog = await new RecordCatalog(db).loadCatalog({
    workspaceId: "ws-1",
    userId: "leader-1",
  });

  expect(authorCatalog.myReports.map((row) => row.id)).toEqual([]);
  expect(authorCatalog.favorites.map((row) => row.id)).toEqual([]);
  expect(leaderCatalog.memberWeeks[0]?.submissions.map((row) => row.id)).toEqual(["sent-1"]);
  expect(leaderCatalog.favorites.map((row) => row.id)).toEqual(["sent-1"]);
});

test("deleteMemberReport still removes a draft that was never sent", async () => {
  const deleted: string[] = [];
  const db = {
    workspaceMembership: { findUnique: async () => ({ role: "member" }) },
    weeklyReport: {
      findFirst: async () => ({
        id: "draft-1",
        status: "draft",
        kind: "member",
        authorId: "member-1",
      }),
      delete: async ({ where }: { where: { id: string } }) => {
        deleted.push(where.id);
        return { id: where.id };
      },
      update: async () => {
        throw new Error("a draft has no leader copy to keep");
      },
    },
  } as unknown as PrismaClient;

  const result = await new RecordCatalog(db).deleteMemberReport({
    workspaceId: "ws-1",
    userId: "member-1",
    reportId: "draft-1",
  });

  expect(result).toEqual({ ok: true });
  expect(deleted).toEqual(["draft-1"]);
});

test("getSubject hides a sent report from its author and still opens it for the leader", async () => {
  const report = {
    id: "sent-1",
    workspaceId: "ws-1",
    kind: "member",
    status: "submitted",
    hiddenFromAuthor: true,
    title: "Member 2026 W39 工作周报",
    content: { tabs: { Summary: { markdown: "Done" } } },
    submittedAt: new Date("2026-09-21T02:00:00.000Z"),
    updatedAt: new Date("2026-09-21T02:00:00.000Z"),
    sourceTemplateId: "overview-1",
    author: { id: "member-1", username: "member", displayName: "Member", avatarObjectKey: null },
    cycle: { id: "cycle-1", year: 2026, week: 39, title: "2026 W39 工作周报" },
    sourceTemplate: {
      authorId: "leader-1",
      author: { id: "leader-1", username: "leader", displayName: "Leader", avatarObjectKey: null },
    },
  };
  const db = {
    workspaceMembership: { findUnique: async () => ({ role: "member" }) },
    weeklyReport: { findFirst: async () => report },
    weeklyReportFavorite: { findUnique: async () => null },
  } as unknown as PrismaClient;
  const catalog = new RecordCatalog(db);

  await expect(
    catalog.getSubject({ workspaceId: "ws-1", userId: "member-1", id: "sent-1" }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });

  const leader = await catalog.getSubject({
    workspaceId: "ws-1",
    userId: "leader-1",
    id: "sent-1",
  });
  expect(leader.type).toBe("report");
  if (leader.type !== "report") return;
  expect(leader.report.id).toBe("sent-1");
  expect(leader.report.content).toEqual({ tabs: { Summary: { markdown: "Done" } } });
});

test("saveReportContent refuses to change a submission the author already removed", async () => {
  let updated = false;
  const db = {
    workspaceMembership: { findUnique: async () => ({ role: "member" }) },
    weeklyReport: {
      findFirst: async () => ({
        id: "sent-1",
        authorId: "member-1",
        kind: "member",
        status: "submitted",
        hiddenFromAuthor: true,
        settingsId: null,
        content: { tabs: { Summary: { markdown: "Done" } } },
        cycle: { year: 2026, week: 39 },
        submissions: [],
      }),
      update: async () => {
        updated = true;
        return { id: "sent-1" };
      },
    },
  } as unknown as PrismaClient;

  await expect(
    new RecordCatalog(db).saveReportContent({
      workspaceId: "ws-1",
      userId: "member-1",
      reportId: "sent-1",
      content: { tabs: { Summary: { markdown: "Changed" } } },
    }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(updated).toBe(false);
});
