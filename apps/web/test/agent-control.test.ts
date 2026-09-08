import { expect, test } from "bun:test";
import {
  AgentControl,
  agentControlRevision,
  type AgentControlAgent,
  type AgentControlStore,
} from "../src/server/agents/agent-control.server";
import { AgentSessionReceiver } from "../src/server/agents/agent-session.server";
import {
  decodeAgentStartIntent,
  decodeAgentStopIntent,
  decodeAgentWorkspaceResetRequest,
} from "@coforge/protocol";

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
    { timeoutMs: 1, wait: async () => {} },
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
      { timeoutMs: 1, wait: async () => {} },
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
  const sessions = new AgentSessionReceiver(store);
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

test("Full Reset halts on failed clearing and automatic starts cannot bypass the chain", async () => {
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
    { timeoutMs: 0, wait: async () => {} },
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
  await expect(
    control.execute({ ...input, requestId: "competing", action: "restart" }),
  ).rejects.toThrow("pending");
  await control.result(scope, { ...scope, phase: "stopped", sequence: 1 });
  expect(decodeAgentWorkspaceResetRequest(sent[1]!)).toMatchObject({
    requestId: "reset",
    epoch: 1,
  });
  await control.result(scope, {
    ...scope,
    phase: "failed",
    sequence: 2,
    errorCode: "workspace_clear_failed",
  });
  await expect(
    control.publishStop({ agentId: "a", workspaceId: "w", requestId: "config-stop" }, "owner"),
  ).rejects.toThrow("Explicit Agent reset retry is required");
  await expect(
    control.execute({ ...input, requestId: "restart", action: "restart" }),
  ).rejects.toThrow("Explicit Agent reset retry is required");
  const start = { ...scope, requestId: "automatic", model: "", reasoning: "" };
  await expect(control.recover(start, "owner")).rejects.toThrow(
    "Explicit Agent reset retry is required",
  );
  await expect(control.publishStart(start, "owner")).rejects.toThrow(
    "Explicit Agent reset retry is required",
  );
  expect(sent).toHaveLength(2);
  expect((await control.execute(input)).phase).toBe("failed");
  // An explicit retry starts with a new confirmed-stop boundary, not a naked Start.
  await control.execute({ ...input, requestId: "retry" });
  expect(decodeAgentStopIntent(sent[2]!)).toMatchObject({ requestId: "retry", controlEpoch: 2 });
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
  const control = new AgentControl(store, api, lock, { timeoutMs: 0, wait: async () => {} });
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
