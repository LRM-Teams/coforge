import { expect, test } from "bun:test";

import { handleAgentTaskPost } from "../src/routes/api/agent/v1/tasks";

const principal = { workspaceId: "workspace-1", agentId: "agent-1", userId: "user-1" };

const request = (body: unknown) =>
  new Request("https://server.example/api/agent/v1/tasks", {
    method: "POST",
    body: JSON.stringify(body),
  });

test("the Task route hands the board the command it expects, built from the API's idempotencyKey", async () => {
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
  // The board (and its protobuf codec) call the key `requestId`; a command without it is rejected
  // as an invalid Task request, which is what this boundary must never do.
  expect(received).toMatchObject({
    requestId: "request-1",
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
      // The real board refuses a command without `requestId` exactly like this.
      throw new Error("invalid Task request");
    },
  });

  // The route invents nothing: it maps the API's name onto the board's, and passes an absent value
  // through as absent so the board's own validation is the one that decides.
  expect(received).toMatchObject({ operation: "list", requestId: undefined });
  expect(result.status).toBe(400);
});
