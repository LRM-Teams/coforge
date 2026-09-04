import { expect, test } from "bun:test";
import { create, toBinary } from "@bufbuild/protobuf";
import { AgentStartIntentSchema } from "./gen/coforge/rpc/v1/workspace_pb";
import {
  AGENT_START_MESSAGE_TYPE,
  ComputerRegistrationClient,
  RUNTIME_PROVIDER,
  type AgentStartIntent,
} from "./index";
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
    wakeMessage: {
      messageId: "message-0",
      deliveryId: "delivery-0",
      conversationId: "conversation-1",
      sequence: 3,
      target: "@alice",
      latestSender: "@alice",
    },
    resumeMessages: [
      {
        messageId: "message-1",
        deliveryId: "delivery-1",
        conversationId: "conversation-1",
        sequence: 4,
        target: "@alice",
        latestSender: "@alice",
      },
    ],
    unreadSummary: { "@alice": 12 },
  } satisfies AgentStartIntent;

  expect(decodeAgentStartIntent(encodeAgentStartIntent(intent))).toEqual(intent);
});

test("Agent recovery codec rejects unsafe sequences and unread counts", () => {
  const base = {
    protocolMajor: 1,
    requestId: "request-1",
    workspaceId: "workspace-1",
    computerId: "computer-1",
    agentId: "agent-1",
    provider: "pi" as const,
    model: "default",
    modelProvider: "anthropic",
    reasoning: "balanced",
  };
  expect(() =>
    encodeAgentStartIntent({
      ...base,
      resumeMessages: [
        {
          messageId: "message-1",
          deliveryId: "delivery-1",
          conversationId: "conversation-1",
          sequence: Number.MAX_SAFE_INTEGER + 1,
          target: "@alice",
          latestSender: "@alice",
        },
      ],
    }),
  ).toThrow("sequence");
  expect(() => encodeAgentStartIntent({ ...base, unreadSummary: { "@alice": 2 ** 32 } })).toThrow(
    "count",
  );
});

test("Agent recovery codec rejects duplicate unread summary targets", () => {
  const bytes = toBinary(
    AgentStartIntentSchema,
    create(AgentStartIntentSchema, {
      protocolMajor: 1,
      requestId: "request-1",
      workspaceId: "workspace-1",
      computerId: "computer-1",
      agentId: "agent-1",
      provider: "pi",
      messageType: AGENT_START_MESSAGE_TYPE,
      unreadSummary: [
        { target: "@alice", count: 1 },
        { target: "@alice", count: 2 },
      ],
    }),
  );
  expect(() => decodeAgentStartIntent(bytes)).toThrow("recovery context");
});

test("Agent recovery codec limits resume messages to 100 on encode and decode", () => {
  const base = {
    protocolMajor: 1,
    requestId: "request-1",
    workspaceId: "workspace-1",
    computerId: "computer-1",
    agentId: "agent-1",
    provider: "pi" as const,
    model: "default",
    reasoning: "balanced",
    messageType: AGENT_START_MESSAGE_TYPE,
  };
  const resumeMessages = Array.from({ length: 101 }, (_, index) => ({
    messageId: `message-${index}`,
    deliveryId: `delivery-${index}`,
    conversationId: "conversation-1",
    sequence: index + 1,
    target: "@alice",
    latestSender: "@alice",
  }));

  expect(() => encodeAgentStartIntent({ ...base, resumeMessages })).toThrow("100");
  const bytes = toBinary(
    AgentStartIntentSchema,
    create(AgentStartIntentSchema, {
      ...base,
      resumeMessages: resumeMessages.map((message) => ({
        ...message,
        sequence: BigInt(message.sequence),
      })),
    }),
  );
  expect(() => decodeAgentStartIntent(bytes)).toThrow("recovery context");
});

test("Agent recovery decode rejects duplicate message and delivery IDs across wake and resume", () => {
  const recoveryMessage = {
    messageId: "message-1",
    deliveryId: "delivery-1",
    conversationId: "conversation-1",
    sequence: 1n,
    target: "@alice",
    latestSender: "@alice",
  };
  for (const duplicate of [
    { ...recoveryMessage, deliveryId: "delivery-2", sequence: 2n },
    { ...recoveryMessage, messageId: "message-2", sequence: 2n },
  ]) {
    const bytes = toBinary(
      AgentStartIntentSchema,
      create(AgentStartIntentSchema, {
        protocolMajor: 1,
        requestId: "request-1",
        workspaceId: "workspace-1",
        computerId: "computer-1",
        agentId: "agent-1",
        provider: "pi",
        messageType: AGENT_START_MESSAGE_TYPE,
        wakeMessage: recoveryMessage,
        resumeMessages: [duplicate],
      }),
    );
    expect(() => decodeAgentStartIntent(bytes)).toThrow("recovery context");
  }
});

test("Agent recovery encode rejects duplicate message and delivery IDs across wake and resume", () => {
  const wakeMessage = {
    messageId: "message-1",
    deliveryId: "delivery-1",
    conversationId: "conversation-1",
    sequence: 1,
    target: "@alice",
    latestSender: "@alice",
  };
  const base = {
    protocolMajor: 1,
    requestId: "request-1",
    workspaceId: "workspace-1",
    computerId: "computer-1",
    agentId: "agent-1",
    provider: "pi" as const,
    model: "default",
    reasoning: "balanced",
    wakeMessage,
  };
  for (const duplicate of [
    { ...wakeMessage, deliveryId: "delivery-2", sequence: 2 },
    { ...wakeMessage, messageId: "message-2", sequence: 2 },
  ]) {
    expect(() => encodeAgentStartIntent({ ...base, resumeMessages: [duplicate] })).toThrow(
      "recovery context",
    );
  }
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
