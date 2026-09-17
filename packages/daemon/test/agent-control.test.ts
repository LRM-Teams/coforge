import { expect, test } from "bun:test";
import { configure, reset, type LogRecord } from "@logtape/logtape";
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
  AgentControlScope,
  AgentStartIntent,
} from "@lrm/coforge-sdk/internal";
import { AgentSessionRecoveryError, AgentProcessCleanupError } from "../src/code-agent/contract";

/** Matches the production wiring (`DaemonRuntime#cleanupUnconfirmed`): only a genuine
 * "process did not exit" cleanup failure counts as unconfirmed. */
const cleanupUnconfirmed = (_agentId: string, error: unknown) =>
  error instanceof AgentProcessCleanupError;

/** Runs `run()` with a logtape capture sink installed for `coforge.daemon.*`, then restores the
 * previous (unconfigured) logging state. Mirrors the pattern in runtime-inventory-diagnostics.test.ts. */
async function captureLogs<T>(run: () => Promise<T>): Promise<{ result: T; records: LogRecord[] }> {
  const records: LogRecord[] = [];
  await configure({
    reset: true,
    sinks: { capture: (record) => records.push(record) },
    loggers: [
      { category: ["coforge", "daemon"], lowestLevel: "info", sinks: ["capture"] },
      { category: ["logtape", "meta"], lowestLevel: "error", sinks: ["capture"] },
    ],
  });
  try {
    const result = await run();
    return { result, records };
  } finally {
    await reset();
  }
}

/**
 * The exact legacy record shape from the s144 incident (2026-09-17): a fenced Stop at epoch 8
 * whose remote revoke failed mid-deploy, persisted as `phase: "stopping"` with a failed
 * `stopResult`, from a daemon instance that no longer exists.
 */
function legacyStopFailedRecord(): AgentRuntimeRecord {
  const scope: AgentControlScope = {
    protocolMajor: 1,
    requestId: "stop-8",
    workspaceId: "w",
    computerId: "c",
    agentId: "a",
    provider: "codex",
    epoch: 8,
  };
  const stopResult: AgentControlResult = {
    ...scope,
    phase: "failed",
    sequence: 1,
    errorCode: "stop_failed",
  };
  return {
    version: 1,
    scope,
    action: "stop",
    phase: "stopping",
    daemonInstanceId: "s144-old-daemon",
    sequence: 1,
    identity: { sessionId: "native-session", state: "resumable" },
    stopResult,
    lastResult: stopResult,
  };
}

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
      cleanupUnconfirmed,
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
    cleanupUnconfirmed,
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
    cleanupUnconfirmed,
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
    cleanupUnconfirmed,
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
    cleanupUnconfirmed,
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
      cleanupUnconfirmed,
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
    cleanupUnconfirmed,
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

test("a newer Start cannot bypass an in-progress (clearing) workspace deletion", async () => {
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
    phase: "clearing",
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
    cleanupUnconfirmed,
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
  // Mid-deletion always blocks, regardless of epoch: a deliberate destructive-operation
  // guard, unrelated to the reset-workspace-failure latch this suite removes below.
  const retry = { ...scope, requestId: "explicit-retry", epoch: 2 };
  await control.stop(retry);
  await expect(
    control.start({ ...retry, controlEpoch: 2, model: "", reasoning: "" }),
  ).rejects.toThrow("previous_control_not_completed");
  await control.resetWorkspace(retry);
  await control.start({ ...retry, controlEpoch: 2, model: "", reasoning: "" });
  expect(launches).toBe(1);
});

test("a pre-existing failed reset-workspace record from an older daemon does not block a newer Start", async () => {
  // Simulates a record left behind by a daemon that predates the non-fatal-clear-failure fix:
  // action "reset-workspace" with a terminal "failed" phase. The reset-workspace-specific latch
  // that used to block every future Start regardless of epoch is gone; only the generic
  // same-epoch pending-retry rule remains, so a newer-epoch Start now proceeds directly.
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
    phase: "failed",
    daemonInstanceId: "daemon",
    sequence: 1,
  };
  let launches = 0;
  const results: AgentControlResult[] = [];
  const state = new AgentRuntimeState({
    listAgentIds: async () => ["a"],
    workspaceExists: async () => true,
    read: async () => structuredClone(record),
    write: async (_id, next) => {
      record = structuredClone(next);
    },
    clearWorkspace: async () => {
      throw new Error("must not clear");
    },
  });
  const control = new AgentControl("daemon", state, new AgentSessions(state, async () => {}), {
    running: () => false,
    cleanupUnconfirmed,
    stop: async () => undefined,
    async launch() {
      launches++;
      return { sessionId: "new-session", state: "empty" };
    },
    async result(result) {
      results.push(result);
    },
  });
  await control.start({
    ...scope,
    requestId: "automatic",
    controlEpoch: 2,
    model: "",
    reasoning: "",
  });
  expect(launches).toBe(1);
  expect(results.at(-1)).toMatchObject({ phase: "started", requestId: "automatic" });
  expect(record).toMatchObject({ phase: "running" });
});

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
    cleanupUnconfirmed,
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

