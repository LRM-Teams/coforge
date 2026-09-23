import { expect, test } from "bun:test";
import { encodeAgentContextUsage, type AgentContextUsage } from "@lrm/coforge-sdk/internal";
import type { AgentControlAgent, AgentControlState } from "@/server/agents/agent-control.server";
import { createAgentContextUsageMethod } from "@/server/centrifugo/agent-context-usage-receiver.server";

function fixture() {
  const config = {
    runtime: "claude-code" as const,
    provider: { kind: "default" as const },
    model: "",
    modelProvider: "",
    reasoning: "",
  };
  const state: AgentControlState = {
    version: 1,
    protocolMajor: 1,
    requestId: "request",
    workspaceId: "workspace",
    computerId: "computer",
    agentId: "agent",
    provider: "claude-code",
    epoch: 1,
    action: "start",
    phase: "starting",
    configRevision: "",
    launchId: "launch-1",
    identity: { sessionId: "native-session", state: "resumable" },
    controlSequence: 0,
    sessionSequence: 1,
  };
  const agent: AgentControlAgent = {
    id: "agent",
    workspaceId: "workspace",
    computerId: "computer",
    ownerId: "owner",
    visibility: "public",
    runtimeConfig: config,
    state,
  };
  const message: AgentContextUsage = {
    protocolMajor: 1,
    requestId: "context-usage-1",
    workspaceId: "workspace",
    computerId: "computer",
    agentId: "agent",
    provider: "claude-code",
    launchId: "launch-1",
    sessionId: "native-session",
    usedTokens: 27_908,
    windowTokens: 200_000,
    observedAtMs: 1_758_000_000_000,
    daemonInstanceId: "daemon-current",
    clientSeq: 1,
  };
  return { agent, message };
}

test("accepts a matching launch, writes the display snapshot, and publishes it", async () => {
  const { agent, message } = fixture();
  const puts: AgentContextUsage[] = [];
  const published: Array<{ channel: string; data: unknown }> = [];
  const snapshot = {
    protocolMajor: 1 as const,
    workspaceId: "workspace",
    computerId: "computer",
    agentId: "agent",
    revision: 2,
    activityKind: "online" as const,
    detailKind: "",
    detail: "",
    entries: [],
    expiresAt: 1,
    contextUsage: { usedTokens: 27_908, windowTokens: 200_000, observedAtMs: message.observedAtMs },
  };
  const method = createAgentContextUsageMethod(
    { get: async (id) => (id === agent.id ? structuredClone(agent) : undefined) },
    {
      putContextUsage: async (input) => {
        puts.push(input);
        return snapshot;
      },
    },
    {
      publishJson: async (channel, data) => {
        published.push({ channel, data });
      },
    },
    async () => "public",
  );
  const principal = { userId: "owner", workspaceId: "workspace", computerId: "computer" };
  const bytes = encodeAgentContextUsage(message);

  expect(await method(bytes, { principal })).toBeInstanceOf(Uint8Array);

  expect(puts).toEqual([message]);
  expect(published).toEqual([
    { channel: "agent:status:workspace", data: { type: "agent:display", ...snapshot } },
  ]);
});

test("rejects a foreign transport principal and a malformed payload", async () => {
  const { message } = fixture();
  const method = createAgentContextUsageMethod(
    { get: async () => undefined },
    undefined,
    undefined,
    async () => "public",
  );
  const bytes = encodeAgentContextUsage(message);

  expect(
    await method(bytes, {
      principal: {
        userId: "owner",
        workspaceId: "workspace",
        computerId: "computer",
        agentId: "agent",
      },
    }),
  ).toMatchObject({ code: 403 });
  expect(
    await method(bytes, {
      principal: { userId: "owner", workspaceId: "other", computerId: "computer" },
    }),
  ).toMatchObject({ code: 403 });
  expect(
    await method(new Uint8Array([1, 2, 3]), {
      principal: { userId: "owner", workspaceId: "workspace", computerId: "computer" },
    }),
  ).toMatchObject({ code: 400 });
});

