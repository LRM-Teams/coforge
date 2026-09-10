import { afterAll, expect, mock, test } from "bun:test";
import { RUNTIME_PROVIDER } from "@coforge/protocol";
import { AgentEnvironment } from "../src/server/agents/agent-environment.server";
import type { AgentRuntimeConfig } from "../src/server/agents/agent-runtime-config.server";

let runtimeConfig: AgentRuntimeConfig = {
  runtime: RUNTIME_PROVIDER.PI,
  provider: { kind: "default" },
  model: "",
  modelProvider: "",
  reasoning: "",
};
let allowed = true;
let launchAllowed = true;
let lookups = 0;
let issued = 0;
const previous = Bun.env.COFORGE_AGENT_CREDENTIAL_ENCRYPTION_KEY;
Bun.env.COFORGE_AGENT_CREDENTIAL_ENCRYPTION_KEY = "07".repeat(32);
const db = {
  agent: {
    findFirst: async (query: unknown) => {
      lookups++;
      expect(query).toMatchObject({
        where: {
          id: "agent-1",
          workspaceId: "workspace-1",
          computerId: "computer-1",
          owner: { memberships: { some: { workspaceId: "workspace-1" } } },
        },
      });
      return allowed
        ? { id: "agent-1", workspaceId: "workspace-1", ownerId: "owner-1", runtimeConfig }
        : null;
    },
  },
};
mock.module("../src/server/db/client.server", () => ({ getDatabaseClient: () => db }));
mock.module("../src/server/auth/daemon-api-key.server", () => ({
  verifyDaemonApiKey: async (key: string) => {
    if (key !== "valid") throw new Error("invalid");
    return { computerId: "computer-1", workspaceId: "workspace-1", userId: "owner-1" };
  },
}));
mock.module("../src/server/centrifugo/server-api.server", () => ({
  createCentrifugoServerApi: () => ({}),
}));
mock.module("../src/server/agents/agent-runtime-lock.server", () => ({
  getAgentRuntimeLock: () => ({}),
}));
mock.module("../src/server/agents/agent-control.server", () => ({
  AgentControl: class {
    async authorizeLaunch() {
      if (!launchAllowed) throw new Error("stale launch");
    }
  },
}));
mock.module("../src/server/computers/computer-runtime-visibility.server", () => ({
  ComputerRuntimeVisibility: class {
    async canSelect() {
      return true;
    }
  },
}));
mock.module("../src/server/db/repositories/agent-api-key.repositories.server", () => ({
  PrismaAgentApiKeyRepository: class {
    async replaceActive() {
      issued++;
    }
  },
}));
const { Route } = await import("../src/routes/api/agent-api-keys");
const handlers = Route.options.server!.handlers;
if (!handlers || typeof handlers === "function" || typeof handlers.POST !== "function")
  throw new Error("missing POST handler");
const post = handlers.POST;
function request(token?: string) {
  return post({
    request: new Request("https://example.test/api/agent-api-keys", {
      method: "POST",
      headers: token ? { authorization: `Bearer ${token}` } : {},
      body: JSON.stringify({ agentId: "agent-1", workspaceId: "workspace-1" }),
    }),
  } as Parameters<typeof post>[0]);
}
afterAll(() => {
  if (previous === undefined) delete Bun.env.COFORGE_AGENT_CREDENTIAL_ENCRYPTION_KEY;
  else Bun.env.COFORGE_AGENT_CREDENTIAL_ENCRYPTION_KEY = previous;
  mock.restore();
});

test("authorized launch HTTP response contains decrypted explicit env only, no-store; unauthorized and stale launches never decrypt", async () => {
  const principal = { workspaceId: "workspace-1", userId: "owner-1" };
  const environment = new AgentEnvironment(
    {
      findOwnedAgent: async () => ({ runtimeConfig }),
      updateRuntimeConfig: async (_id, config) => {
        runtimeConfig = config;
      },
    },
    {
      getById: async () => ({
        id: "agent-1",
        ownerId: "owner-1",
        workspaceId: "workspace-1",
        computerId: "computer-1",
        name: "builder",
        displayName: "Builder",
        createdAt: new Date(),
        runtimeConfig,
      }),
    },
    { stop: async () => {}, start: async () => {} },
    { run: async (_id, callback) => callback() },
    new Uint8Array(32).fill(7),
  );
  await environment.save(principal, "agent-1", {
    OPENROUTER_API_KEY: "explicit-secret",
    EMPTY: "",
  });
  const response = (await request("valid")) as Response;
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const payload = await response.json();
  expect(payload.envVars).toEqual({ OPENROUTER_API_KEY: "explicit-secret", EMPTY: "" });
  expect(payload.apiKey).toMatch(/^sk_agent_/);
  expect(JSON.stringify(payload)).not.toContain(runtimeConfig.environment!.ciphertext);
  const queried = lookups;
  expect(((await request()) as Response).status).toBe(401);
  expect(((await request("invalid")) as Response).status).toBe(401);
  expect(lookups).toBe(queried);
  runtimeConfig.environment!.ciphertext = "broken";
  allowed = false;
  expect(((await request("valid")) as Response).status).toBe(403);
  allowed = true;
  launchAllowed = false;
  expect(((await request("valid")) as Response).status).toBe(403);
  launchAllowed = true;
  const failed = (await request("valid")) as Response;
  expect(failed.status).toBe(503);
  expect(await failed.json()).toEqual({ error: "service unavailable" });
  expect(issued).toBe(1);
});
