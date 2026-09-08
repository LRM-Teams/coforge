import { expect, test } from "bun:test";
import { AgentControl } from "../src/agent-runtime/agent-control";
import { AgentSessions } from "../src/agent-runtime/agent-session";
import {
  AgentRuntimeState,
  type AgentRuntimeRecord,
  type AgentRuntimeStateStore,
} from "../src/agent-runtime/agent-runtime-state";
import type {
  AgentWorkspaceResetRequest,
  AgentControlResult,
  AgentStartIntent,
} from "@coforge/protocol";
import { AgentSessionRecoveryError, AgentProcessCleanupError } from "../src/code-agent/contract";

test.each([true, false])(
  "only classified resume errors allow one fresh launch (%s)",
  async (recoverable) => {
    let record: AgentRuntimeRecord | undefined;
    const attempts: AgentStartIntent[] = [];
    const results: AgentControlResult[] = [];
    const state = new AgentRuntimeState({
      listAgentIds: async () => [],
      workspaceExists: async () => false,
      async read() {
        return record && structuredClone(record);
      },
      async write(_id, value) {
        record = structuredClone(value);
      },
      async clearWorkspace() {
        throw new Error("must not clear");
      },
    });
    const control = new AgentControl("daemon", state, new AgentSessions(state, async () => {}), {
      running: () => false,
      stop: async () => undefined,
      async launch(intent) {
        attempts.push(intent);
        if (intent.sessionId)
          throw recoverable
            ? new AgentSessionRecoveryError("session_missing")
            : new Error("unauthorized");
        return { sessionId: "fresh", state: "empty" };
      },
      async result(result) {
        results.push(result);
      },
    });
    await control.start({
      protocolMajor: 1,
      requestId: "r",
      workspaceId: "w",
      computerId: "c",
      agentId: "a",
      provider: "pi",
      model: "",
      reasoning: "",
      controlEpoch: 1,
      sessionId: "old",
    });
    expect(attempts).toHaveLength(recoverable ? 2 : 1);
    expect(results.at(-1)?.phase).toBe(recoverable ? "started" : "failed");
    if (recoverable) expect(results.at(-1)?.identity?.sessionId).toBe("fresh");
  },
);

test("classified recovery retries once without restoring resume mode and reports the replaced identity", async () => {
  let record: AgentRuntimeRecord | undefined;
  const attempts: Array<{ intent: AgentStartIntent; replacedSessionId?: string }> = [];
  const state = new AgentRuntimeState({
    listAgentIds: async () => [],
    workspaceExists: async () => false,
    read: async () => record && structuredClone(record),
    write: async (_id, value) => {
      record = structuredClone(value);
    },
    clearWorkspace: async () => {},
  });
  const control = new AgentControl("daemon", state, new AgentSessions(state, async () => {}), {
    running: () => false,
    stop: async () => undefined,
    async launch(intent, _launchId, replacedSessionId) {
      attempts.push({ intent, replacedSessionId });
      if (attempts.length === 1) throw new AgentSessionRecoveryError("session_missing");
      return { sessionId: "fresh", state: "empty" };
    },
    result: async () => {},
    wake: async () => {},
  });

  await control.start({
    protocolMajor: 1,
    requestId: "r",
    workspaceId: "w",
    computerId: "c",
    agentId: "a",
    provider: "pi",
    model: "",
    reasoning: "",
    controlEpoch: 1,
    sessionId: "old",
    sessionMode: "resume",
  });

  expect(attempts[1]).toMatchObject({ replacedSessionId: "old" });
  expect(attempts[1]!.intent).not.toHaveProperty("sessionId");
  expect(attempts[1]!.intent).not.toHaveProperty("sessionMode");
});

test("duplicate fenced start wakes an existing runtime without replacing it", async () => {
  let record: AgentRuntimeRecord | undefined;
  let running = false;
  const wakes: AgentStartIntent[] = [];
  const state = new AgentRuntimeState({
    listAgentIds: async () => [],
    workspaceExists: async () => false,
    read: async () => record && structuredClone(record),
    write: async (_id, value) => {
      record = structuredClone(value);
    },
    clearWorkspace: async () => {},
  });
  const control = new AgentControl("daemon", state, new AgentSessions(state, async () => {}), {
    running: () => running,
    stop: async () => undefined,
    launch: async () => {
      running = true;
      return { sessionId: "session", state: "resumable" };
    },
    wake: async (intent) => {
      wakes.push(intent);
    },
    result: async () => {},
  });
  const intent: AgentStartIntent = {
    protocolMajor: 1,
    requestId: "r",
    workspaceId: "w",
    computerId: "c",
    agentId: "a",
    provider: "pi",
    model: "",
    reasoning: "",
    controlEpoch: 1,
    wakeMessage: {
      messageId: "m",
      deliveryId: "d",
      conversationId: "conversation",
      sequence: 1,
      target: "@ada",
      latestSender: "@ada",
      body: "wake",
    },
    resumeMessages: [],
    unreadSummary: { "@ada": 3 },
  };
  await control.start(intent);
  await control.start(intent);
  expect(wakes).toEqual([intent]);
});

