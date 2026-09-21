import { expect, test } from "bun:test";

import { AppError } from "../src/lib/app-error";
import { handleAgentReminderPost } from "../src/routes/api/agent/v1/reminders";

const principal = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  agentId: "22222222-2222-4222-8222-222222222222",
  computerId: "33333333-3333-4333-8333-333333333333",
  userId: "44444444-4444-4444-8444-444444444444",
};

const request = (body: unknown) =>
  new Request("https://server.example/api/agent/v1/reminders", {
    method: "POST",
    body: JSON.stringify(body),
  });

const scheduleBody = {
  protocolMajor: 1,
  workspaceId: principal.workspaceId,
  agentId: principal.agentId,
  computerId: principal.computerId,
  operation: "schedule",
  title: "check the release",
  target: "#coforge",
  messageId: "55555555-5555-4555-8555-555555555555",
  fireAt: "2026-09-21T11:00:00.000Z",
} as const;

test("the reminder route reaches the service from the API's idempotencyKey", async () => {
  let received: { requestId?: string; operation?: string } | undefined;
  const response = await handleAgentReminderPost(
    request({ ...scheduleBody, idempotencyKey: "66666666-6666-4666-8666-666666666666" }),
    principal,
    async (command) => {
      received = command as { requestId?: string; operation?: string };
      return { result: "accepted" };
    },
  );

  expect(received?.requestId).toBe("66666666-6666-4666-8666-666666666666");
  expect(received?.operation).toBe("schedule");
  // The caller matches the answer against the key it sent, under the name it sent it.
  expect(await response.json()).toEqual({
    result: "accepted",
    idempotencyKey: "66666666-6666-4666-8666-666666666666",
  });
});

test("a reminder command without a key is still refused, and never reaches the service", async () => {
  let reached = false;
  const response = await handleAgentReminderPost(request(scheduleBody), principal, async () => {
    reached = true;
    return {};
  });

  expect(reached).toBe(false);
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "invalid reminder request" });
});

test("a command outside the authenticated Agent scope is rejected before the service", async () => {
  let reached = false;
  const response = await handleAgentReminderPost(
    request({
      ...scheduleBody,
      agentId: "99999999-9999-4999-8999-999999999999",
      idempotencyKey: "99999999-9999-4999-8999-999999999999",
    }),
    principal,
    async () => {
      reached = true;
      return {};
    },
  );

  expect(reached).toBe(false);
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: "reminder scope denied" });
});

test("an authorized command that the reminder service rejects is a 403, not malformed input", async () => {
  const response = await handleAgentReminderPost(
    request({ ...scheduleBody, idempotencyKey: "77777777-7777-4777-8777-777777777777" }),
    principal,
    async () => {
      throw new Error("reminder operation is not authorized");
    },
  );

  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({
    error: "reminder access denied",
    code: "ACCESS_DENIED",
  });
});

test("an AppError access denial from the reminder service stays a 403", async () => {
  const response = await handleAgentReminderPost(
    request({ ...scheduleBody, idempotencyKey: "88888888-8888-4888-8888-888888888888" }),
    principal,
    async () => {
      throw new AppError("ACCESS_DENIED");
    },
  );

  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({
    error: "reminder access denied",
    code: "ACCESS_DENIED",
  });
});