test("a stale stop-failed record from a gone daemon instance is repaired so a new Start launches", async () => {
  let record: AgentRuntimeRecord | undefined = legacyStopFailedRecord();
  const store: AgentRuntimeStateStore = {
    listAgentIds: async () => (record ? [record.scope.agentId] : []),
    workspaceExists: async () => true,
    read: async () => record && structuredClone(record),
    write: async (_id, next) => {
      record = structuredClone(next);
    },
    clearWorkspace: async () => {
      throw new Error("must not clear");
    },
  };
  const state = new AgentRuntimeState(store);
  let launches = 0;
  const results: AgentControlResult[] = [];
  const control = new AgentControl(
    "s144-new-daemon",
    state,
    new AgentSessions(state, async () => {}),
    {
      running: () => false,
      cleanupUnconfirmed,
      stop: async () => undefined,
      async launch() {
        launches++;
        return { sessionId: "new-session", state: "resumable" };
      },
      async result(result) {
        results.push(result);
      },
    },
  );
  await control.initialize();

  const { records: logs } = await captureLogs(() =>
    control.start({
      protocolMajor: 1,
      requestId: "start-9",
      workspaceId: "w",
      computerId: "c",
      agentId: "a",
      provider: "codex",
      model: "",
      reasoning: "",
      controlEpoch: 9,
    }),
  );

  expect(launches).toBe(1);
  expect(results.at(-1)).toMatchObject({ phase: "started", requestId: "start-9" });
  expect(record).toMatchObject({ phase: "running" });

  const repair = logs.find(
    (entry) => entry.properties.event === "agent_control:stale_record_repaired",
  );
  expect(repair?.level).toBe("error");
  expect(repair?.properties).toMatchObject({
    agent_id: "a",
    previous_phase: "stopping",
    previous_daemon_instance_id: "s144-old-daemon",
    daemon_instance_id: "s144-new-daemon",
    epoch: 8,
  });
});

test("a stale stop-failed record from a gone daemon instance is repaired so a new Stop returns a stopped receipt", async () => {
  let record: AgentRuntimeRecord | undefined = legacyStopFailedRecord();
  const store: AgentRuntimeStateStore = {
    listAgentIds: async () => (record ? [record.scope.agentId] : []),
    workspaceExists: async () => true,
    read: async () => record && structuredClone(record),
    write: async (_id, next) => {
      record = structuredClone(next);
    },
    clearWorkspace: async () => {
      throw new Error("must not clear");
    },
  };
  const state = new AgentRuntimeState(store);
  const results: AgentControlResult[] = [];
  const control = new AgentControl(
    "s144-new-daemon",
    state,
    new AgentSessions(state, async () => {}),
    {
      running: () => false,
      cleanupUnconfirmed,
      stop: async () => undefined,
      launch: async () => undefined,
      async result(result) {
        results.push(result);
      },
    },
  );
  await control.initialize();

  await control.stop({
    protocolMajor: 1,
    requestId: "stop-9",
    workspaceId: "w",
    computerId: "c",
    agentId: "a",
    provider: "codex",
    epoch: 9,
  });

  expect(results.at(-1)).toMatchObject({ phase: "stopped", requestId: "stop-9" });
  expect(record).toMatchObject({ phase: "stopped" });
});

test("a running record left by a crashed daemon instance is repaired so a newer Start launches", async () => {
  const scope: AgentControlScope = {
    protocolMajor: 1,
    requestId: "start-old",
    workspaceId: "w",
    computerId: "c",
    agentId: "a",
    provider: "pi",
    epoch: 3,
  };
  const startResult: AgentControlResult = {
    ...scope,
    phase: "started",
    launchId: "old-launch",
    sequence: 1,
  };
  let record: AgentRuntimeRecord | undefined = {
    version: 1,
    scope,
    action: "start",
    phase: "running",
    launchId: "old-launch",
    daemonInstanceId: "crashed-daemon",
    sequence: 1,
    identity: { sessionId: "native-session", state: "resumable" },
    startResult,
    lastResult: startResult,
  };
  const store: AgentRuntimeStateStore = {
    listAgentIds: async () => (record ? [record.scope.agentId] : []),
    workspaceExists: async () => true,
    read: async () => record && structuredClone(record),
    write: async (_id, next) => {
      record = structuredClone(next);
    },
    clearWorkspace: async () => {
      throw new Error("must not clear");
    },
  };
  const state = new AgentRuntimeState(store);
  let launches = 0;
  const control = new AgentControl(
    "recovered-daemon",
    state,
    new AgentSessions(state, async () => {}),
    {
      running: () => false,
      cleanupUnconfirmed,
      stop: async () => undefined,
      async launch() {
        launches++;
        return { sessionId: "new-session", state: "resumable" };
      },
      result: async () => {},
    },
  );
  await control.initialize();

  await control.start({
    ...scope,
    requestId: "start-new",
    controlEpoch: 4,
    model: "",
    reasoning: "",
  });

  expect(launches).toBe(1);
  expect(record).toMatchObject({ phase: "running" });
});

