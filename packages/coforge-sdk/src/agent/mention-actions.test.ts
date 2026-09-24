import { expect, test } from "bun:test";
import {
  decodeAgentMentionActionErrorResponse,
  decodeAgentMentionExecuteResponse,
  decodeAgentMentionPendingResponse,
  type AgentMentionExecuteResponse,
  type AgentMentionPendingResponse,
} from "./mention-actions";

const PENDING: AgentMentionPendingResponse = {
  ok: true,
  pendingMentionActions: [
    {
      resolutionId: "22222222-2222-4222-8222-222222222222",
      messageId: "11111111-1111-4111-8111-111111111111",
      targetType: "user",
      targetHandle: "bob",
      targetAvatarUrl: null,
      reason: "not_member",
      availableActions: [],
      expiresAt: "2026-10-01T00:00:00.000Z",
      channelName: "triage",
    },
  ],
};

const EXECUTED: AgentMentionExecuteResponse = {
  ok: true,
  action: "add",
  results: [
    {
      resolutionId: "22222222-2222-4222-8222-222222222222",
      status: "no_permission",
      reason: "add_requires_human_member_authority",
      targetType: "user",
      targetId: "33333333-3333-4333-8333-333333333333",
    },
    { resolutionId: "44444444-4444-4444-8444-444444444444", status: "not_found" },
  ],
};

test("decodes the pending mention actions list", () => {
  expect(decodeAgentMentionPendingResponse(PENDING)).toEqual(PENDING);
  expect(decodeAgentMentionPendingResponse({ ok: true, pendingMentionActions: [] })).toEqual({
    ok: true,
    pendingMentionActions: [],
  });
});

test("rejects a pending list whose rows lack the channel or the actions", () => {
  const [row] = PENDING.pendingMentionActions;
  expect(() =>
    decodeAgentMentionPendingResponse({
      ok: true,
      pendingMentionActions: [{ ...row, channelName: undefined }],
    }),
  ).toThrow("invalid Agent mention pending response");
  expect(() =>
    decodeAgentMentionPendingResponse({
      ok: true,
      pendingMentionActions: [{ ...row, availableActions: "add" }],
    }),
  ).toThrow("invalid Agent mention pending response");
  expect(() => decodeAgentMentionPendingResponse({ ok: true })).toThrow();
});

test("decodes the per-id results of a mention action", () => {
  expect(decodeAgentMentionExecuteResponse(EXECUTED)).toEqual(EXECUTED);
  const notified = {
    ok: true,
    action: "notify",
    results: [{ resolutionId: "22222222-2222-4222-8222-222222222222", status: "queued" }],
  };
  expect(decodeAgentMentionExecuteResponse(notified)).toEqual(
    notified as AgentMentionExecuteResponse,
  );
  expect(() =>
    decodeAgentMentionExecuteResponse({ ok: true, action: "remove", results: [] }),
  ).toThrow("invalid Agent mention action response");
  expect(() =>
    decodeAgentMentionExecuteResponse({ ok: true, action: "add", results: [{ status: "x" }] }),
  ).toThrow("invalid Agent mention action response");
  expect(() => decodeAgentMentionExecuteResponse({ ok: true, results: [] })).toThrow();
});

test("decodes a mention action error envelope and ignores anything else", () => {
  expect(
    decodeAgentMentionActionErrorResponse({
      ok: false,
      errorCode: "invalid_request",
      error: "action must be add.",
    }),
  ).toEqual({ ok: false, errorCode: "invalid_request", error: "action must be add." });
  expect(decodeAgentMentionActionErrorResponse({ ok: false, errorCode: "other" })).toBeUndefined();
  expect(decodeAgentMentionActionErrorResponse("bad request")).toBeUndefined();
});
