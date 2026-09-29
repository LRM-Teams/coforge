import { expect, test } from "bun:test";
import { validateWeeklyReportRequest } from "@lrm/coforge-sdk/internal";
import { AppError } from "#src/lib/app-error";
import { executeAgentWeeklyReport } from "#src/server/agents/agent-weekly-report-http.server";

const request = {
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

test("weekly-report HTTP echoes the caller's idempotencyKey after validation", async () => {
  const validated = validateWeeklyReportRequest({
    idempotencyKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    workspaceId: "workspace",
    agentId: "assistant",
    operation: "read",
    reportId: REPORT,
    section: "Progress",
  });
  expect(validated.idempotencyKey).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");

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
    validated,
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

test("weekly-report workflow uses the authenticated owner without requiring a page", async () => {
  const calls: unknown[] = [];
  const outcome = await executeAgentWeeklyReport(
    {
      loadAssistantContextManifest: async () => ({}),
      listAssistantVisibleReports: async () => ({}),
      readAssistantReportSection: async () => ({}),
    },
    {
      computerIdForAuthorizedAgent: async () => "computer",
      weeklyReportAssistantOwner: async () => ({ userId: "owner" }),
    },
    { ...request, operation: "workflow", action: { type: "templates" } },
    { userId: "owner", workspaceId: "workspace", computerId: "computer", agentId: "assistant" },
    {
      execute: async (actor, action) => {
        calls.push({ actor, action });
        return { templates: [{ name: "Foundation Models Weekly" }] };
      },
    },
  );
  expect(outcome).toMatchObject({
    response: {
      operation: "workflow",
      result: { templates: [{ name: "Foundation Models Weekly" }] },
    },
  });
  expect(calls).toEqual([
    { actor: { workspaceId: "workspace", userId: "owner" }, action: { type: "templates" } },
  ]);
});

test("ordinary Agents cannot invoke workflow writes even with matching principal IDs", async () => {
  const outcome = await executeAgentWeeklyReport(
    {
      loadAssistantContextManifest: async () => ({}),
      listAssistantVisibleReports: async () => ({}),
      readAssistantReportSection: async () => ({}),
    },
    {
      computerIdForAuthorizedAgent: async () => "computer",
      weeklyReportAssistantOwner: async () => undefined,
    },
    {
      ...request,
      agentId: "ordinary",
      operation: "workflow",
      action: { type: "submit", reportId: REPORT },
    },
    { userId: "owner", workspaceId: "workspace", computerId: "computer", agentId: "ordinary" },
    {
      execute: async () => {
        throw new Error("unauthorized workflow must not execute");
      },
    },
  );
  expect(outcome).toEqual({
    error: { code: 403, message: "Weekly report assistant access denied" },
  });
});
