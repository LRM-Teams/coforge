import { expect, test } from "bun:test";
import {
  AgentControl,
  agentControlRevision,
  type AgentControlAgent,
  type AgentControlStore,
} from "../src/server/agents/agent-control.server";
import { AgentSessionReceiver } from "../src/server/agents/agent-session.server";
import {
  AgentSessions,
  type RuntimeSessionReference,
} from "../src/server/agents/agent-sessions.server";
import {
  decodeAgentStartIntent,
  decodeAgentStopIntent,
  decodeAgentWorkspaceResetRequest,
} from "@lrm/coforge-sdk/internal";
import { isAppError } from "../src/lib/app-error";
import type { WorkspaceMemberRole } from "../src/server/workspaces/member-role.server";

function observationRace() {
  const runtimeConfig = {
    runtime: "pi" as const,
    provider: { kind: "default" as const },
    model: "original-model",
    modelProvider: "anthropic",
    reasoning: "high",
  };
  const scope = {
    protocolMajor: 1,
    workspaceId: "w",
    computerId: "c",
    agentId: "a",
    provider: "pi" as const,
    requestId: "original",
    epoch: 7,
    launchId: "launch",
  };
  let reference: RuntimeSessionReference = {
    provider: "pi",
    computerId: "c",
    startRequestId: "original",
    daemonInstanceId: "daemon",
    launchId: "launch",
    sessionMode: "create",
    sessionId: "native",
    state: "empty",
  };
  const fixture = {
    agent: {
      id: "a",
      ownerId: "owner",
      workspaceId: "w",
      computerId: "c",
      runtimeConfig,
      storedRuntimeConfig: { ...runtimeConfig, env: { FIRST: "one", SECOND: "two" } },
      storedRuntimeSession: reference,
      currentSessionId: "session-row",
      identity: { sessionId: "native", state: "empty" },
      state: {
        ...scope,
        version: 1,
        action: "start",
        phase: "completed",
        configRevision: agentControlRevision(runtimeConfig),
        controlSequence: 1,
        sessionSequence: 0,
        identity: { sessionId: "native", state: "empty" },
      },
    } as AgentControlAgent,
    authorized: true,
    attempts: 0,
    events: [] as string[],
    beforeReplace: async () => {},
  };
  const store: AgentControlStore = {
    memberRole: async () => "owner",
    get: async () => (fixture.authorized ? structuredClone(fixture.agent) : undefined),
    replace: async (before, state) => {
      if (state.requestId === "config-stop" && state.phase === "stopping") {
        fixture.attempts++;
        await fixture.beforeReplace();
      }
      if (!fixture.authorized || JSON.stringify(before) !== JSON.stringify(fixture.agent))
        return false;
      fixture.agent = { ...fixture.agent, state, identity: state.identity };
      return true;
    },
  };
  const sessions = new AgentSessions(
    {
      read: async () => ({ workspaceId: "w", computerId: "c", provider: "pi", reference }),
      replace: async (_id, _old, next) => {
        reference = next;
        const identity = { sessionId: next.sessionId!, state: next.state! };
        fixture.agent = {
          ...fixture.agent,
          storedRuntimeSession: next,
          identity,
          state: { ...fixture.agent.state!, identity },
        };
        return true;
      },
    },
    async () => "daemon",
  );
  const control = new AgentControl(
    store,
    {
      publish: async (_channel, bytes) => {
        const stop = decodeAgentStopIntent(bytes);
        expect(stop).toMatchObject({ requestId: "config-stop", controlEpoch: 8 });
        expect(fixture.agent.state?.identity).toEqual({ sessionId: "native", state: "resumable" });
        fixture.events.push("stop-published");
        await control.result(stop, {
          ...stop,
          provider: stop.provider!,
          epoch: stop.controlEpoch!,
          phase: "stopped",
          sequence: 1,
        });
        fixture.events.push("stop-acknowledged");
      },
    },
    { run: async (_id, work) => work() },
  );
  return {
    fixture,
    snapshot: (sequence: number) =>
      new AgentSessionReceiver(store, async () => "daemon").accept(scope, {
        ...scope,
        sequence,
        identity: { sessionId: "native", state: "resumable" },
      }),
    observe: () =>
      sessions.accept({
        ...scope,
        startRequestId: "original",
        controlEpoch: 7,
        daemonInstanceId: "daemon",
        sessionId: "native",
        sessionState: "resumable",
      }),
    stop: () =>
      control.publishStop({ agentId: "a", workspaceId: "w", requestId: "config-stop" }, "owner"),
  };
}

test("configuration stop retries a Session observation race before allowing the config write", async () => {
  const { fixture, observe, stop } = observationRace();
  fixture.beforeReplace = async () => {
    if (fixture.attempts === 1) await observe();
  };
  await stop();
  fixture.events.push("config-write");
  expect(fixture.attempts).toBe(2);
  expect(fixture.events).toEqual(["stop-published", "stop-acknowledged", "config-write"]);
  expect(fixture.agent.state).toMatchObject({
    epoch: 8,
    phase: "completed",
    identity: { state: "resumable" },
  });
});

test("configuration stop compares persisted config semantically after an observation", async () => {
  const { fixture, observe, stop } = observationRace();
  fixture.beforeReplace = async () => {
    if (fixture.attempts !== 1) return;
    await observe();
    fixture.agent.storedRuntimeConfig = {
      env: { SECOND: "two", FIRST: "one" },
      ...fixture.agent.runtimeConfig,
    };
  };
  await stop();
  expect(fixture.attempts).toBe(2);
});

test.each([
  "owner",
  "workspace",
  "computer",
  "runtime",
  "stored config",
  "credential",
  "request",
  "epoch",
  "phase",
  "action",
  "launch",
  "control sequence",
  "authorization",
] as const)("configuration stop rejects intervening %s changes", async (change) => {
  const { fixture, observe, stop } = observationRace();
  fixture.beforeReplace = async () => {
    await observe();
    const agent = fixture.agent;
    switch (change) {
      case "owner":
        agent.ownerId = "another-owner";
        break;
      case "workspace":
        agent.workspaceId = "another-workspace";
        break;
      case "computer":
        agent.computerId = "another-computer";
        break;
      case "runtime":
        agent.runtimeConfig = { ...agent.runtimeConfig, model: "new-model" };
        break;
      case "stored config":
        agent.storedRuntimeConfig = {
          ...agent.runtimeConfig,
          env: { FIRST: "changed", SECOND: "two" },
        };
        break;
      case "credential":
        agent.storedRuntimeConfig = {
          ...agent.runtimeConfig,
          provider: { kind: "coforge", providerId: "anthropic", apiKey: { ciphertext: "changed" } },
        };
        break;
      case "request":
        agent.state!.requestId = "competitor";
        break;
      case "epoch":
        agent.state!.epoch++;
        break;
      case "phase":
        agent.state!.phase = "failed";
        break;
      case "action":
        agent.state!.action = "full-reset";
        break;
      case "launch":
        agent.state!.launchId = "another-launch";
        break;
      case "control sequence":
        agent.state!.controlSequence++;
        break;
      case "authorization":
        fixture.authorized = false;
        break;
    }
  };
  await expect(stop()).rejects.toThrow(
    ["owner", "workspace", "authorization"].includes(change)
      ? "Agent is not authorized or assigned"
      : "Agent configuration or control operation changed",
  );
  expect(fixture.attempts).toBe(1);
  expect(fixture.events).toEqual([]);
  expect(fixture.agent.state?.requestId).not.toBe("config-stop");
});

test.each([2, 3])(
  "configuration stop bounds contention after %i observation races",
  async (races) => {
    const { fixture, snapshot, stop } = observationRace();
    fixture.beforeReplace = async () => {
      if (fixture.attempts > races) return;
      await snapshot(fixture.attempts);
    };
    if (races === 2) {
      await stop();
      expect(fixture.agent.state?.phase).toBe("completed");
    } else {
      await expect(stop()).rejects.toThrow(
        "Agent control could not begin after 3 compare-and-swap attempts",
      );
      expect(fixture.agent.state?.requestId).toBe("original");
      expect(fixture.events).toEqual([]);
    }
    expect(fixture.attempts).toBe(3);
  },
);

