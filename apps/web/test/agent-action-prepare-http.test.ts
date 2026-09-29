import { expect, test } from "bun:test";
import { handleAgentActionPrepare } from "#src/routes/api/agent/v1/actions/prepare";
import { ActionCardError } from "#src/server/conversations/action-card-error.server";

const principal = { workspaceId: "workspace-1", agentId: "agent-1" };
const prepare = (body: unknown) =>
  new Request("https://server.example/api/agent/v1/actions/prepare", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const answer = async (response: Response) => ({
  status: response.status,
  body: await response.json(),
});

/** What building the route's dependencies does when Centrifugo is not configured. */
const unbuildable = () => {
  throw new Error("Centrifugo is not configured");
};

test("a body without a target is refused before any action-card dependency is built", async () => {
  for (const body of ["not json", { action: {} }, { target: "" }]) {
    expect(
      await answer(await handleAgentActionPrepare(prepare(body), principal, unbuildable)),
    ).toEqual({ status: 400, body: { error: "target is required" } });
  }
});

test("an invalid action is refused with its issues before any dependency is built", async () => {
  const response = await handleAgentActionPrepare(
    prepare({ target: "@ada", action: {} }),
    principal,
    unbuildable,
  );

  const { status, body } = await answer(response);
  expect(status).toBe(422);
  expect(body.code).toBe("INVALID_ACTION");
  expect(body.retryable).toBe(false);
  expect(body.error).toStartWith("Action failed validation: ");
  expect(Object.keys(body).sort()).toEqual(["code", "error", "retryable"]);
});

test("an action-card refusal names its field in the Agent API refusal shape", async () => {
  const response = await handleAgentActionPrepare(
    prepare({
      target: "#ops",
      action: { type: "channel:add_member", channel: "ops", humans: ["@x"] },
    }),
    principal,
    () => ({
      prepare: async () => {
        throw new ActionCardError(422, "INVALID_HANDLE", "unknown human handle: @x", {
          field: "action.humans[0]",
        });
      },
    }),
  );

  expect(await answer(response)).toEqual({
    status: 422,
    body: {
      error: "action.humans[0]: unknown human handle: @x",
      code: "INVALID_HANDLE",
      retryable: false,
    },
  });
});

test("a target user this Agent cannot reach is refused the way message send refuses it", async () => {
  const response = await handleAgentActionPrepare(
    prepare({ target: "@nobody", action: { type: "channel:create", name: "ops" } }),
    principal,
    () => ({
      prepare: async () => {
        throw new Error("target user not found");
      },
    }),
  );

  expect(await answer(response)).toEqual({
    status: 403,
    body: { error: "target is not accessible", code: "TARGET_NOT_ACCESSIBLE", retryable: false },
  });
});
