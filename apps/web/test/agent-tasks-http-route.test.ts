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
  expect(received).toMatchObject({
    idempotencyKey: "request-1",
    operation: "list",
    target: "#general",
  });
  expect(await result.json()).toMatchObject({ idempotencyKey: "request-1", tasks: [] });
});

test("a Task command without a key reaches the board unchanged, and its refusal is a 400", async () => {
  let received: unknown;
  const result = await handleAgentTaskPost(request({ operation: "list" }), principal, {
    execute: async (_principal, command) => {
      received = command;
      // The real board refuses a command without an `idempotencyKey` exactly like this.
      throw new AppError("INVALID_INPUT");
    },
  });

  // The route invents nothing: it passes the body through as-is so the board's own validation is
  // the one that decides.
  expect(received).toEqual({ operation: "list" });
  expect(result.status).toBe(400);
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
