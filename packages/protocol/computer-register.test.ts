import { expect, test } from "bun:test";
import { ComputerRegistrationClient, RUNTIME_PROVIDER, type AgentStartIntent } from "./index";
import {
  decodeComputerRegisterRequest,
  decodeAgentStartIntent,
  decodeDaemonRuntimeCodeAgentsUpdateRequest,
  encodeAgentStartIntent,
  encodeComputerRegisterRequest,
  encodeDaemonRuntimeCodeAgentsUpdateRequest,
} from "./codec";

test("computer registration sends the stable method and rejects incompatible majors", async () => {
  const calls: unknown[] = [];
  const client = new ComputerRegistrationClient({
    async request(method, payload) {
      calls.push([method, payload]);
      return {
        protocolMajor: 1,
        requestId: payload.requestId,
        computerId: "c",
        workspaceId: "w",
        daemonApiKey: "secret",
      };
    },
  });
  const request = {
    protocolMajor: 1,
    requestId: "r",
    workspaceSlug: "team",
    machineId: "m",
    platform: "linux",
    osVersion: "1",
    computerVersion: "1",
    runtimes: [],
    registrationIdempotencyKey: "i",
  };
  await expect(client.register(request)).resolves.toMatchObject({
    computerId: "c",
    workspaceId: "w",
  });
  expect(calls[0]).toMatchObject(["computer:register", request]);
  expect(() => client.register({ ...request, protocolMajor: 2 })).toThrow("unsupported");
});

test("registration codec preserves runtime provider metadata", () => {
  const request = {
    protocolMajor: 1,
    requestId: "r",
    workspaceSlug: "team",
    machineId: "m",
    platform: "linux",
    osVersion: "1",
    computerVersion: "1",
    registrationIdempotencyKey: "i",
    runtimes: [{ provider: RUNTIME_PROVIDER.PI, version: "1", displayName: "Pi" }],
  } satisfies Parameters<ComputerRegistrationClient["register"]>[0];
  expect(decodeComputerRegisterRequest(encodeComputerRegisterRequest(request)).runtimes).toEqual(
    request.runtimes,
  );
  const external = request.runtimes[0];
  const externalPayload = encodeComputerRegisterRequest({
    ...request,
    runtimes: [external],
  });
  expect(decodeComputerRegisterRequest(externalPayload).runtimes).toEqual([external]);
});

test("daemon runtime code-agent inventory round trips as a complete external snapshot", () => {
  const request = {
    protocolMajor: 1,
    requestId: "inventory-1",
    workspaceId: "workspace-1",
    computerId: "computer-1",
    runtimes: [
      {
        provider: RUNTIME_PROVIDER.CODEX,
        version: "0.151.0",
        displayName: "Codex",
      },
      {
        provider: RUNTIME_PROVIDER.CLAUDE_CODE,
        version: "2.1.0",
        displayName: "Claude Code",
      },
    ],
    catalogs: [
      {
        provider: RUNTIME_PROVIDER.CODEX,
        models: [
          {
            id: "gpt-5.6-sol",
            displayName: "GPT-5.6 Sol",
            description: "Primary coding model",
            modelProvider: "openai",
            reasoningEfforts: ["low", "medium", "high"],
            defaultReasoning: "low",
            recommended: true,
          },
        ],
      },
      {
        provider: RUNTIME_PROVIDER.PI,
        models: [
          {
            id: "claude-sonnet-4-6",
            displayName: "Claude Sonnet 4.6",
            description: "",
            modelProvider: "anthropic",
            reasoningEfforts: ["off", "low", "medium", "high"],
            defaultReasoning: "medium",
            recommended: false,
          },
        ],
      },
    ],
  };

  expect(
    decodeDaemonRuntimeCodeAgentsUpdateRequest(encodeDaemonRuntimeCodeAgentsUpdateRequest(request)),
  ).toEqual(request);
});

test("Agent start preserves its runtime provider config", () => {
  const intent = {
    protocolMajor: 1,
    requestId: "start-1",
    workspaceId: "workspace-1",
    computerId: "computer-1",
    agentId: "agent-1",
    provider: RUNTIME_PROVIDER.PI,
    model: "claude-sonnet-4-6",
    modelProvider: "anthropic",
    reasoning: "high",
    providerConfig: {
      kind: "coforge",
      providerId: "anthropic",
    },
  } satisfies AgentStartIntent;

  expect(decodeAgentStartIntent(encodeAgentStartIntent(intent))).toEqual(intent);
});

test("Agent start rejects non-canonical runtime provider config", () => {
  const intent = {
    protocolMajor: 1,
    requestId: "start-1",
    workspaceId: "workspace-1",
    computerId: "computer-1",
    agentId: "agent-1",
    provider: RUNTIME_PROVIDER.PI,
    model: "deepseek-chat",
    reasoning: "high",
  };

  expect(() =>
    encodeAgentStartIntent({
      ...intent,
      providerConfig: { kind: "coforge" },
    } as unknown as Parameters<typeof encodeAgentStartIntent>[0]),
  ).toThrow("invalid Agent runtime provider config");
  expect(() =>
    encodeAgentStartIntent({
      ...intent,
      providerConfig: { kind: "custom", providerId: "deepseek" },
    } as unknown as Parameters<typeof encodeAgentStartIntent>[0]),
  ).toThrow("invalid Agent runtime provider config");
});