test("reset is one confirmed-stop then fresh-start operation and retains no old binding", async () => {
  let agent: AgentControlAgent = {
    id: "agent-a",
    workspaceId: "workspace-a",
    computerId: "computer-a",
    ownerId: "owner-a",
    runtimeConfig: {
      runtime: "pi",
      provider: { kind: "default" },
      model: "",
      modelProvider: "",
      reasoning: "",
    },
    state: null,
  };
  const store: AgentControlStore = {
    memberRole: async () => "owner",
    async get() {
      return structuredClone(agent);
    },
    async replace(before, state) {
      if (JSON.stringify(before.state) !== JSON.stringify(agent.state)) return false;
      agent = { ...agent, state };
      return true;
    },
  };
  const events: string[] = [];
  const control = new AgentControl(
    store,
    {
      async publish(_channel, bytes) {
        let stop;
        try {
          stop = decodeAgentStopIntent(bytes);
        } catch {
          /* Continue through the other valid primitive envelopes. */
        }
        if (stop) {
          events.push("stop");
          expect(stop).toMatchObject({ provider: "pi", controlEpoch: 1 });
          await control.result(stop, {
            ...stop,
            provider: stop.provider!,
            epoch: stop.controlEpoch!,
            phase: "stopped",
            sequence: 1,
          });
          return;
        }
        const start = decodeAgentStartIntent(bytes);
        events.push("start");
        expect(start.sessionId).toBeUndefined();
        expect(start.controlEpoch).toBe(1);
        const launchId = "launch-a";
        await control.authorizeLaunch({ ...start, launchId, controlEpoch: start.controlEpoch! });
        await control.result(start, {
          ...start,
          epoch: start.controlEpoch!,
          launchId,
          phase: "started",
          sequence: 2,
          identity: { sessionId: "new-native-id", state: "empty" },
        });
      },
    },
    { run: async (_id, work) => work() },
    { timeoutMs: 1, fallbackMs: 0 },
  );
  const input = {
    userId: "owner-a",
    workspaceId: "workspace-a",
    agentId: "agent-a",
    requestId: "request-a",
    action: "reset-session" as const,
  };
  const result = await control.execute(input);
  expect(result).toMatchObject({ phase: "completed" });
  expect(events).toEqual(["stop", "start"]);
  expect(await control.execute(input)).toMatchObject({ phase: "completed" });
  expect(events).toHaveLength(2);
  expect(JSON.stringify(result)).not.toContain("new-native-id");
});

test.each([undefined, "pi", "codex", "claude-code", "coforge"] as const)(
  "unknown or empty %s session starts fresh without a recovery error",
  async (provider) => {
    let agent: AgentControlAgent = {
      id: "agent-a",
      workspaceId: "workspace-a",
      computerId: "computer-a",
      ownerId: "owner-a",
      runtimeConfig: {
        runtime: provider ?? "pi",
        provider: { kind: "default" },
        model: "",
        modelProvider: "",
        reasoning: "",
      },
      state: null,
    };
    const store: AgentControlStore = {
      memberRole: async () => "owner",
      async get() {
        return structuredClone(agent);
      },
      async replace(before, state) {
        if (JSON.stringify(before.state) !== JSON.stringify(agent.state)) return false;
        agent = { ...agent, state };
        return true;
      },
    };
    const control = new AgentControl(
      store,
      {
        async publish(_channel, bytes) {
          try {
            const stop = decodeAgentStopIntent(bytes);
            await control.result(stop, {
              ...stop,
              provider: stop.provider!,
              epoch: stop.controlEpoch!,
              phase: "stopped",
              sequence: 1,
              ...(provider
                ? { identity: { sessionId: "empty-old", state: "empty" as const } }
                : {}),
            });
          } catch {
            const start = decodeAgentStartIntent(bytes);
            expect(start.sessionId).toBeUndefined();
            await control.authorizeLaunch({ ...start, launchId: "launch-a" });
            await control.result(start, {
              ...start,
              epoch: start.controlEpoch!,
              launchId: "launch-a",
              phase: "started",
              sequence: 2,
              identity: { sessionId: "fresh", state: "empty" },
            });
          }
        },
      },
      { run: async (_id, work) => work() },
      { timeoutMs: 1, fallbackMs: 0 },
    );

    expect(
      await control.execute({
        userId: "owner-a",
        workspaceId: "workspace-a",
        agentId: "agent-a",
        requestId: "request-a",
        action: "restart",
      }),
    ).toEqual({ requestId: "request-a", action: "restart", phase: "completed" });
  },
);

test("a Session snapshot cannot complete control, and recovered identity binds only once even before started", async () => {
  const config = {
    runtime: "pi" as const,
    provider: { kind: "default" as const },
    model: "",
    modelProvider: "",
    reasoning: "",
  };
  let agent: AgentControlAgent = {
    id: "agent-a",
    workspaceId: "workspace-a",
    computerId: "computer-a",
    ownerId: "owner-a",
    runtimeConfig: config,
    state: {
      version: 1,
      protocolMajor: 1,
      requestId: "request-a",
      workspaceId: "workspace-a",
      computerId: "computer-a",
      agentId: "agent-a",
      provider: "pi",
      epoch: 3,
      action: "start",
      phase: "starting",
      configRevision: new Bun.CryptoHasher("sha256").update(JSON.stringify(config)).digest("hex"),
      launchId: "launch-a",
      identity: { sessionId: "old-native", state: "resumable" },
      controlSequence: 0,
      sessionSequence: 0,
    },
  };
  const store: AgentControlStore = {
    memberRole: async () => "owner",
    async get() {
      return structuredClone(agent);
    },
    async replace(before, state) {
      if (JSON.stringify(before.state) !== JSON.stringify(agent.state)) return false;
      agent = { ...agent, state };
      return true;
    },
  };
  const control = new AgentControl(
    store,
    { publish: async () => {} },
    { run: async (_id, work) => work() },
  );
  const sessions = new AgentSessionReceiver(store, async () => "daemon");
  const scope = {
    protocolMajor: 1 as const,
    requestId: "request-a",
    workspaceId: "workspace-a",
    computerId: "computer-a",
    agentId: "agent-a",
    provider: "pi" as const,
    epoch: 3,
    launchId: "launch-a",
  };

  await sessions.accept(scope, {
    ...scope,
    sequence: 2,
    identity: { sessionId: "recovered-native", state: "resumable" },
  });
  expect(agent.state?.phase).toBe("starting");
  expect(agent.state?.controlSequence).toBe(0);
  await control.result(scope, {
    ...scope,
    sequence: 1,
    phase: "started",
    identity: { sessionId: "recovered-native", state: "empty" },
  });
  expect(agent.state?.identity?.state).toBe("resumable");
  expect(agent.state).toMatchObject({ phase: "completed", recovered: true });
  await expect(
    sessions.accept(scope, {
      ...scope,
      sequence: 3,
      identity: { sessionId: "changed-again", state: "resumable" },
    }),
  ).rejects.toThrow("changed during launch");
});

test("start wakes retain the completed launch fence while ready recovery creates a new launch", async () => {
  const runtimeConfig = {
    runtime: "pi" as const,
    provider: { kind: "default" as const },
    model: "",
    modelProvider: "",
    reasoning: "",
  };
  const scope = {
    protocolMajor: 1,
    requestId: "original",
    workspaceId: "w",
    computerId: "c",
    agentId: "a",
    provider: "pi" as const,
    epoch: 1,
  };
  let agent: AgentControlAgent = {
    id: "a",
    ownerId: "owner",
    workspaceId: "w",
    computerId: "c",
    runtimeConfig,
    state: {
      ...scope,
      version: 1,
      action: "restart",
      phase: "completed",
      launchId: "launch",
      configRevision: agentControlRevision(runtimeConfig),
      controlSequence: 2,
      sessionSequence: 3,
      identity: { sessionId: "native", state: "resumable" },
    },
  };
  const published: ReturnType<typeof decodeAgentStartIntent>[] = [];
  const control = new AgentControl(
    {
      get: async () => structuredClone(agent),
      replace: async (_before, state) => {
        agent = { ...agent, state };
        return true;
      },
      memberRole: async () => "owner",
    },
    {
      publish: async (_channel, bytes) => {
        published.push(decodeAgentStartIntent(bytes));
      },
    },
    { run: async (_id, work) => work() },
  );
  const intent = { ...scope, requestId: "wake", model: "", reasoning: "" };
  await control.publishStart(intent, "owner");
  expect(published).toHaveLength(1);
  expect(published[0]).toMatchObject({
    requestId: "original",
    controlEpoch: 1,
    sessionId: "native",
  });
  expect(agent.state?.phase).toBe("completed");
  await control.recover({ ...intent, requestId: "recovery" }, "owner");
  expect(published[1]).toMatchObject({
    requestId: "recovery",
    controlEpoch: 2,
    sessionId: "native",
  });
  expect(agent.state?.phase).toBe("starting");
});