test("a reset-workspace in progress is not repaired away by a concurrent daemon instance change", async () => {
  const scope: AgentControlScope = {
    protocolMajor: 1,
    requestId: "reset-in-progress",
    workspaceId: "w",
    computerId: "c",
    agentId: "a",
    provider: "pi",
    epoch: 1,
  };
  let record: AgentRuntimeRecord | undefined = {
    version: 1,
    scope,
    action: "reset-workspace",
    phase: "clearing",
    daemonInstanceId: "gone-daemon",
    sequence: 2,
    stopResult: { ...scope, phase: "stopped", sequence: 1 },
  };
  let clears = 0;
  const store: AgentRuntimeStateStore = {
    listAgentIds: async () => (record ? [record.scope.agentId] : []),
    workspaceExists: async () => true,
    read: async () => record && structuredClone(record),
    write: async (_id, next) => {
      record = structuredClone(next);
    },
    clearWorkspace: async () => {
      clears++;
    },
  };
  const state = new AgentRuntimeState(store);
  const results: AgentControlResult[] = [];
  const control = new AgentControl(
    "recovered-daemon",
    state,
    new AgentSessions(state, async () => {}),
    {
      running: () => false,
      cleanupUnconfirmed,
      stop: async () => undefined,
      launch: async () => undefined,
      async result(result) {
        results.push(result);
      },
    },
  );
  await control.initialize();

  // A repair must never fire for "clearing": that would silently paper over an in-progress
  // workspace deletion instead of letting it resume to completion.
  await control.resetWorkspace({ ...scope, requestId: "reset-resume" });

  expect(clears).toBe(1);
  expect(record).toMatchObject({ phase: "workspace-reset" });
  expect(results.at(-1)).toMatchObject({ phase: "workspace-reset" });
});

test("a workspace clear failure is non-fatal: it reports workspace-reset with a warning, clears the session, logs at error level, and Start still proceeds", async () => {
  let record: AgentRuntimeRecord | undefined;
  let active = true;
  let sentSessions = 0;
  const store: AgentRuntimeStateStore = {
    listAgentIds: async () => [],
    workspaceExists: async () => true,
    read: async () => record && structuredClone(record),
    write: async (_id, value) => {
      record = structuredClone(value);
    },
    clearWorkspace: async () => {
      throw new Error("EACCES: permission denied");
    },
  };
  const results: AgentControlResult[] = [];
  const state = new AgentRuntimeState(store);
  const sessions = new AgentSessions(state, async () => {
    sentSessions++;
  });
  let launches = 0;
  const control = new AgentControl("daemon", state, sessions, {
    running: () => active,
    cleanupUnconfirmed,
    async stop() {
      active = false;
      return { sessionId: "old", state: "resumable" };
    },
    async launch() {
      launches++;
      active = true;
      return { sessionId: "new", state: "empty" };
    },
    async result(result) {
      results.push(result);
    },
  });
  const scope: AgentWorkspaceResetRequest = {
    protocolMajor: 1,
    requestId: "reset-a",
    workspaceId: "w",
    computerId: "c",
    agentId: "a",
    provider: "pi",
    epoch: 1,
  };
  await control.stop(scope);
  // A record with a bound identity proves the session association is actually cleared, not
  // just absent to begin with.
  expect(record).toMatchObject({ identity: { sessionId: "old" } });

  const { records: logs } = await captureLogs(() => control.resetWorkspace(scope));

  // Non-fatal: the daemon-level outcome is "workspace-reset" with a warning, never "failed".
  expect(record).toMatchObject({ phase: "workspace-reset" });
  expect(record?.identity).toBeUndefined();
  const resetResult = results.at(-1);
  expect(resetResult).toMatchObject({
    phase: "workspace-reset",
    warningCode: "workspace_clear_incomplete",
  });
  expect(resetResult).not.toHaveProperty("errorCode");

  const failureLog = logs.find(
    (entry) => entry.properties.event === "agent_control:workspace_clear_failed",
  );
  expect(failureLog?.level).toBe("error");
  expect(failureLog?.properties).toMatchObject({ agent_id: "a", error_code: "Error" });

  // The chain still proceeds: Start is not blocked by the clear failure.
  const start: AgentStartIntent = { ...scope, controlEpoch: 1, model: "", reasoning: "" };
  await control.start(start);
  expect(launches).toBe(1);
  expect(results.at(-1)).toMatchObject({ phase: "started" });
  expect(sentSessions).toBe(0);
  await sessions.replay("a");
  expect(sentSessions).toBe(1);
});
