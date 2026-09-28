import { expect, test } from "bun:test";
import { createAgentApiClient, workspaceInfoRoute } from "./client";

const BASE_RESPONSE = {
  protocolMajor: 1,
  idempotencyKey: "r",
  workspace: { id: "w", name: "Acme", slug: "acme" },
  humans: [],
  agents: [],
  projects: [],
};

test("workspace.info() surfaces a present runtimeContext unchanged", async () => {
  const runtimeContext = {
    agentId: "agent-1",
    agentName: "scout",
    runtime: "codex",
    model: "gpt-5-codex",
    reasoning: "medium",
    workspaceId: "workspace-1",
    workspaceSlug: "acme",
    workspaceName: "Acme",
    computerId: "computer-1",
    computerName: "Builder Box",
    computerHostname: "workstation-7",
    computerOs: "darwin 15.6",
    computerVersion: "0.1.0-dev.40",
  };
  const client = createAgentApiClient({
    request: async (route) => {
      expect(route).toBe(workspaceInfoRoute);
      return { ok: true, status: 200, data: { ...BASE_RESPONSE, runtimeContext } };
    },
  });
  await expect(client.workspace.info()).resolves.toMatchObject({ runtimeContext });
});

test("workspace.info() tolerates an older server that sends no runtimeContext at all", async () => {
  const client = createAgentApiClient({
    request: async () => ({ ok: true, status: 200, data: BASE_RESPONSE }),
  });
  const result = await client.workspace.info();
  expect(result.runtimeContext).toBeUndefined();
  expect(result.workspace).toEqual({ id: "w", name: "Acme", slug: "acme" });
});

test("workspace.info() tolerates a runtimeContext missing individual fields", async () => {
  const client = createAgentApiClient({
    request: async () => ({
      ok: true,
      status: 200,
      data: { ...BASE_RESPONSE, runtimeContext: { agentId: "agent-1" } },
    }),
  });
  await expect(client.workspace.info()).resolves.toMatchObject({
    runtimeContext: { agentId: "agent-1" },
  });
});
