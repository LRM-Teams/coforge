import { expect, test } from "bun:test";

import { AppError } from "#/lib/app-error";
import { handleAgentTaskPost } from "../src/routes/api/agent/v1/tasks";

const principal = { workspaceId: "workspace-1", agentId: "agent-1", userId: "user-1" };

const request = (body: unknown) =>
  new Request("https://server.example/api/agent/v1/tasks", {
    method: "POST",
    body: JSON.stringify(body),
  });

test("the Task route hands the board the body it expects, key named idempotencyKey on both sides", async () => {
  let received: unknown;
  const result = await handleAgentTaskPost(
    request({
      protocolMajor: 1,
      idempotencyKey: "request-1",
      workspaceId: "workspace-1",
      agentId: "agent-1",
      operation: "list",
      target: "#general",
    }),
    principal,
    {
      execute: async (_principal, command) => {
        received = command;
        return { tasks: [] };
      },
    },
  );

  expect(result.status).toBe(200);
  // One name, no rename at this boundary: the board's command carries `idempotencyKey` exactly as
  // the wire did, and the route echoes the same key back.
  expect(received).toEqual({
    idempotencyKey: "request-1",
    operation: "list",
    target: "#general",
  });
  expect(await result.json()).toMatchObject({ idempotencyKey: "request-1", tasks: [] });
});

test("a Task command without a key is rejected before the board is called", async () => {
  let called = false;
  const result = await handleAgentTaskPost(request({ operation: "list" }), principal, {
    execute: async () => {
      called = true;
      throw new AppError("INVALID_INPUT");
    },
  });

  expect(result.status).toBe(400);
  expect(called).toBe(false);
});

test("malformed JSON is rejected before the board is called", async () => {
  let called = false;
  const result = await handleAgentTaskPost(
    new Request("https://server.example/api/agent/v1/tasks", {
      method: "POST",
      body: "{not-json",
    }),
    principal,
    {
      execute: async () => {
        called = true;
        return { tasks: [] };
      },
    },
  );

  expect(result.status).toBe(400);
  expect(called).toBe(false);
});

test("a body with an invalid command shape is rejected before the board is called", async () => {
  let called = false;
  const result = await handleAgentTaskPost(request({ operation: "not-a-task" }), principal, {
    execute: async () => {
      called = true;
      return { tasks: [] };
    },
  });

  expect(result.status).toBe(400);
  expect(called).toBe(false);
});

test("a resource receipt accepts an ISO expiry with a timezone offset", async () => {
  let received: unknown;
  const result = await handleAgentTaskPost(
    request({
      idempotencyKey: "request-1",
      operation: "receipt",
      target: "#general",
      receipt: {
        object: "staging bucket",
        purpose: "release verification",
        teardownOwner: "@alice",
        securityPrivacy: "private test data",
        expiry: "2030-03-04T05:06:00+08:00",
        runbook: "delete the bucket",
        tracking: "task-123",
      },
    }),
    principal,
    {
      execute: async (_principal, command) => {
        received = command;
        return { tasks: [] };
      },
    },
  );

  expect(result.status).toBe(200);
  expect(received).toMatchObject({ receipt: { expiry: "2030-03-04T05:06:00+08:00" } });
});

test("a mismatched daemon envelope is rejected before the board is called", async () => {
  let called = false;
  const result = await handleAgentTaskPost(
    request({
      protocolMajor: 1,
      idempotencyKey: "request-1",
      workspaceId: "workspace-1",
      agentId: "another-agent",
      operation: "list",
      target: "#general",
    }),
    principal,
    {
      execute: async () => {
        called = true;
        return { tasks: [] };
      },
    },
  );

  expect(result.status).toBe(403);
  expect(called).toBe(false);
});

test("the board receives an agent-scoped principal — never the owner's userId alongside it", async () => {
  // The HTTP auth principal carries the agent AND its owner (`userId`). The real board's scope()
  // throws ACCESS_DENIED unless EXACTLY ONE of the two is set, so a pass-through principal makes
  // every agent Task command over HTTP a 400 that says only "ACCESS_DENIED". This pins the fix.
  let receivedPrincipal: unknown;
  const result = await handleAgentTaskPost(
    request({ idempotencyKey: "request-1", operation: "list", target: "#general" }),
    principal,
    {
      execute: async (passedPrincipal) => {
        receivedPrincipal = passedPrincipal;
        return { tasks: [] };
      },
    },
  );

  expect(result.status).toBe(200);
  expect(receivedPrincipal).toEqual({ workspaceId: "workspace-1", agentId: "agent-1" });
});

test("a board error carrying a domain code is answered 400 with that code, not one flat word", async () => {
  const result = await handleAgentTaskPost(
    request({ idempotencyKey: "request-1", operation: "list", target: "#general" }),
    principal,
    {
      execute: async () => {
        throw new AppError("INVALID_INPUT");
      },
    },
  );

  expect(result.status).toBe(400);
  expect(await result.json()).toEqual({ error: "invalid task request", code: "INVALID_INPUT" });
});

test("an unexpected failure is logged and answered 500 — never blamed on the caller", async () => {
  const logged: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void logged.push(args);
  try {
    const result = await handleAgentTaskPost(
      request({ idempotencyKey: "request-1", operation: "list", target: "#general" }),
      principal,
      {
        execute: async () => {
          throw new Error('column "Agent"."visibility" does not exist');
        },
      },
    );

    // A database or coding fault is ours: it must be reported as such, and it must leave a trace,
    // because a 400 with one flat word is what hid this class of failure from the route's callers.
    expect(result.status).toBe(500);
    expect(await result.json()).toEqual({ error: "Task command failed" });
    expect(logged).toHaveLength(1);
  } finally {
    console.error = original;
  }
});