test("Full Reset halts on a terminal failure and a competing action while pending is still rejected", async () => {
  let agent: AgentControlAgent = {
    id: "a",
    ownerId: "owner",
    workspaceId: "w",
    computerId: "c",
    runtimeConfig: {
      runtime: "pi",
      provider: { kind: "default" },
      model: "",
      modelProvider: "",
      reasoning: "",
    },
    state: null,
  };
  const sent: Uint8Array[] = [];
  const store: AgentControlStore = {
    memberRole: async () => "owner",
    get: async () => structuredClone(agent),
    replace: async (before, state) => {
      if (JSON.stringify(before.state) !== JSON.stringify(agent.state)) return false;
      agent = { ...agent, state: structuredClone(state) };
      return true;
    },
  };
  const control = new AgentControl(
    store,
    {
      publish: async (_channel, bytes) => {
        sent.push(bytes);
      },
    },
    { run: async (_id, work) => work() },
    { timeoutMs: 0, fallbackMs: 0 },
  );
  const input = {
    userId: "owner",
    workspaceId: "w",
    agentId: "a",
    requestId: "reset",
    action: "full-reset" as const,
    confirmed: true,
  };
  expect((await control.execute(input)).phase).toBe("pending");
  const stop = decodeAgentStopIntent(sent[0]!);
  const scope = { ...stop, provider: stop.provider!, epoch: stop.controlEpoch! };
  // The pending-operation rule is unchanged: a competing action while an operation is still
  // in flight is rejected.
  await expect(
    control.execute({ ...input, requestId: "competing", action: "restart" }),
  ).rejects.toThrow("pending");
  await control.result(scope, { ...scope, phase: "stopped", sequence: 1 });
  expect(decodeAgentWorkspaceResetRequest(sent[1]!)).toMatchObject({
    requestId: "reset",
    epoch: 1,
  });
  // A legacy daemon (pre this liveness fix) can still report a bare "failed" reset-workspace
  // result; the server keeps that terminal-failure handling.
  await control.result(scope, {
    ...scope,
    phase: "failed",
    sequence: 2,
    errorCode: "workspace_clear_failed",
  });
  expect((await control.execute(input)).phase).toBe("failed");
  expect(sent).toHaveLength(2);
});

test("a failed operation never latches: start, stop, restart, reset-session, and full-reset may all begin right after", async () => {
  function failedFullResetAgent(): {
    agent: AgentControlAgent;
    store: AgentControlStore;
    sent: Uint8Array[];
  } {
    const scope = {
      protocolMajor: 1 as const,
      requestId: "reset",
      workspaceId: "w",
      computerId: "c",
      agentId: "a",
      provider: "pi" as const,
      epoch: 1,
    };
    let agent: AgentControlAgent = {
      id: "a",
      ownerId: "owner",
      workspaceId: "w",
      computerId: "c",
      runtimeConfig: {
        runtime: "pi",
        provider: { kind: "default" },
        model: "",
        modelProvider: "",
        reasoning: "",
      },
      state: {
        ...scope,
        version: 1,
        action: "full-reset",
        phase: "failed",
        configRevision: agentControlRevision({
          runtime: "pi",
          provider: { kind: "default" },
          model: "",
          modelProvider: "",
          reasoning: "",
        }),
        controlSequence: 2,
        sessionSequence: 0,
        errorCode: "workspace_clear_failed",
      },
    };
    const sent: Uint8Array[] = [];
    const store: AgentControlStore = {
      get: async () => structuredClone(agent),
      memberRole: async () => "owner",
      replace: async (before, state) => {
        if (JSON.stringify(before.state) !== JSON.stringify(agent.state)) return false;
        agent = { ...agent, state: structuredClone(state) };
        return true;
      },
    };
    return { agent, store, sent };
  }

  {
    const { store, sent } = failedFullResetAgent();
    const control = new AgentControl(
      store,
      { publish: async (_channel, bytes) => void sent.push(bytes) },
      { run: async (_id, work) => work() },
    );
    await control.publishStart(
      {
        protocolMajor: 1,
        requestId: "s",
        workspaceId: "w",
        computerId: "c",
        agentId: "a",
        provider: "pi",
        model: "",
        reasoning: "",
      },
      "owner",
    );
    expect(sent).toHaveLength(1);
    expect(decodeAgentStartIntent(sent[0]!)).toMatchObject({ requestId: "s" });
  }
  {
    const { store, sent } = failedFullResetAgent();
    const control = new AgentControl(
      store,
      { publish: async (_channel, bytes) => void sent.push(bytes) },
      { run: async (_id, work) => work() },
      { timeoutMs: 0, fallbackMs: 0 },
    );
    // publishStop's begin() now succeeds; only the unrelated drive-timeout rejects.
    await expect(
      control.publishStop({ agentId: "a", workspaceId: "w", requestId: "stop-retry" }, "owner"),
    ).rejects.toThrow("Agent stop has not completed");
    expect(decodeAgentStopIntent(sent[0]!)).toMatchObject({ requestId: "stop-retry" });
  }
  {
    const { store, sent } = failedFullResetAgent();
    const control = new AgentControl(
      store,
      { publish: async (_channel, bytes) => void sent.push(bytes) },
      { run: async (_id, work) => work() },
      { timeoutMs: 0, fallbackMs: 0 },
    );
    expect(
      (
        await control.execute({
          userId: "owner",
          workspaceId: "w",
          agentId: "a",
          requestId: "restart",
          action: "restart",
        })
      ).phase,
    ).toBe("pending");
    expect(decodeAgentStopIntent(sent[0]!)).toMatchObject({ requestId: "restart" });
  }
  {
    const { store, sent } = failedFullResetAgent();
    const control = new AgentControl(
      store,
      { publish: async (_channel, bytes) => void sent.push(bytes) },
      { run: async (_id, work) => work() },
      { timeoutMs: 0, fallbackMs: 0 },
    );
    expect(
      (
        await control.execute({
          userId: "owner",
          workspaceId: "w",
          agentId: "a",
          requestId: "reset-session",
          action: "reset-session",
        })
      ).phase,
    ).toBe("pending");
    expect(decodeAgentStopIntent(sent[0]!)).toMatchObject({ requestId: "reset-session" });
  }
  {
    const { store, sent } = failedFullResetAgent();
    const control = new AgentControl(
      store,
      { publish: async (_channel, bytes) => void sent.push(bytes) },
      { run: async (_id, work) => work() },
      { timeoutMs: 0, fallbackMs: 0 },
    );
    expect(
      (
        await control.execute({
          userId: "owner",
          workspaceId: "w",
          agentId: "a",
          requestId: "retry",
          action: "full-reset",
          confirmed: true,
        })
      ).phase,
    ).toBe("pending");
    expect(decodeAgentStopIntent(sent[0]!)).toMatchObject({ requestId: "retry", controlEpoch: 2 });
  }
  {
    // recover() is the ready-recovery auto-start path; it used to reject outright after a
    // terminal failed full-reset. It now proceeds exactly like every other entry point above.
    const { store, sent } = failedFullResetAgent();
    const control = new AgentControl(
      store,
      { publish: async (_channel, bytes) => void sent.push(bytes) },
      { run: async (_id, work) => work() },
    );
    await control.recover(
      {
        protocolMajor: 1,
        requestId: "ready-recovery",
        workspaceId: "w",
        computerId: "c",
        agentId: "a",
        provider: "pi",
        model: "",
        reasoning: "",
      },
      "owner",
    );
    expect(sent).toHaveLength(1);
    expect(decodeAgentStartIntent(sent[0]!)).toMatchObject({
      requestId: "ready-recovery",
      controlEpoch: 2,
    });
  }
});

