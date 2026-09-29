import { expect, test } from "bun:test";
import { handleAgentActionPrepare } from "#src/routes/api/agent/v1/actions/prepare";

const principal = { workspaceId: "workspace-1", agentId: "agent-1" };
const prepare = (body: string) =>
  new Request("https://server.example/api/agent/v1/actions/prepare", { method: "POST", body });

test("an invalid body is refused before any action-card dependency is built", async () => {
  const unbuildable = () => {
    throw new Error("Centrifugo is not configured");
  };

  for (const body of ["not json", JSON.stringify({ action: {} }), JSON.stringify({ target: "" })]) {
    const response = await handleAgentActionPrepare(prepare(body), principal, unbuildable);
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 400,
      body: { error: "target is required" },
    });
  }
});

test("a target user this Agent cannot reach is refused the way message send refuses it", async () => {
  const response = await handleAgentActionPrepare(
    prepare(JSON.stringify({ target: "@nobody", action: { type: "channel:create", name: "ops" } })),
    principal,
    () => ({
      prepare: async () => {
        throw new Error("target user not found");
      },
    }),
  );

  expect({ status: response.status, body: await response.json() }).toEqual({
    status: 403,
    body: { error: "target is not accessible" },
  });
});
