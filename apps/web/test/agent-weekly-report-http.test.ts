import { expect, test } from "bun:test";
import {
  WEEKLY_REPORT_PROTOCOL_MAJOR,
  validateWeeklyReportRequest,
} from "@lrm/coforge-sdk/internal";
import { AppError } from "@/lib/app-error";
import {
  executeAgentWeeklyReport,
  weeklyReportWireRequest,
} from "@/server/agents/agent-weekly-report-http.server";
import { weeklyReportKeyPointsHttpResponse } from "@/routes/api/agent/v1/weekly-report-key-points";
import { weeklyReportCollectHttpResponse } from "@/routes/api/agent/v1/weekly-report-collect";

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

const REPORT = "33333333-3333-4333-8333-333333333333";

test("weekly-report HTTP echoes the caller's idempotencyKey after requestId validation", async () => {
  const validated = validateWeeklyReportRequest({
    protocolMajor: WEEKLY_REPORT_PROTOCOL_MAJOR,
    requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    workspaceId: "workspace",
    agentId: "assistant",
    operation: "read",
    reportId: REPORT,
    section: "Progress",
  });
  const wire = weeklyReportWireRequest(validated);
  expect(wire.idempotencyKey).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  expect("requestId" in wire).toBe(false);

  const outcome = await executeAgentWeeklyReport(
    {
      loadAssistantContextManifest: async () => ({}),
      listAssistantVisibleReports: async () => ({ reports: [], nextCursor: null }),
      readAssistantReportSection: async () => ({ markdown: "ok", truncated: false }),
    },
    {
      computerIdForAuthorizedAgent: async () => "computer",
      weeklyReportAssistantOwner: async () => ({ userId: "owner" }),
    },
    wire,
    {
      userId: "owner",
      workspaceId: "workspace",
      computerId: "computer",
      agentId: "assistant",
    },
  );
  expect(outcome).toMatchObject({
    response: { idempotencyKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
  });
});

test("key-point and collect HTTP responses echo idempotencyKey for the daemon proxy", () => {
  const key = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  expect(
    weeklyReportKeyPointsHttpResponse({
      idempotencyKey: key,
      reportId: REPORT,
      status: "ready",
    }),
  ).toMatchObject({ idempotencyKey: key, requestId: key, reportId: REPORT, status: "ready" });
  expect(
    weeklyReportCollectHttpResponse({
      idempotencyKey: key,
      runId: REPORT,
      status: "settled",
      allTerminal: true,
      canSynthesize: true,
      newlyAccepted: true,
      synthesisStarted: false,
    }),
  ).toMatchObject({ idempotencyKey: key, requestId: key });
});