test("Full Reset completes when the workspace clear could not finish, and the Agent starts with a fresh session", async () => {
  let agent: AgentControlAgent = {
    id: "a",
    ownerId: "owner",
    workspaceId: "w",
    computerId: "c",
    identity: { sessionId: "old", state: "resumable" },
    runtimeConfig: {
      runtime: "pi",
      provider: { kind: "default" },
      model: "",
      modelProvider: "",
      reasoning: "",
    },
    state: null,
  };
  let allowClear = false;
  const sent: Uint8Array[] = [];
  const store: AgentControlStore = {
    get: async () => structuredClone(agent),
    memberRole: async () => "owner",
    replace: async (before, state, options) => {
      if (JSON.stringify(before.state) !== JSON.stringify(agent.state)) return false;
      if (options?.clearSession && !allowClear) throw new Error("transaction failed");
      agent = { ...agent, state: structuredClone(state), identity: state.identity };
      return true;
    },
  };
  const api = {
    publish: async (_channel: string, bytes: Uint8Array) => {
      sent.push(bytes);
    },
  };
  const lock = { run: async <T>(_id: string, work: () => Promise<T>) => work() };
  allowClear = true;
  const control = new AgentControl(store, api, lock, { timeoutMs: 0, fallbackMs: 0 });
  const input = {
    userId: "owner",
    workspaceId: "w",
    agentId: "a",
    requestId: "reset",
    action: "full-reset" as const,
    confirmed: true,
  };
  await control.execute(input);
  const stop = decodeAgentStopIntent(sent[0]!);
  const scope = { ...stop, provider: stop.provider!, epoch: stop.controlEpoch! };
  await control.result(scope, { ...scope, phase: "stopped", sequence: 1 });
  // The daemon's clear failed, but it is non-fatal (Raft only logs it): the result still
  // carries "workspace-reset", never "failed", and the chain still proceeds.
  await control.result(scope, {
    ...scope,
    phase: "workspace-reset",
    sequence: 2,
  });
  expect(decodeAgentStartIntent(sent[2]!)).toMatchObject({ requestId: "reset", controlEpoch: 1 });
  expect(decodeAgentStartIntent(sent[2]!).sessionId).toBeUndefined();
  expect((await store.get("a"))?.state?.identity).toBeUndefined();
  await control.authorizeLaunch({
    ...scope,
    requestId: "reset",
    launchId: "launch-a",
    controlEpoch: 1,
  });
  await control.result(scope, {
    ...scope,
    phase: "started",
    launchId: "launch-a",
    sequence: 3,
    identity: { sessionId: "new-native-id", state: "empty" },
  });
  const view = await control.execute(input);
  expect(view).toMatchObject({ phase: "completed" });
  expect(view).not.toHaveProperty("warning");
  expect((await store.get("a"))?.state?.identity).toMatchObject({ sessionId: "new-native-id" });
});

test("Clear Session and advancement commit together; recovery retries that step, not workspace deletion", async () => {
  let agent: AgentControlAgent = {
    id: "a",
    ownerId: "owner",
    workspaceId: "w",
    computerId: "c",
    identity: { sessionId: "old", state: "resumable" },
    runtimeConfig: {
      runtime: "pi",
      provider: { kind: "default" },
      model: "",
      modelProvider: "",
      reasoning: "",
    },
    state: null,
  };
  let allowClear = false;
  const sent: Uint8Array[] = [];
  const store: AgentControlStore = {
    memberRole: async () => "owner",
    get: async () => structuredClone(agent),
    replace: async (before, state, options) => {
      if (JSON.stringify(before.state) !== JSON.stringify(agent.state)) return false;
      if (options?.clearSession && !allowClear) throw new Error("transaction failed");
      agent = { ...agent, state: structuredClone(state), identity: state.identity };
      return true;
    },
  };
  const api = {
    publish: async (_channel: string, bytes: Uint8Array) => {
      sent.push(bytes);
    },
  };
  const lock = { run: async <T>(_id: string, work: () => Promise<T>) => work() };
  const control = new AgentControl(store, api, lock, { timeoutMs: 0, fallbackMs: 0 });
  await control.execute({
    userId: "owner",
    workspaceId: "w",
    agentId: "a",
    requestId: "reset",
    action: "full-reset",
    confirmed: true,
  });
  const stop = decodeAgentStopIntent(sent[0]!);
  const scope = { ...stop, provider: stop.provider!, epoch: stop.controlEpoch! };
  await control.result(scope, { ...scope, phase: "stopped", sequence: 1 });
  const resetResult = { ...scope, phase: "workspace-reset" as const, sequence: 2 };
  await control.result(scope, resetResult);
  expect(sent).toHaveLength(2);
  expect((await store.get("a"))?.state).toMatchObject({
    phase: "workspace-reset",
    identity: { sessionId: "old" },
  });
  allowClear = true;
  const recovered = new AgentControl(store, api, lock);
  await recovered.recover({ ...scope, requestId: "ready", model: "", reasoning: "" }, "owner");
  expect(sent).toHaveLength(3);
  expect(decodeAgentStartIntent(sent[2]!)).toMatchObject({ requestId: "reset", controlEpoch: 1 });
  expect(decodeAgentStartIntent(sent[2]!).sessionId).toBeUndefined();
  expect((await store.get("a"))?.state?.identity).toBeUndefined();
  await recovered.result(scope, resetResult);
  expect(sent).toHaveLength(3);
});

test("a signal-driven wakeup trusts the ACK path and never republishes the command it already sent", async () => {
  let agent: AgentControlAgent = {
    id: "agent-a",
    workspaceId: "workspace-a",
    computerId: "computer-a",
    ownerId: "owner-a",
    runtimeConfig: {
      runtime: "pi",
      provider: { kind: "default" },
      model: "",
      modelProvider: "",
      reasoning: "",
    },
    state: null,
  };
  const store: AgentControlStore = {
    memberRole: async () => "owner",
    async get() {
      return structuredClone(agent);
    },
    async replace(before, state) {
      if (JSON.stringify(before.state) !== JSON.stringify(agent.state)) return false;
      agent = { ...agent, state };
      return true;
    },
  };
  const events: string[] = [];
  // Daemon ACKs arrive asynchronously, after the publish returned, like a real RPC round-trip.
  const later = (work: () => Promise<void>) => {
    setTimeout(() => void work().catch((error) => events.push(`error:${error.message}`)), 5);
  };
  const control = new AgentControl(
    store,
    {
      async publish(_channel, bytes) {
        let stop;
        try {
          stop = decodeAgentStopIntent(bytes);
        } catch {
          /* Not a stop intent. */
        }
        if (stop) {
          events.push("stop");
          later(() =>
            control.result(stop, {
              ...stop,
              provider: stop.provider!,
              epoch: stop.controlEpoch!,
              phase: "stopped",
              sequence: 1,
            }),
          );
          return;
        }
        const start = decodeAgentStartIntent(bytes);
        events.push("start");
        later(async () => {
          const launchId = "launch-a";
          await control.authorizeLaunch({ ...start, launchId, controlEpoch: start.controlEpoch! });
          await control.result(start, {
            ...start,
            epoch: start.controlEpoch!,
            launchId,
            phase: "started",
            sequence: 2,
            identity: { sessionId: "native-a", state: "resumable" },
          });
        });
      },
    },
    { run: async (_id, work) => work() },
    { timeoutMs: 5_000, fallbackMs: 2_000 },
  );
  const started = Date.now();
  const result = await control.execute({
    userId: "owner-a",
    workspaceId: "workspace-a",
    agentId: "agent-a",
    requestId: "restart-1",
    action: "restart",
  });
  expect(result.phase).toBe("completed");
  // Each command is published exactly once: the ACK handler's advance() sent the start.
  expect(events).toEqual(["stop", "start"]);
  // Completion came from the signal, well inside the 2s fallback re-read.
  expect(Date.now() - started).toBeLessThan(1_000);
});

/**
 * execute()'s Raft capability authorization (`controlAgentRuntime` for Restart/Reset session,
 * held by any current Workspace member; `resetAgentWorkspace` for Full Reset, owner/admin only).
 * Unlike the fixtures above, the actor here is never the Agent's own owner.
 */
