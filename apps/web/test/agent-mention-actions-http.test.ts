import { expect, test } from "bun:test";
import { handleAgentMentionPendingGet } from "#src/routes/api/agent/v1/mention-actions_.pending";
import { handleAgentMentionExecutePost } from "#src/routes/api/agent/v1/mention-actions_.execute";

const principal = { workspaceId: "workspace-1", agentId: "agent-1" };
const RESOLUTION_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_ID = "44444444-4444-4444-8444-444444444444";

const executeRequest = (body: unknown) =>
  new Request("https://server.example/api/agent/v1/mention-actions/execute", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

test("lists the calling Agent's pending mentions with the channel, reason, and ISO expiry", async () => {
  const calls: unknown[] = [];
  const response = await handleAgentMentionPendingGet(principal, {
    pendingMentionActions: async (workspaceId, agentId) => {
      calls.push({ workspaceId, agentId });
      return [
        {
          resolutionId: RESOLUTION_ID,
          messageId: "11111111-1111-4111-8111-111111111111",
          targetType: "user",
          targetId: "33333333-3333-4333-8333-333333333333",
          targetHandle: "bob",
          targetLabel: "Bob",
          targetAvatarUrl: null,
          channelName: "triage",
          availableActions: [],
          expiresAt: new Date("2026-10-01T00:00:00Z"),
        },
      ];
    },
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    ok: true,
    pendingMentionActions: [
      {
        resolutionId: RESOLUTION_ID,
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
  });
  expect(calls).toEqual([{ workspaceId: "workspace-1", agentId: "agent-1" }]);
});

test("answers an Agent's add request with one refusal per requested id", async () => {
  const calls: unknown[] = [];
  const response = await handleAgentMentionExecutePost(
    executeRequest({ action: "add", resolutionIds: [RESOLUTION_ID, OTHER_ID] }),
    principal,
    {
      notifyAgentMentionTargets: async () => {
        throw new Error("must not be called");
      },
      refuseAgentMentionAdds: async (workspaceId, agentId, resolutionIds) => {
        calls.push({ workspaceId, agentId, resolutionIds });
        return [
          {
            resolutionId: RESOLUTION_ID,
            status: "no_permission",
            reason: "add_requires_human_member_authority",
            targetType: "user",
            targetId: "33333333-3333-4333-8333-333333333333",
          },
          { resolutionId: OTHER_ID, status: "not_found" },
        ];
      },
    },
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    ok: true,
    action: "add",
    results: [
      {
        resolutionId: RESOLUTION_ID,
        status: "no_permission",
        reason: "add_requires_human_member_authority",
        targetType: "user",
        targetId: "33333333-3333-4333-8333-333333333333",
      },
      { resolutionId: OTHER_ID, status: "not_found" },
    ],
  });
  expect(calls).toEqual([
    { workspaceId: "workspace-1", agentId: "agent-1", resolutionIds: [RESOLUTION_ID, OTHER_ID] },
  ]);
});

test("carries out an Agent's notify request and answers one result per requested id", async () => {
  const calls: unknown[] = [];
  const response = await handleAgentMentionExecutePost(
    executeRequest({ action: "notify", resolutionIds: [RESOLUTION_ID] }),
    principal,
    {
      notifyAgentMentionTargets: async (workspaceId, agentId, resolutionIds) => {
        calls.push({ workspaceId, agentId, resolutionIds });
        return [{ resolutionId: RESOLUTION_ID, status: "queued" }];
      },
      refuseAgentMentionAdds: async () => {
        throw new Error("must not be called");
      },
    },
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    ok: true,
    action: "notify",
    results: [{ resolutionId: RESOLUTION_ID, status: "queued" }],
  });
  expect(calls).toEqual([
    { workspaceId: "workspace-1", agentId: "agent-1", resolutionIds: [RESOLUTION_ID] },
  ]);
});

test("rejects a malformed mention action request with an invalid_request envelope", async () => {
  const refuse = async () => {
    throw new Error("must not be called");
  };
  const tooMany = Array.from(
    { length: 21 },
    (_, index) => `22222222-2222-4222-8222-${String(index).padStart(12, "0")}`,
  );
  for (const body of [
    "not json",
    { action: "remove", resolutionIds: [RESOLUTION_ID] },
    { resolutionIds: [RESOLUTION_ID] },
    { action: "add", resolutionIds: [] },
    { action: "add", resolutionIds: tooMany },
    { action: "add", resolutionIds: ["not-a-uuid"] },
    { action: "add", resolutionIds: RESOLUTION_ID },
  ]) {
    const response = await handleAgentMentionExecutePost(executeRequest(body), principal, {
      notifyAgentMentionTargets: refuse,
      refuseAgentMentionAdds: refuse,
    });
    expect(response.status).toBe(400);
    const json = (await response.json()) as { ok: boolean; errorCode: string; error: string };
    expect(json.ok).toBe(false);
    expect(json.errorCode).toBe("invalid_request");
    expect(typeof json.error).toBe("string");
  }
});
