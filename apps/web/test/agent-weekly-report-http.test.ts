import { expect, test } from "bun:test";
import { WEEKLY_REPORT_PROTOCOL_MAJOR } from "@lrm/coforge-sdk/internal";
import { AppError } from "../src/lib/app-error";
import { executeAgentWeeklyReport } from "../src/server/agents/agent-weekly-report-http.server";

const request = {
  protocolMajor: WEEKLY_REPORT_PROTOCOL_MAJOR,
  idempotencyKey: "request",
  workspaceId: "workspace",
  agentId: "assistant",
  operation: "read" as const,
  reportId: "33333333-3333-4333-8333-333333333333",
  section: "Progress",
};

test("weekly-report Agent reads use the assistant owner User and deny ordinary Agents", async () => {
  const calls: unknown[] = [];
  const catalog = {
    loadAssistantContextManifest: async () => ({}),
    listAssistantVisibleReports: async () => ({ reports: [], nextCursor: null }),
    readAssistantReportSection: async (input: unknown) => {
      calls.push(input);
      return { markdown: "ok", truncated: false };
    },
  };
  const authorization = {
    computerIdForAuthorizedAgent: async () => "computer",
    weeklyReportAssistantOwner: async (workspaceId: string, agentId: string) =>
      workspaceId === "workspace" && agentId === "assistant" ? { userId: "owner" } : undefined,
  };

  const allowed = await executeAgentWeeklyReport(catalog, authorization, request, {
    userId: "owner",
    workspaceId: "workspace",
    computerId: "computer",
    agentId: "assistant",
  });
  expect(allowed).toEqual({
    response: {
      protocolMajor: WEEKLY_REPORT_PROTOCOL_MAJOR,
      idempotencyKey: "request",
      operation: "read",
      result: { markdown: "ok", truncated: false },
    },
  });
  expect(calls).toEqual([
    {
      workspaceId: "workspace",
      userId: "owner",
      reportId: "33333333-3333-4333-8333-333333333333",
      section: "Progress",
      maxCharacters: undefined,
    },
  ]);

  expect(
    await executeAgentWeeklyReport(catalog, authorization, request, {
      userId: "owner",
      workspaceId: "workspace",
      computerId: "computer",
      agentId: "ordinary-agent",
    }),
  ).toEqual({ error: { code: 403, message: "Weekly report principal scope mismatch" } });
  expect(calls).toHaveLength(1);
});

test("weekly-report Agent reads do not leak unauthorized report existence", async () => {
  const outcome = await executeAgentWeeklyReport(
    {
      loadAssistantContextManifest: async () => {
        throw new AppError("NOT_FOUND");
      },
      listAssistantVisibleReports: async () => ({ reports: [], nextCursor: null }),
      readAssistantReportSection: async () => {
        throw new AppError("NOT_FOUND");
      },
    },
    {
      computerIdForAuthorizedAgent: async () => "computer",
      weeklyReportAssistantOwner: async () => ({ userId: "owner" }),
    },
    request,
    {
      userId: "owner",
      workspaceId: "workspace",
      computerId: "computer",
      agentId: "assistant",
    },
  );
  expect(outcome).toEqual({ error: { code: 400, message: "Weekly report not found" } });
});