function executeAuthorizationFixture(options: {
  ownerId: string;
  role: WorkspaceMemberRole | undefined;
  stoppedAt?: Date;
}) {
  let agent: AgentControlAgent = {
    id: "a",
    ownerId: options.ownerId,
    workspaceId: "w",
    computerId: "c",
    runtimeConfig: {
      runtime: "pi",
      provider: { kind: "default" },
      model: "",
      modelProvider: "",
      reasoning: "",
    },
    state: null,
    ...(options.stoppedAt ? { stoppedAt: options.stoppedAt } : {}),
  };
  const sent: Uint8Array[] = [];
  const store: AgentControlStore = {
    memberRole: async () => options.role,
    get: async () => structuredClone(agent),
    replace: async (before, state, replaceOptions) => {
      if (JSON.stringify(before.state) !== JSON.stringify(agent.state)) return false;
      agent = {
        ...agent,
        state: structuredClone(state),
        ...(replaceOptions?.stoppedAt !== undefined ? { stoppedAt: replaceOptions.stoppedAt } : {}),
      };
      return true;
    },
  };
  const control = new AgentControl(
    store,
    {
      publish: async (_channel, bytes) => {
        sent.push(bytes);
      },
    },
    { run: async (_id, work) => work() },
    { timeoutMs: 0, fallbackMs: 0 },
  );
  return { control, sent, current: () => agent };
}

test("a Workspace member who does not own the Agent can Restart and Reset session", async () => {
  const restart = executeAuthorizationFixture({ ownerId: "owner-user", role: "member" });
  await expect(
    restart.control.execute({
      userId: "member-user",
      workspaceId: "w",
      agentId: "a",
      requestId: "restart-req",
      action: "restart",
    }),
  ).resolves.toMatchObject({ phase: "pending" });

  const reset = executeAuthorizationFixture({ ownerId: "owner-user", role: "member" });
  await expect(
    reset.control.execute({
      userId: "member-user",
      workspaceId: "w",
      agentId: "a",
      requestId: "reset-req",
      action: "reset-session",
    }),
  ).resolves.toMatchObject({ phase: "pending" });
});

test("a Workspace member who does not own the Agent cannot Full Reset it", async () => {
  const { control } = executeAuthorizationFixture({ ownerId: "owner-user", role: "member" });
  const error = await control
    .execute({
      userId: "member-user",
      workspaceId: "w",
      agentId: "a",
      requestId: "full-reset-req",
      action: "full-reset",
      confirmed: true,
    })
    .catch((cause: unknown) => cause);
  expect(isAppError(error) && error.code).toBe("ACCESS_DENIED");
});

test("the Agent's own owner cannot Full Reset it while only a plain Workspace member (deliberate Raft alignment)", async () => {
  const { control } = executeAuthorizationFixture({ ownerId: "owner-user", role: "member" });
  const error = await control
    .execute({
      userId: "owner-user",
      workspaceId: "w",
      agentId: "a",
      requestId: "full-reset-req",
      action: "full-reset",
      confirmed: true,
    })
    .catch((cause: unknown) => cause);
  expect(isAppError(error) && error.code).toBe("ACCESS_DENIED");
});

test("a Workspace admin who does not own the Agent can Full Reset it", async () => {
  const { control, sent } = executeAuthorizationFixture({ ownerId: "owner-user", role: "admin" });
  await expect(
    control.execute({
      userId: "admin-user",
      workspaceId: "w",
      agentId: "a",
      requestId: "full-reset-req",
      action: "full-reset",
      confirmed: true,
    }),
  ).resolves.toMatchObject({ phase: "pending" });
  expect(decodeAgentStopIntent(sent[0]!)).toMatchObject({ requestId: "full-reset-req" });
});

test("a user with no current Workspace membership is rejected", async () => {
  const { control } = executeAuthorizationFixture({ ownerId: "owner-user", role: undefined });
  await expect(
    control.execute({
      userId: "outsider",
      workspaceId: "w",
      agentId: "a",
      requestId: "req",
      action: "restart",
    }),
  ).rejects.toThrow("Agent is not authorized or assigned");
});

test("recover/publishStart/publishStop stay owner-authorized and ignore Workspace capability", async () => {
  // The store reports no Workspace membership at all; execute() would reject this actor, but
  // the internal/system paths key off Agent ownership, never memberRole().
  const { control, sent } = executeAuthorizationFixture({
    ownerId: "owner-user",
    role: undefined,
  });
  await control.publishStart(
    {
      protocolMajor: 1,
      requestId: "start-req",
      workspaceId: "w",
      computerId: "c",
      agentId: "a",
      provider: "pi",
      model: "",
      reasoning: "",
    },
    "owner-user",
  );
  expect(sent).toHaveLength(1);
  await expect(
    control.publishStart(
      {
        protocolMajor: 1,
        requestId: "start-req-2",
        workspaceId: "w",
        computerId: "c",
        agentId: "a",
        provider: "pi",
        model: "",
        reasoning: "",
      },
      "someone-else",
    ),
  ).rejects.toThrow("Agent is not authorized or assigned");
});

// --- Abandoned pending operation supersede (ADR 0035) -----------------------------------------

const abandonRuntimeConfig = {
  runtime: "pi" as const,
  provider: { kind: "default" as const },
  model: "",
  modelProvider: "",
  reasoning: "",
};

/** A CAS-fenced store identical in spirit to the other hand-rolled stores in this file, factored
 * out because every abandonment test below starts from a hand-built `AgentControlState`. */
function abandonStore(initial: AgentControlAgent) {
  let agent = initial;
  const store: AgentControlStore = {
    memberRole: async () => "owner",
    get: async () => structuredClone(agent),
    replace: async (before, state) => {
      if (JSON.stringify(before.state) !== JSON.stringify(agent.state)) return false;
      agent = { ...agent, state };
      return true;
    },
  };
  return { store, current: () => agent };
}

