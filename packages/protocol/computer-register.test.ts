import { expect, test } from "bun:test";
import { ComputerRegistrationClient, RUNTIME_PROVIDER } from "./index";
import {
  decodeComputerRegisterRequest,
  decodeAgentStartIntent,
  decodeWorkspaceWorkerCodeAgentsUpdateRequest,
  encodeAgentStartIntent,
  encodeComputerRegisterRequest,
  encodeWorkspaceWorkerCodeAgentsUpdateRequest,
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
        workspaceWorkerToken: "secret",
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

test("registration codec encodes builtin and external kinds explicitly", () => {
  const request = {
    protocolMajor: 1,
    requestId: "r",
    workspaceSlug: "team",
    machineId: "m",
    platform: "linux",
    osVersion: "1",
    computerVersion: "1",
    registrationIdempotencyKey: "i",
    runtimes: [{ provider: RUNTIME_PROVIDER.PI, version: "1", kind: "builtin" as const }],
  } satisfies Parameters<ComputerRegistrationClient["register"]>[0];
  expect(decodeComputerRegisterRequest(encodeComputerRegisterRequest(request)).runtimes).toEqual(
    request.runtimes,
  );
  const external = { ...request.runtimes[0], kind: "external" as const };
  const externalPayload = encodeComputerRegisterRequest({
    ...request,
    runtimes: [external],
  });
  expect(decodeComputerRegisterRequest(externalPayload).runtimes).toEqual([external]);

  // Simulate a pre-kind payload by removing RuntimeMetadata.kind (field 4,
  // wire bytes 0x20 0x02) while retaining the request's later fields.
  const kindFieldOffset = externalPayload.lastIndexOf(0x20);
  const runtimesFieldOffset = externalPayload.lastIndexOf(0x42, kindFieldOffset);
  const oldPayload = new Uint8Array([
    ...externalPayload.slice(0, kindFieldOffset),
    ...externalPayload.slice(kindFieldOffset + 2),
  ]);
  oldPayload[runtimesFieldOffset + 1] -= 2;
  expect(decodeComputerRegisterRequest(oldPayload).runtimes[0].kind).toBe("external");
});

test("provider and kind together identify runtimes", () => {
  const runtimes = [
    { provider: RUNTIME_PROVIDER.PI, version: "builtin", kind: "builtin" as const },
    { provider: RUNTIME_PROVIDER.PI, version: "1.0.0", kind: "external" as const },
  ];
  expect(runtimes.map(({ provider, kind }) => `${provider}:${kind}`)).toEqual([
    "pi:builtin",
    "pi:external",
  ]);
});

test("workspace worker code-agent inventory round trips as a complete external snapshot", () => {
  const request = {
    protocolMajor: 1,
    requestId: "inventory-1",
    workspaceId: "workspace-1",
    computerId: "computer-1",
    runtimes: [
      { provider: RUNTIME_PROVIDER.CODEX, version: "0.151.0", kind: "external" as const },
      {
        provider: RUNTIME_PROVIDER.CLAUDE_CODE,
        version: "2.1.0",
        kind: "external" as const,
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
    decodeWorkspaceWorkerCodeAgentsUpdateRequest(
      encodeWorkspaceWorkerCodeAgentsUpdateRequest(request),
    ),
  ).toEqual(request);
});

test("Agent start preserves the model provider required by Pi", () => {
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
  };

  expect(decodeAgentStartIntent(encodeAgentStartIntent(intent))).toEqual(intent);
});
