import { expect, test } from "bun:test";
import {
  decodeWeeklyReportResponse,
  encodeWeeklyReportRequest,
  WEEKLY_REPORT_PROTOCOL_MAJOR,
} from "@lrm/coforge-sdk/internal";
import { AppError } from "../src/lib/app-error";
import { createAgentWeeklyReportMethod } from "../src/server/agents/agent-weekly-report-http.server";

const request = encodeWeeklyReportRequest({
  protocolMajor: WEEKLY_REPORT_PROTOCOL_MAJOR,
  requestId: "request",
  workspaceId: "workspace",
  agentId: "assistant",
  operation: "read",
  reportId: "33333333-3333-4333-8333-333333333333",
  section: "Progress",
});

test("weekly-report Agent reads use the assistant owner User and deny ordinary Agents", async () => {
  const calls: unknown[] = [];
  const method = createAgentWeeklyReportMethod(
    {
      loadAssistantContextManifest: async () => ({}),
      listAssistantVisibleReports: async () => ({ reports: [], nextCursor: null }),
      readAssistantReportSection: async (input) => {
        calls.push(input);
        return { markdown: "ok", truncated: false };
      },
    },
    {
      computerIdForAuthorizedAgent: async () => "computer",
      weeklyReportAssistantOwner: async (workspaceId, agentId) =>
        workspaceId === "workspace" && agentId === "assistant" ? { userId: "owner" } : undefined,
    },
  );

  const allowed = await method(request, {
    principal: {
      userId: "owner",
      workspaceId: "workspace",
      computerId: "computer",
      agentId: "assistant",
    },
  });
  expect(allowed).toBeInstanceOf(Uint8Array);
  expect(decodeWeeklyReportResponse(allowed as Uint8Array).result).toEqual({
    markdown: "ok",
    truncated: false,
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
    await method(request, {
      principal: {
        userId: "owner",
        workspaceId: "workspace",
        computerId: "computer",
        agentId: "ordinary-agent",
      },
    }),
  ).toEqual({ code: 403, message: "Weekly report principal scope mismatch" });
  expect(calls).toHaveLength(1);
});

test("weekly-report Agent reads do not leak unauthorized report existence", async () => {
  const method = createAgentWeeklyReportMethod(
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
  );
  expect(
    await method(request, {
      principal: {
        userId: "owner",
        workspaceId: "workspace",
        computerId: "computer",
        agentId: "assistant",
      },
    }),
  ).toEqual({ code: 400, message: "Weekly report not found" });
});