test("is an idempotent no-op for a stale launch, unknown Agent, or foreign scope, never calling the display", async () => {
  const { agent, message } = fixture();
  let calls = 0;
  const putContextUsage = async () => {
    calls++;
    return undefined;
  };
  const principal = { userId: "owner", workspaceId: "workspace", computerId: "computer" };

  const staleLaunch = createAgentContextUsageMethod(
    {
      get: async () =>
        structuredClone({ ...agent, state: { ...agent.state!, launchId: "launch-2" } }),
    },
    { putContextUsage },
    undefined,
    async () => "public",
  );
  expect(await staleLaunch(encodeAgentContextUsage(message), { principal })).toBeInstanceOf(
    Uint8Array,
  );

  const unknownAgent = createAgentContextUsageMethod(
    { get: async () => undefined },
    { putContextUsage },
    undefined,
    async () => "public",
  );
  expect(await unknownAgent(encodeAgentContextUsage(message), { principal })).toBeInstanceOf(
    Uint8Array,
  );

  const foreignComputer = createAgentContextUsageMethod(
    { get: async () => structuredClone({ ...agent, computerId: "other-computer" }) },
    { putContextUsage },
    undefined,
    async () => "public",
  );
  expect(await foreignComputer(encodeAgentContextUsage(message), { principal })).toBeInstanceOf(
    Uint8Array,
  );

  const foreignProvider = createAgentContextUsageMethod(
    {
      get: async () =>
        structuredClone({
          ...agent,
          runtimeConfig: { ...agent.runtimeConfig, runtime: "kiro" as const },
        }),
    },
    { putContextUsage },
    undefined,
    async () => "public",
  );
  expect(await foreignProvider(encodeAgentContextUsage(message), { principal })).toBeInstanceOf(
    Uint8Array,
  );

  const noControlState = createAgentContextUsageMethod(
    { get: async () => structuredClone({ ...agent, state: null }) },
    { putContextUsage },
    undefined,
    async () => "public",
  );
  expect(await noControlState(encodeAgentContextUsage(message), { principal })).toBeInstanceOf(
    Uint8Array,
  );

  expect(calls).toBe(0);
});

// The reading is a display fact like any other `agent:display` push, so it follows the
// same per-Agent-or-shared status channel split the sweep and publish proxy use.
test("routes the display snapshot to a private Agent's per-Agent status channel", async () => {
  const { agent, message } = fixture();
  const published: Array<{ channel: string; data: unknown }> = [];
  const snapshot = {
    protocolMajor: 1 as const,
    workspaceId: "workspace",
    computerId: "computer",
    agentId: "agent",
    revision: 2,
    activityKind: "online" as const,
    detailKind: "",
    detail: "",
    entries: [],
    expiresAt: 1,
    contextUsage: { usedTokens: 27_908, windowTokens: 200_000, observedAtMs: message.observedAtMs },
  };
  const method = createAgentContextUsageMethod(
    { get: async (id) => (id === agent.id ? structuredClone(agent) : undefined) },
    { putContextUsage: async () => snapshot },
    { publishJson: async (channel, data) => void published.push({ channel, data }) },
    async () => "private",
  );
  const principal = { userId: "owner", workspaceId: "workspace", computerId: "computer" };

  expect(await method(encodeAgentContextUsage(message), { principal })).toBeInstanceOf(Uint8Array);

  expect(published).toEqual([
    { channel: "agent:status:workspace:agent", data: { type: "agent:display", ...snapshot } },
  ]);
});

test("keeps the shared status channel when the visibility dependency resolves public", async () => {
  const { agent, message } = fixture();
  const published: Array<{ channel: string }> = [];
  const method = createAgentContextUsageMethod(
    { get: async () => structuredClone(agent) },
    {
      putContextUsage: async () => ({
        protocolMajor: 1 as const,
        workspaceId: "workspace",
        computerId: "computer",
        agentId: "agent",
        revision: 2,
        activityKind: "online" as const,
        detailKind: "",
        detail: "",
        entries: [],
        expiresAt: 1,
      }),
    },
    { publishJson: async (channel) => void published.push({ channel }) },
    async () => "public",
  );
  const principal = { userId: "owner", workspaceId: "workspace", computerId: "computer" };

  await method(encodeAgentContextUsage(message), { principal });

  expect(published).toEqual([{ channel: "agent:status:workspace" }]);
});

// `agentVisibility` is a required dependency (no `?`): a lookup that cannot answer the
// visibility question must not silently fall back to publishing on the shared channel.
test("skips the display publish when the visibility lookup finds nothing to route by (fail closed)", async () => {
  const { agent, message } = fixture();
  const published: Array<{ channel: string }> = [];
  const method = createAgentContextUsageMethod(
    { get: async () => structuredClone(agent) },
    {
      putContextUsage: async () => ({
        protocolMajor: 1 as const,
        workspaceId: "workspace",
        computerId: "computer",
        agentId: "agent",
        revision: 2,
        activityKind: "online" as const,
        detailKind: "",
        detail: "",
        entries: [],
        expiresAt: 1,
      }),
    },
    { publishJson: async (channel) => void published.push({ channel }) },
    async () => undefined,
  );
  const principal = { userId: "owner", workspaceId: "workspace", computerId: "computer" };

  expect(await method(encodeAgentContextUsage(message), { principal })).toBeInstanceOf(Uint8Array);
  expect(published).toHaveLength(0);
});

test("propagates a genuine store failure as a logged 403, not a silent no-op", async () => {
  const { message } = fixture();
  const method = createAgentContextUsageMethod(
    {
      get: async () => {
        throw new Error("database unavailable");
      },
    },
    undefined,
    undefined,
    async () => "public",
  );
  const principal = { userId: "owner", workspaceId: "workspace", computerId: "computer" };

  expect(await method(encodeAgentContextUsage(message), { principal })).toMatchObject({
    code: 403,
  });
});