test("stop then workspace reset then start persists primitive receipts", async () => {
  let record: AgentRuntimeRecord | undefined;
  let files = ["old", ".pi/skills/old/SKILL.md"];
  let active = true;
  const effects: string[] = [];
  const store: AgentRuntimeStateStore = {
    listAgentIds: async () => [],
    workspaceExists: async () => true,
    async read() {
      return record && structuredClone(record);
    },
    async write(_id, value) {
      record = structuredClone(value);
    },
    async clearWorkspace() {
      effects.push("clear");
      expect(active).toBe(false);
      files = [];
    },
  };
  const results: AgentControlResult[] = [];
  const state = new AgentRuntimeState(store);
  let sentSessions = 0;
  const sessions = new AgentSessions(state, async () => {
    sentSessions++;
  });
  const control = new AgentControl("daemon-a", state, sessions, {
    async stop() {
      effects.push("stop");
      active = false;
      return { sessionId: "old", state: "resumable" };
    },
    async launch(_intent, _launchId) {
      effects.push("start");
      active = true;
      files.push("new");
      return { sessionId: "new", state: "empty" };
    },
    running() {
      return active;
    },
    async result(result) {
      results.push(result);
    },
  });
  const request: AgentWorkspaceResetRequest = {
    protocolMajor: 1,
    requestId: "reset-a",
    workspaceId: "workspace-a",
    computerId: "computer-a",
    agentId: "agent-a",
    provider: "pi",
    epoch: 1,
  };
  await control.stop(request);
  await control.resetWorkspace(request);
  const start: AgentStartIntent = { ...request, controlEpoch: 1, model: "", reasoning: "" };
  await control.start(start);
  await control.stop(request);
  await control.resetWorkspace(request);
  await control.start(start);
  expect(files).toEqual(["new"]);
  expect(effects).toEqual(["stop", "clear", "start"]);
  expect(results.filter((r) => r.phase === "started")).toHaveLength(2);
  expect(results.filter((r) => r.phase === "stopped")).toHaveLength(2);
  expect(results.filter((r) => r.phase === "workspace-reset")).toHaveLength(2);
  expect(sentSessions).toBe(0);
  await sessions.replay("agent-a");
  expect(sentSessions).toBe(1);
  const next = { ...request, requestId: "restart-b", epoch: 2 };
  await control.stop(next);
  await control.start({ ...start, requestId: next.requestId, controlEpoch: 2 });
  await expect(control.resetWorkspace(next)).rejects.toThrow("confirmed_stop_required");
  expect(effects.filter((effect) => effect === "clear")).toHaveLength(1);
  record = undefined;
  await expect(control.stop(request)).rejects.toThrow("control_record_missing");
  expect(files).toEqual(["new", "new"]);
});

test("workspace reset requires a successful stop and a failed stop blocks reset and start", async () => {
  let record: AgentRuntimeRecord | undefined;
  let clears = 0;
  let launches = 0;
  const state = new AgentRuntimeState({
    listAgentIds: async () => [],
    workspaceExists: async () => false,
    read: async () => record && structuredClone(record),
    write: async (_id, value) => {
      record = structuredClone(value);
    },
    clearWorkspace: async () => {
      clears++;
    },
  });
  const control = new AgentControl("daemon", state, new AgentSessions(state, async () => {}), {
    running: () => true,
    stop: async () => {
      throw new AgentProcessCleanupError();
    },
    launch: async () => {
      launches++;
      return undefined;
    },
    result: async () => {},
  });
  const scope: AgentWorkspaceResetRequest = {
    protocolMajor: 1,
    requestId: "stop",
    workspaceId: "w",
    computerId: "c",
    agentId: "a",
    provider: "codex",
    epoch: 1,
  };
  await expect(control.resetWorkspace({ ...scope, requestId: "reset" })).rejects.toThrow(
    "confirmed_stop_required",
  );
  await control.stop(scope);
  await control.stop(scope);
  await expect(control.resetWorkspace({ ...scope, requestId: "reset" })).rejects.toThrow(
    "confirmed_stop_required",
  );
  await expect(
    control.start({ ...scope, requestId: "start", controlEpoch: 1, model: "", reasoning: "" }),
  ).rejects.toThrow("previous_control_not_completed");
  expect(clears).toBe(0);
  expect(launches).toBe(0);
  const replacement = new AgentControl(
    "new-daemon",
    state,
    new AgentSessions(state, async () => {}),
    {
      running: () => false,
      stop: async () => undefined,
      launch: async () => {
        launches++;
        return undefined;
      },
      result: async () => {},
    },
  );
  await expect(replacement.stop({ ...scope, requestId: "retry", epoch: 2 })).rejects.toThrow(
    "previous_process_stop_unconfirmed",
  );
});

