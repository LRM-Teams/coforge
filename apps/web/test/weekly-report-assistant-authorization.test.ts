import { expect, test } from "bun:test";
import type { PrismaClient } from "@/generated/prisma/client";
import { AppError } from "@/lib/app-error";
import { RecordCatalog } from "@/server/records/record-catalog.server";
import { PrismaAgentRepository } from "@/server/db/repositories/agent.repositories.server";
import {
  decodeWeeklyReportRequest,
  validateWeeklyReportRequest,
  WEEKLY_REPORT_PROTOCOL_MAJOR,
} from "@lrm/coforge-sdk/internal";
import { parseWeeklyReportAssistantSuggestion } from "@/server/records/weekly-report-assistant-suggestion.server";

test("assistant section reads deny member reports the User cannot see", async () => {
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "member" }),
    },
    weeklyReport: {
      findFirst: async () => ({
        id: "report-other",
        workspaceId: "workspace-1",
        cycleId: "cycle-1",
        authorId: "user-2",
        sourceTemplateId: "template-1",
        kind: "member",
        title: "Bob 2026 W38",
        status: "submitted",
        content: { tabs: { Progress: { markdown: "secret" } } },
        submittedAt: new Date("2026-09-18T00:00:00.000Z"),
        updatedAt: new Date("2026-09-18T00:00:00.000Z"),
        author: { id: "user-2", username: "bob", displayName: "Bob" },
        cycle: { id: "cycle-1", year: 2026, week: 38, title: "2026 W38" },
        sourceTemplate: {
          authorId: "leader-1",
          author: { id: "leader-1", username: "boss", displayName: "Boss" },
        },
      }),
    },
    weeklyReportFavorite: {
      findUnique: async () => null,
    },
  } as unknown as PrismaClient;

  await expect(
    new RecordCatalog(db).readAssistantReportSection({
      workspaceId: "workspace-1",
      userId: "user-1",
      reportId: "report-other",
      section: "Progress",
    }),
  ).rejects.toEqual(new AppError("NOT_FOUND"));
});

test("assistant visible report lists only query author or template-owner visibility", async () => {
  let where: Record<string, unknown> | undefined;
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "member" }),
    },
    weeklyReport: {
      findMany: async (query: { where: Record<string, unknown> }) => {
        where = query.where;
        return [];
      },
    },
  } as unknown as PrismaClient;

  await new RecordCatalog(db).listAssistantVisibleReports({
    workspaceId: "workspace-1",
    userId: "user-1",
    limit: 10,
  });

  expect(where).toMatchObject({
    workspaceId: "workspace-1",
    kind: "member",
    status: { in: ["submitted", "shared"] },
    OR: [{ authorId: "user-1" }, { sourceTemplate: { authorId: "user-1" } }],
  });
});

test("confirmed body writes stay author-only and never ask the assistant to send", async () => {
  let updated = false;
  const db = {
    workspaceMembership: {
      findUnique: async () => ({ role: "member" }),
    },
    weeklyReport: {
      findFirst: async () => ({
        id: "11111111-1111-1111-1111-111111111111",
        authorId: "author-1",
        kind: "member",
        settingsId: null,
        content: { tabs: { Progress: { markdown: "- old\n" } } },
        cycle: { year: 2026, week: 38 },
        submissions: [],
      }),
      update: async () => {
        updated = true;
        return {
          id: "11111111-1111-1111-1111-111111111111",
          status: "draft",
          updatedAt: new Date("2026-09-16T12:00:00.000Z"),
        };
      },
    },
    recordComment: {
      create: async () => {
        throw new Error("confirmed body write must not post an offer-send card");
      },
    },
  } as unknown as PrismaClient;

  await expect(
    new RecordCatalog(db).applyConfirmedReportBody({
      workspaceId: "workspace-1",
      userId: "outsider-1",
      reportId: "11111111-1111-1111-1111-111111111111",
      content: { tabs: { Progress: { markdown: "- leaked\n" } } },
    }),
  ).rejects.toEqual(new AppError("ACCESS_DENIED"));
  expect(updated).toBe(false);

  const result = await new RecordCatalog(db).applyConfirmedReportBody({
    workspaceId: "workspace-1",
    userId: "author-1",
    reportId: "11111111-1111-1111-1111-111111111111",
    content: { tabs: { Progress: { markdown: "- confirmed\n" } } },
  });
  expect(result.assistantPosted).toBe(false);
  expect(updated).toBe(true);
});

test("send-prompt suggestions are prompts only and Agent weekly-report protocol has no write ops", () => {
  expect(
    parseWeeklyReportAssistantSuggestion(
      [
        "Ready when you are.",
        "",
        "[weekly-report-suggestion]",
        JSON.stringify({
          type: "send-prompt",
          reportId: "11111111-1111-1111-1111-111111111111",
        }),
        "[/weekly-report-suggestion]",
      ].join("\n"),
    ),
  ).toEqual({
    type: "send-prompt",
    reportId: "11111111-1111-1111-1111-111111111111",
  });

  for (const operation of ["write", "draft_update", "highlight_generate", "send"] as const) {
    expect(() =>
      validateWeeklyReportRequest({
        protocolMajor: WEEKLY_REPORT_PROTOCOL_MAJOR,
        requestId: "request-1",
        workspaceId: "workspace-1",
        agentId: "agent-1",
        operation,
      }),
    ).toThrow("invalid weekly-report request");
    expect(() =>
      decodeWeeklyReportRequest(
        new TextEncoder().encode(
          JSON.stringify({
            protocolMajor: WEEKLY_REPORT_PROTOCOL_MAJOR,
            requestId: "request-1",
            workspaceId: "workspace-1",
            agentId: "agent-1",
            operation,
          }),
        ),
      ),
    ).toThrow("invalid weekly-report request");
  }
});

test("Members owned-agent listing includes the weekly-report assistant", async () => {
  let where: Record<string, unknown> | undefined;
  const db = {
    agent: {
      findMany: async (query: { where: Record<string, unknown> }) => {
        where = query.where;
        return [];
      },
    },
  } as unknown as PrismaClient;

  await new PrismaAgentRepository(db).listOwnedInWorkspace("workspace-1", "user-1");
  expect(where).toEqual({
    workspaceId: "workspace-1",
    ownerId: "user-1",
    deletedAt: null,
  });
});
