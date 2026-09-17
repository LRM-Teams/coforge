import { expect, test } from "bun:test";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { Route } from "../src/routes/api/agent/v1/workspace";

const handlers = Route.options.server!.handlers;
if (!handlers || typeof handlers === "function" || typeof handlers.GET !== "function")
  throw new Error("missing GET handler");
const get = handlers.GET;

const WORKSPACE = { id: "workspace-1", name: "Acme", slug: "acme" };
const OTHER_AGENT = {
  id: "agent-2",
  name: "helper",
  displayName: "Helper",
  description: "",
};

function baseDb(selfAgent: unknown) {
  return {
    workspace: { findUnique: async () => WORKSPACE },
    workspaceMembership: { findMany: async () => [] },
    agent: {
      findMany: async () => [
        {
          id: "agent-1",
          name: "scout",
          displayName: "Scout",
          description: "Reviews pull requests.",
        },
        OTHER_AGENT,
      ],
      findUnique: async () => selfAgent,
    },
    project: { findMany: async () => [] },
  };
}

function request(principal: { workspaceId: string; agentId: string }, selfAgent: unknown) {
  return get({
    context: { principal, db: baseDb(selfAgent) },
  } as unknown as Parameters<typeof get>[0]);
}

const PRINCIPAL = { workspaceId: "workspace-1", agentId: "agent-1" };

test("workspace info includes the calling Agent's own runtimeContext", async () => {
  const response = (await request(PRINCIPAL, {
    id: "agent-1",
    name: "scout",
    runtimeConfig: {
      runtime: RUNTIME_PROVIDER.CODEX,
      provider: { kind: "default" },
      model: "gpt-5-codex",
      modelProvider: "",
      reasoning: "medium",
    },
    computerId: "computer-1",
    computer: {
      name: "workstation-7",
      displayName: "Builder Box",
      platform: "darwin",
      osVersion: "15.6",
      computerVersion: "0.1.0-dev.40",
    },
  })) as Response;
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.runtimeContext).toEqual({
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
    computerOs: "darwin 15.6",
    computerVersion: "0.1.0-dev.40",
    computerHostname: "workstation-7",
  });
});

test("workspace info never includes another Agent's runtime data", async () => {
  const response = (await request(PRINCIPAL, {
    id: "agent-1",
    name: "scout",
    runtimeConfig: {
      runtime: RUNTIME_PROVIDER.CODEX,
      provider: { kind: "default" },
      model: "gpt-5-codex",
      modelProvider: "",
      reasoning: "medium",
    },
    computerId: "computer-1",
    computer: {
      name: "workstation-7",
      displayName: "Builder Box",
      platform: "darwin",
      osVersion: "15.6",
      computerVersion: "0.1.0-dev.40",
    },
  })) as Response;
  const body = await response.json();
  expect(body.agents).toEqual([
    {
      name: "scout",
      displayName: "Scout",
      description: "Reviews pull requests.",
      status: "unknown",
      activity: null,
      activityDetail: null,
      role: "self",
    },
    {
      name: "helper",
      displayName: "Helper",
      description: "",
      status: "unknown",
      activity: null,
      activityDetail: null,
      role: null,
    },
  ]);
  expect(JSON.stringify(body.agents)).not.toContain("runtime");
  expect(JSON.stringify(body.agents)).not.toContain("gpt-5-codex");
});

test("workspace info omits Computer fields for an Agent without a Computer", async () => {
  const response = (await request(PRINCIPAL, {
    id: "agent-1",
    name: "scout",
    runtimeConfig: {
      runtime: RUNTIME_PROVIDER.CODEX,
      provider: { kind: "default" },
      model: "gpt-5-codex",
      modelProvider: "",
      reasoning: "medium",
    },
    computerId: null,
    computer: null,
  })) as Response;
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.runtimeContext).toEqual({
    agentId: "agent-1",
    agentName: "scout",
    runtime: "codex",
    model: "gpt-5-codex",
    reasoning: "medium",
    workspaceId: "workspace-1",
    workspaceSlug: "acme",
    workspaceName: "Acme",
  });
});

test("workspace info omits runtimeContext entirely when the calling Agent record is missing", async () => {
  const response = (await request(PRINCIPAL, null)) as Response;
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.runtimeContext).toBeUndefined();
});