test("unconfirmed launch cleanup remains fenced across daemon restart", async () => {
  let record: AgentRuntimeRecord | undefined;
  let creates = 0;
  const store: AgentRuntimeStateStore = {
    listAgentIds: async () => (record ? ["a"] : []),
    workspaceExists: async () => false,
    read: async () => record && structuredClone(record),
    write: async (_id, next) => {
      record = structuredClone(next);
    },
    clearWorkspace: async () => {
      throw new Error("must not clear");
    },
  };
  const runtime = {
    running: () => false,
    stop: async () => {
      throw new AgentProcessCleanupError();
    },
    launch: async () => {
      creates++;
      throw new AgentProcessCleanupError();
    },
    result: async () => {},
  };
  const start: AgentStartIntent = {
    protocolMajor: 1,
    requestId: "r",
    agentId: "a",
    workspaceId: "w",
    computerId: "c",
    provider: "pi",
    model: "",
    reasoning: "",
    controlEpoch: 1,
  };
  const oldState = new AgentRuntimeState(store);
  const oldControl = new AgentControl(
    "old",
    oldState,
    new AgentSessions(oldState, async () => {}),
    runtime,
  );
  await expect(oldControl.start(start)).rejects.toThrow("did not exit");
  const newState = new AgentRuntimeState(store);
  const newControl = new AgentControl(
    "new",
    newState,
    new AgentSessions(newState, async () => {}),
    runtime,
  );
  await expect(
    newControl.start({
      ...start,
      controlEpoch: 2,
      requestId: "new-r",
    }),
  ).rejects.toThrow("previous_process_stop_unconfirmed");
  expect(creates).toBe(1);
});

test.each(["clearing", "failed"] as const)(
  "a newer Start cannot bypass %s workspace deletion",
  async (phase) => {
    const scope = {
      protocolMajor: 1,
      requestId: "reset",
      workspaceId: "w",
      computerId: "c",
      agentId: "a",
      provider: "pi" as const,
      epoch: 1,
    };
    let record: AgentRuntimeRecord = {
      version: 1,
      scope,
      action: "reset-workspace",
      phase,
      daemonInstanceId: "daemon",
      sequence: 1,
    };
    let launches = 0;
    const state = new AgentRuntimeState({
      listAgentIds: async () => ["a"],
      workspaceExists: async () => true,
      read: async () => structuredClone(record),
      write: async (_id, next) => {
        record = structuredClone(next);
      },
      clearWorkspace: async () => {},
    });
    const control = new AgentControl("daemon", state, new AgentSessions(state, async () => {}), {
      running: () => false,
      stop: async () => undefined,
      launch: async () => {
        launches++;
        return undefined;
      },
      result: async () => {},
    });
    await expect(
      control.start({
        ...scope,
        requestId: "automatic",
        controlEpoch: 2,
        model: "",
        reasoning: "",
      }),
    ).rejects.toThrow("previous_control_not_completed");
    expect(launches).toBe(0);
    const retry = { ...scope, requestId: "explicit-retry", epoch: 2 };
    await control.stop(retry);
    await expect(
      control.start({ ...retry, controlEpoch: 2, model: "", reasoning: "" }),
    ).rejects.toThrow("previous_control_not_completed");
    await control.resetWorkspace(retry);
    await control.start({ ...retry, controlEpoch: 2, model: "", reasoning: "" });
    expect(launches).toBe(1);
  },
);

test("a delayed old exit cannot stop a replacement launch while waiting for the Agent lock", async () => {
  const scope = {
    protocolMajor: 1,
    requestId: "r",
    workspaceId: "w",
    computerId: "c",
    agentId: "a",
    provider: "pi" as const,
    epoch: 1,
  };
  let record: AgentRuntimeRecord = {
    version: 1,
    scope,
    action: "start",
    phase: "running",
    launchId: "old",
    daemonInstanceId: "daemon",
    sequence: 1,
  };
  const state = new AgentRuntimeState({
    listAgentIds: async () => ["a"],
    workspaceExists: async () => true,
    read: async () => structuredClone(record),
    write: async (_id, next) => {
      record = structuredClone(next);
    },
    clearWorkspace: async () => {},
  });
  const control = new AgentControl("daemon", state, new AgentSessions(state, async () => {}), {
    running: () => true,
    stop: async () => undefined,
    launch: async () => undefined,
    result: async () => {},
  });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const replacing = state.run("a", async () => {
    entered.resolve();
    await release.promise;
    record = {
      ...record,
      launchId: "replacement",
      identity: { sessionId: "new", state: "resumable" },
    };
  });
  await entered.promise;
  const exiting = control.stopped("a", "old", { sessionId: "old", state: "resumable" });
  try {
    release.resolve();
    await replacing;
    await exiting;
    expect(await state.store.read("a")).toMatchObject({
      phase: "running",
      launchId: "replacement",
      identity: { sessionId: "new" },
    });
  } finally {
    release.resolve();
    await Promise.allSettled([replacing, exiting]);
  }
});