function captureWarnings() {
  const warnings: unknown[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(JSON.parse(args[0] as string));
  return {
    warnings,
    restore: () => {
      console.warn = original;
    },
  };
}

test("a legacy pending state with no updatedAtMs is treated as abandoned and superseded", async () => {
  const { store, current } = abandonStore({
    id: "a",
    ownerId: "owner",
    workspaceId: "w",
    computerId: "c",
    runtimeConfig: abandonRuntimeConfig,
    state: {
      version: 1,
      protocolMajor: 1,
      requestId: "stuck",
      workspaceId: "w",
      computerId: "c",
      agentId: "a",
      provider: "pi",
      epoch: 9,
      action: "start",
      phase: "starting",
      configRevision: agentControlRevision(abandonRuntimeConfig),
      controlSequence: 0,
      sessionSequence: 0,
      // No updatedAtMs: a row persisted before this field existed.
    },
  });
  const sent: Uint8Array[] = [];
  const capture = captureWarnings();
  try {
    const control = new AgentControl(
      store,
      { publish: async (_channel, bytes) => void sent.push(bytes) },
      { run: async (_id, work) => work() },
      { timeoutMs: 0, fallbackMs: 0 },
    );
    const result = await control.execute({
      userId: "owner",
      workspaceId: "w",
      agentId: "a",
      requestId: "restart-1",
      action: "restart",
    });
    expect(result.phase).toBe("pending");
  } finally {
    capture.restore();
  }
  expect(current().state).toMatchObject({ epoch: 10, action: "restart", phase: "stopping" });
  expect(sent).toHaveLength(1);
  expect(decodeAgentStopIntent(sent[0]!)).toMatchObject({
    requestId: "restart-1",
    controlEpoch: 10,
  });
  expect(capture.warnings).toEqual([
    {
      event: "agent_control:pending_superseded",
      agent_id: "a",
      previous_action: "start",
      previous_phase: "starting",
      previous_epoch: 9,
      age_ms: "unknown",
      new_action: "restart",
    },
  ]);
});

test("a fresh pending operation still blocks a new one even past a short abandon window", async () => {
  let now = 1_000_000;
  const { store } = abandonStore({
    id: "a",
    ownerId: "owner",
    workspaceId: "w",
    computerId: "c",
    runtimeConfig: abandonRuntimeConfig,
    state: {
      version: 1,
      protocolMajor: 1,
      requestId: "current",
      workspaceId: "w",
      computerId: "c",
      agentId: "a",
      provider: "pi",
      epoch: 3,
      action: "start",
      phase: "starting",
      configRevision: agentControlRevision(abandonRuntimeConfig),
      controlSequence: 0,
      sessionSequence: 0,
      updatedAtMs: now - 1_000,
    },
  });
  const control = new AgentControl(
    store,
    { publish: async () => {} },
    { run: async (_id, work) => work() },
    { timeoutMs: 0, fallbackMs: 0, abandonAfterMs: 60_000, now: () => now },
  );
  await expect(
    control.execute({
      userId: "owner",
      workspaceId: "w",
      agentId: "a",
      requestId: "new",
      action: "restart",
    }),
  ).rejects.toThrow("Agent control operation is pending");
});

test("a pending operation older than abandonAfterMs is superseded", async () => {
  let now = 1_000_000;
  const { store, current } = abandonStore({
    id: "a",
    ownerId: "owner",
    workspaceId: "w",
    computerId: "c",
    runtimeConfig: abandonRuntimeConfig,
    state: {
      version: 1,
      protocolMajor: 1,
      requestId: "current",
      workspaceId: "w",
      computerId: "c",
      agentId: "a",
      provider: "pi",
      epoch: 3,
      action: "start",
      phase: "starting",
      configRevision: agentControlRevision(abandonRuntimeConfig),
      controlSequence: 0,
      sessionSequence: 0,
      updatedAtMs: now - 61_000,
    },
  });
  const capture = captureWarnings();
  try {
    const control = new AgentControl(
      store,
      { publish: async () => {} },
      { run: async (_id, work) => work() },
      { timeoutMs: 0, fallbackMs: 0, abandonAfterMs: 60_000, now: () => now },
    );
    const result = await control.execute({
      userId: "owner",
      workspaceId: "w",
      agentId: "a",
      requestId: "new",
      action: "restart",
    });
    expect(result.phase).toBe("pending");
  } finally {
    capture.restore();
  }
  expect(current().state).toMatchObject({ epoch: 4, action: "restart" });
  expect(capture.warnings).toEqual([
    expect.objectContaining({ event: "agent_control:pending_superseded", age_ms: 61_000 }),
  ]);
});

/** Builds a hand-built abandoned (no `updatedAtMs`) pending Full Reset state at a given phase,
 * for the tests below: ADR 0036 removed the earlier full-reset-only "yields only to a new
 * full-reset" exception (ADR 0035), so an abandoned Full Reset is now superseded exactly like
 * any other abandoned operation, at every phase its chain can be caught in. */
function abandonedFullResetFixture(phase: "stopping" | "clearing" | "starting") {
  return abandonStore({
    id: "a",
    ownerId: "owner",
    workspaceId: "w",
    computerId: "c",
    runtimeConfig: abandonRuntimeConfig,
    state: {
      version: 1,
      protocolMajor: 1,
      requestId: "stuck-reset",
      workspaceId: "w",
      computerId: "c",
      agentId: "a",
      provider: "pi",
      epoch: 2,
      action: "full-reset",
      phase,
      configRevision: agentControlRevision(abandonRuntimeConfig),
      controlSequence: 0,
      sessionSequence: 0,
      // No updatedAtMs: abandoned regardless of `abandonAfterMs`.
    },
  });
}

test.each(["stopping", "clearing", "starting"] as const)(
  "an abandoned pending Full Reset in %s yields to any competing action, exactly like every other abandoned operation",
  async (phase) => {
    const supersedeLog = (newAction: string) =>
      expect.objectContaining({
        event: "agent_control:pending_superseded",
        agent_id: "a",
        previous_action: "full-reset",
        previous_phase: phase,
        previous_epoch: 2,
        new_action: newAction,
      });

    // restart (execute())
    {
      const { store, current } = abandonedFullResetFixture(phase);
      const capture = captureWarnings();
      const control = new AgentControl(
        store,
        { publish: async () => {} },
        { run: async (_id, work) => work() },
        { timeoutMs: 0, fallbackMs: 0 },
      );
      try {
        const result = await control.execute({
          userId: "owner",
          workspaceId: "w",
          agentId: "a",
          requestId: "restart-attempt",
          action: "restart",
        });
        expect(result.phase).toBe("pending");
      } finally {
        capture.restore();
      }
      expect(current().state).toMatchObject({
        requestId: "restart-attempt",
        epoch: 3,
        action: "restart",
      });
      expect(capture.warnings).toEqual([supersedeLog("restart")]);
    }

    // reset-session (execute())
    {
      const { store, current } = abandonedFullResetFixture(phase);
      const capture = captureWarnings();
      const control = new AgentControl(
        store,
        { publish: async () => {} },
        { run: async (_id, work) => work() },
        { timeoutMs: 0, fallbackMs: 0 },
      );
      try {
        const result = await control.execute({
          userId: "owner",
          workspaceId: "w",
          agentId: "a",
          requestId: "reset-session-attempt",
          action: "reset-session",
        });
        expect(result.phase).toBe("pending");
      } finally {
        capture.restore();
      }
      expect(current().state).toMatchObject({
        requestId: "reset-session-attempt",
        epoch: 3,
        action: "reset-session",
      });
      expect(capture.warnings).toEqual([supersedeLog("reset-session")]);
    }

    // full-reset (execute()) — a fresh, explicitly confirmed Full Reset still supersedes too.
    {
      const { store, current } = abandonedFullResetFixture(phase);
      const capture = captureWarnings();
      const control = new AgentControl(
        store,
        { publish: async () => {} },
        { run: async (_id, work) => work() },
        { timeoutMs: 0, fallbackMs: 0 },
      );
      try {
        const result = await control.execute({
          userId: "owner",
          workspaceId: "w",
          agentId: "a",
          requestId: "full-reset-attempt",
          action: "full-reset",
          confirmed: true,
        });
        expect(result.phase).toBe("pending");
      } finally {
        capture.restore();
      }
      expect(current().state).toMatchObject({
        requestId: "full-reset-attempt",
        epoch: 3,
        action: "full-reset",
      });
      expect(capture.warnings).toEqual([supersedeLog("full-reset")]);
    }

    // stop (publishStop())
    {
      const { store, current } = abandonedFullResetFixture(phase);
      const sent: Uint8Array[] = [];
      const capture = captureWarnings();
      const control = new AgentControl(
        store,
        { publish: async (_channel, bytes) => void sent.push(bytes) },
        { run: async (_id, work) => work() },
        { timeoutMs: 0, fallbackMs: 0 },
      );
      try {
        // No daemon ACK arrives within the 0ms drive window, so publishStop still reports the
        // stop as unconfirmed — but the pending operation was already superseded underneath it.
        await expect(
          control.publishStop(
            { agentId: "a", workspaceId: "w", requestId: "stop-attempt" },
            "owner",
          ),
        ).rejects.toThrow("Agent stop has not completed");
      } finally {
        capture.restore();
      }
      expect(sent).toHaveLength(1);
      expect(decodeAgentStopIntent(sent[0]!)).toMatchObject({
        requestId: "stop-attempt",
        controlEpoch: 3,
      });
      expect(current().state).toMatchObject({
        requestId: "stop-attempt",
        epoch: 3,
        action: "stop",
      });
      expect(capture.warnings).toEqual([supersedeLog("stop")]);
    }

    // start (publishStart())
    {
      const { store, current } = abandonedFullResetFixture(phase);
      const sent: Uint8Array[] = [];
      const capture = captureWarnings();
      const control = new AgentControl(
        store,
        { publish: async (_channel, bytes) => void sent.push(bytes) },
        { run: async (_id, work) => work() },
      );
      try {
        await control.publishStart(
          {
            protocolMajor: 1,
            requestId: "start-attempt",
            workspaceId: "w",
            computerId: "c",
            agentId: "a",
            provider: "pi",
            model: "",
            reasoning: "",
          },
          "owner",
        );
      } finally {
        capture.restore();
      }
      expect(sent).toHaveLength(1);
      expect(decodeAgentStartIntent(sent[0]!)).toMatchObject({
        requestId: "start-attempt",
        controlEpoch: 3,
      });
      expect(current().state).toMatchObject({
        requestId: "start-attempt",
        epoch: 3,
        action: "start",
      });
      expect(capture.warnings).toEqual([supersedeLog("start")]);
    }
  },
);

test("a stale-epoch result after a supersede is rejected and leaves the new epoch unchanged", async () => {
  const { store, current } = abandonStore({
    id: "a",
    ownerId: "owner",
    workspaceId: "w",
    computerId: "c",
    runtimeConfig: abandonRuntimeConfig,
    state: {
      version: 1,
      protocolMajor: 1,
      requestId: "stuck",
      workspaceId: "w",
      computerId: "c",
      agentId: "a",
      provider: "pi",
      epoch: 5,
      action: "start",
      phase: "starting",
      configRevision: agentControlRevision(abandonRuntimeConfig),
      controlSequence: 0,
      sessionSequence: 0,
    },
  });
  const capture = captureWarnings();
  const control = new AgentControl(
    store,
    { publish: async () => {} },
    { run: async (_id, work) => work() },
    { timeoutMs: 0, fallbackMs: 0 },
  );
  await control.execute({
    userId: "owner",
    workspaceId: "w",
    agentId: "a",
    requestId: "retry-1",
    action: "restart",
  });
  capture.restore();
  const beforeResult = current().state;
  expect(beforeResult).toMatchObject({ epoch: 6, requestId: "retry-1" });
  await expect(
    control.result(
      { workspaceId: "w", computerId: "c" },
      {
        protocolMajor: 1,
        requestId: "stuck",
        workspaceId: "w",
        computerId: "c",
        agentId: "a",
        provider: "pi",
        epoch: 5,
        phase: "stopped",
        sequence: 1,
      },
    ),
  ).rejects.toThrow("Stale Agent scope");
  expect(current().state).toEqual(beforeResult);
});

test("recover republishes an abandoned pending start unchanged, without refreshing updatedAtMs", async () => {
  const { store, current } = abandonStore({
    id: "a",
    ownerId: "owner",
    workspaceId: "w",
    computerId: "c",
    runtimeConfig: abandonRuntimeConfig,
    state: {
      version: 1,
      protocolMajor: 1,
      requestId: "stuck-start",
      workspaceId: "w",
      computerId: "c",
      agentId: "a",
      provider: "pi",
      epoch: 9,
      action: "start",
      phase: "starting",
      configRevision: agentControlRevision(abandonRuntimeConfig),
      controlSequence: 0,
      sessionSequence: 0,
      // No updatedAtMs: abandoned from the moment this test starts.
    },
  });
  const sent: Uint8Array[] = [];
  const control = new AgentControl(
    store,
    { publish: async (_channel, bytes) => void sent.push(bytes) },
    { run: async (_id, work) => work() },
    { timeoutMs: 0, fallbackMs: 0 },
  );
  await control.recover(
    {
      protocolMajor: 1,
      requestId: "ready-recovery",
      workspaceId: "w",
      computerId: "c",
      agentId: "a",
      provider: "pi",
      model: "",
      reasoning: "",
    },
    "owner",
  );
  expect(sent).toHaveLength(1);
  expect(decodeAgentStartIntent(sent[0]!)).toMatchObject({
    requestId: "stuck-start",
    controlEpoch: 9,
  });
  expect(current().state).toMatchObject({ requestId: "stuck-start", epoch: 9, phase: "starting" });
  expect(current().state?.updatedAtMs).toBeUndefined();
});

test("publishStop drives an abandoned starting Agent through stop then a fresh start (ManageAgents.update sequence)", async () => {
  // ManageAgents.update fakes `runtimeControl` entirely and never constructs a real
  // AgentControl, so it cannot observe abandonment; this exercises the same stop -> persist ->
  // start sequence at the AgentControl level that production wiring (agent-runtime-control.
  // server.ts's PublishAgentRuntimeControl) uses underneath it.
  const { store, current } = abandonStore({
    id: "a",
    ownerId: "owner",
    workspaceId: "w",
    computerId: "c",
    runtimeConfig: abandonRuntimeConfig,
    state: {
      version: 1,
      protocolMajor: 1,
      requestId: "stuck-start",
      workspaceId: "w",
      computerId: "c",
      agentId: "a",
      provider: "pi",
      epoch: 4,
      action: "start",
      phase: "starting",
      configRevision: agentControlRevision(abandonRuntimeConfig),
      controlSequence: 0,
      sessionSequence: 0,
    },
  });
  const events: string[] = [];
  const control = new AgentControl(
    store,
    {
      publish: async (_channel, bytes) => {
        try {
          const stop = decodeAgentStopIntent(bytes);
          events.push("stop");
          await control.result(stop, {
            ...stop,
            provider: stop.provider!,
            epoch: stop.controlEpoch!,
            phase: "stopped",
            sequence: 1,
          });
          return;
        } catch {
          /* Not a stop intent. */
        }
        const start = decodeAgentStartIntent(bytes);
        events.push("start");
        await control.authorizeLaunch({ ...start, launchId: "launch-a" });
        await control.result(start, {
          ...start,
          epoch: start.controlEpoch!,
          launchId: "launch-a",
          phase: "started",
          sequence: 2,
          identity: { sessionId: "native-a", state: "empty" },
        });
      },
    },
    { run: async (_id, work) => work() },
  );
  await control.publishStop({ agentId: "a", workspaceId: "w", requestId: "stop-1" }, "owner");
  expect(current().state).toMatchObject({ phase: "completed", action: "stop" });
  // Config persistence between stop and start happens outside AgentControl.
  await control.publishStart(
    {
      protocolMajor: 1,
      requestId: "start-1",
      workspaceId: "w",
      computerId: "c",
      agentId: "a",
      provider: "pi",
      model: "",
      reasoning: "",
    },
    "owner",
  );
  expect(events).toEqual(["stop", "start"]);
  // The stub acknowledges both commands inline, so the sequence drives all the way through.
  expect(current().state).toMatchObject({
    phase: "completed",
    action: "start",
    requestId: "start-1",
  });
});

// --- Start and Stop as user operations with a persisted stopped state (ADR 0038) --------------

test("a Workspace member who does not own the Agent can Start and Stop it", async () => {
  const stop = executeAuthorizationFixture({ ownerId: "owner-user", role: "member" });
  await expect(
    stop.control.execute({
      userId: "member-user",
      workspaceId: "w",
      agentId: "a",
      requestId: "stop-req",
      action: "stop",
    }),
  ).resolves.toMatchObject({ phase: "pending" });
  expect(stop.current().stoppedAt).toBeInstanceOf(Date);

  const start = executeAuthorizationFixture({
    ownerId: "owner-user",
    role: "member",
    stoppedAt: new Date("2026-09-17T00:00:00Z"),
  });
  await expect(
    start.control.execute({
      userId: "member-user",
      workspaceId: "w",
      agentId: "a",
      requestId: "start-req",
      action: "start",
    }),
  ).resolves.toMatchObject({ phase: "pending" });
  expect(start.current().stoppedAt).toBeNull();
});

test("a user with no current Workspace membership is rejected for Start and Stop", async () => {
  const { control } = executeAuthorizationFixture({ ownerId: "owner-user", role: undefined });
  await expect(
    control.execute({
      userId: "outsider",
      workspaceId: "w",
      agentId: "a",
      requestId: "stop-req",
      action: "stop",
    }),
  ).rejects.toThrow("Agent is not authorized or assigned");
  await expect(
    control.execute({
      userId: "outsider",
      workspaceId: "w",
      agentId: "a",
      requestId: "start-req",
      action: "start",
    }),
  ).rejects.toThrow("Agent is not authorized or assigned");
});

test("stop persists stoppedAt before the chain runs, even when the Daemon never answers", async () => {
  const { control, sent, current } = executeAuthorizationFixture({
    ownerId: "owner-user",
    role: "member",
  });
  const result = await control.execute({
    userId: "member-user",
    workspaceId: "w",
    agentId: "a",
    requestId: "stop-req",
    action: "stop",
  });
  // timeoutMs: 0 means the Daemon never gets a chance to answer within this call.
  expect(result.phase).toBe("pending");
  expect(sent).toHaveLength(1);
  expect(decodeAgentStopIntent(sent[0]!)).toMatchObject({ requestId: "stop-req" });
  expect(current().stoppedAt).toBeInstanceOf(Date);
});

test.each(["start", "restart", "reset-session"] as const)(
  "%s clears a previously persisted stoppedAt",
  async (action) => {
    const { control, current } = executeAuthorizationFixture({
      ownerId: "owner-user",
      role: "member",
      stoppedAt: new Date("2026-09-17T00:00:00Z"),
    });
    expect(current().stoppedAt).toBeInstanceOf(Date);
    await control.execute({
      userId: "member-user",
      workspaceId: "w",
      agentId: "a",
      requestId: `${action}-req`,
      action,
    });
    expect(current().stoppedAt).toBeNull();
  },
);

test("full-reset clears a previously persisted stoppedAt (owner/admin only)", async () => {
  const { control, current } = executeAuthorizationFixture({
    ownerId: "owner-user",
    role: "admin",
    stoppedAt: new Date("2026-09-17T00:00:00Z"),
  });
  await control.execute({
    userId: "admin-user",
    workspaceId: "w",
    agentId: "a",
    requestId: "full-reset-req",
    action: "full-reset",
    confirmed: true,
  });
  expect(current().stoppedAt).toBeNull();
});

test("a user-initiated Start carries the same recovery context a Daemon-ready recovery Start does", async () => {
  let agent: AgentControlAgent = {
    id: "a",
    ownerId: "owner-user",
    workspaceId: "w",
    computerId: "c",
    runtimeConfig: {
      runtime: "pi",
      provider: { kind: "default" },
      model: "",
      modelProvider: "",
      reasoning: "",
    },
    state: null,
    stoppedAt: new Date("2026-09-17T00:00:00Z"),
  };
  const store: AgentControlStore = {
    memberRole: async () => "member",
    get: async () => structuredClone(agent),
    replace: async (before, state, options) => {
      if (JSON.stringify(before.state) !== JSON.stringify(agent.state)) return false;
      agent = {
        ...agent,
        state: structuredClone(state),
        ...(options?.stoppedAt !== undefined ? { stoppedAt: options.stoppedAt } : {}),
      };
      return true;
    },
  };
  const sent: Uint8Array[] = [];
  const readRequests: string[] = [];
  const control = new AgentControl(
    store,
    { publish: async (_channel, bytes) => void sent.push(bytes) },
    { run: async (_id, work) => work() },
    { timeoutMs: 0, fallbackMs: 0 },
    undefined,
    undefined,
    {
      readAgentRecoveryContext: async (_workspaceId, agentId) => {
        readRequests.push(agentId);
        return {
          resumeMessages: [
            {
              messageId: "message-1",
              deliveryId: "delivery-1",
              conversationId: "conversation-1",
              sequence: 3,
              target: "@alice",
              latestSender: "@alice",
              body: "arrived while stopped",
            },
          ],
          unreadSummary: { "@alice": 2 },
        };
      },
    },
  );
  await control.execute({
    userId: "member-user",
    workspaceId: "w",
    agentId: "a",
    requestId: "start-req",
    action: "start",
  });
  expect(readRequests).toEqual(["a"]);
  expect(decodeAgentStartIntent(sent[0]!)).toMatchObject({
    requestId: "start-req",
    resumeMessages: [
      {
        messageId: "message-1",
        deliveryId: "delivery-1",
        conversationId: "conversation-1",
        sequence: 3,
        target: "@alice",
        latestSender: "@alice",
        body: "arrived while stopped",
      },
    ],
    unreadSummary: { "@alice": 2 },
  });
});

test("an abandoned pending operation is superseded by a user-initiated Stop (ADR 0035)", async () => {
  const { store, current } = abandonStore({
    id: "a",
    ownerId: "owner",
    workspaceId: "w",
    computerId: "c",
    runtimeConfig: abandonRuntimeConfig,
    state: {
      version: 1,
      protocolMajor: 1,
      requestId: "stuck",
      workspaceId: "w",
      computerId: "c",
      agentId: "a",
      provider: "pi",
      epoch: 4,
      action: "restart",
      phase: "starting",
      configRevision: agentControlRevision(abandonRuntimeConfig),
      controlSequence: 0,
      sessionSequence: 0,
      // No updatedAtMs: abandoned regardless of `abandonAfterMs`.
    },
  });
  const sent: Uint8Array[] = [];
  const control = new AgentControl(
    store,
    { publish: async (_channel, bytes) => void sent.push(bytes) },
    { run: async (_id, work) => work() },
    { timeoutMs: 0, fallbackMs: 0 },
  );
  const result = await control.execute({
    userId: "owner",
    workspaceId: "w",
    agentId: "a",
    requestId: "stop-req",
    action: "stop",
  });
  expect(result.phase).toBe("pending");
  expect(current().state).toMatchObject({ epoch: 5, action: "stop", phase: "stopping" });
  expect(decodeAgentStopIntent(sent[0]!)).toMatchObject({ requestId: "stop-req", controlEpoch: 5 });
});

test("an abandoned pending operation is superseded by a user-initiated Start (ADR 0035)", async () => {
  const { store, current } = abandonStore({
    id: "a",
    ownerId: "owner",
    workspaceId: "w",
    computerId: "c",
    runtimeConfig: abandonRuntimeConfig,
    state: {
      version: 1,
      protocolMajor: 1,
      requestId: "stuck-stop",
      workspaceId: "w",
      computerId: "c",
      agentId: "a",
      provider: "pi",
      epoch: 4,
      action: "stop",
      phase: "stopping",
      configRevision: agentControlRevision(abandonRuntimeConfig),
      controlSequence: 0,
      sessionSequence: 0,
      // No updatedAtMs: abandoned regardless of `abandonAfterMs`.
    },
  });
  const sent: Uint8Array[] = [];
  const control = new AgentControl(
    store,
    { publish: async (_channel, bytes) => void sent.push(bytes) },
    { run: async (_id, work) => work() },
    { timeoutMs: 0, fallbackMs: 0 },
  );
  const result = await control.execute({
    userId: "owner",
    workspaceId: "w",
    agentId: "a",
    requestId: "start-req",
    action: "start",
  });
  expect(result.phase).toBe("pending");
  expect(current().state).toMatchObject({ epoch: 5, action: "start", phase: "starting" });
  expect(decodeAgentStartIntent(sent[0]!)).toMatchObject({
    requestId: "start-req",
    controlEpoch: 5,
  });
});

test("authorizeLaunch re-reads and retries when a concurrent Session write wins the conditional write", async () => {
  const runtimeConfig = {
    runtime: "pi" as const,
    provider: { kind: "default" as const },
    model: "m",
    reasoning: "default" as const,
  };
  let agent: AgentControlAgent = {
    id: "a",
    ownerId: "owner",
    workspaceId: "w",
    computerId: "c",
    runtimeConfig,
    currentSessionId: "session-row",
    identity: { sessionId: "stale-native", state: "resumable" },
    state: {
      version: 1,
      protocolMajor: 1,
      requestId: "start-1",
      workspaceId: "w",
      computerId: "c",
      agentId: "a",
      provider: "pi",
      epoch: 2,
      action: "start",
      phase: "starting",
      configRevision: agentControlRevision(runtimeConfig),
      controlSequence: 0,
      sessionSequence: 0,
      launchId: "launch-a",
      identity: { sessionId: "stale-native", state: "resumable" },
    },
  };
  let reads = 0;
  let writes = 0;
  const store: AgentControlStore = {
    get: async () => {
      reads++;
      return structuredClone(agent);
    },
    memberRole: async () => "owner",
    replace: async (before, state) => {
      writes++;
      // First write: an `agent:session:invalidate` cleared the Session association after the
      // read, exactly what the Prisma store's currentSessionId comparison rejects.
      if (writes === 1) {
        const { identity: _identity, ...cleared } = agent.state!;
        agent = { ...agent, currentSessionId: null, identity: undefined, state: cleared };
        return false;
      }
      if ((before.currentSessionId ?? null) !== (agent.currentSessionId ?? null)) return false;
      agent = { ...agent, state };
      return true;
    },
  };
  const control = new AgentControl(
    store,
    { publish: async () => {} },
    { run: async (_id, work) => work() },
  );
  await control.authorizeLaunch({
    agentId: "a",
    workspaceId: "w",
    computerId: "c",
    controlEpoch: 2,
    requestId: "start-1",
    launchId: "launch-a",
  });
  expect(reads).toBe(2);
  expect(writes).toBe(2);
  expect(agent.state?.launchId).toBe("launch-a");
  expect(agent.currentSessionId).toBeNull();

  // A launch that is no longer current after the re-read is still refused, never retried blind.
  writes = 0;
  const stale: AgentControlStore = {
    ...store,
    replace: async () => {
      writes++;
      agent = { ...agent, state: { ...agent.state!, epoch: 3, requestId: "start-2" } };
      return false;
    },
  };
  const second = new AgentControl(
    stale,
    { publish: async () => {} },
    { run: async (_id, work) => work() },
  );
  await expect(
    second.authorizeLaunch({
      agentId: "a",
      workspaceId: "w",
      computerId: "c",
      controlEpoch: 2,
      requestId: "start-1",
      launchId: "launch-a",
    }),
  ).rejects.toThrow("Stale Agent launch");
  expect(writes).toBe(1);
});
