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
      rebind: async () => undefined,
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
      launchId: "launch-1",
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
    rebind: async () => undefined,
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
    launchId: "launch-2",
    sessionId: "old",
    sessionMode: "resume",
  });

  expect(attempts[1]).toMatchObject({ replacedSessionId: "old" });
  expect(attempts[1]!.intent).not.toHaveProperty("sessionId");
  expect(attempts[1]!.intent).toMatchObject({ sessionMode: "create" });
});

test.each([
  ["session_missing", "missing"],
  ["provider_replay_rejected", "provider_replay_rejected"],
] as const)(
  "reports the invalidated session before the fresh launch attempt (%s)",
  async (code, reason) => {
    let record: AgentRuntimeRecord | undefined;
    const order: string[] = [];
    const invalidations: Array<{
      sessionId: string;
      launchId: string;
      reason: "missing" | "provider_replay_rejected";
    }> = [];
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
      rebind: async () => undefined,
      stop: async () => undefined,
      async launch(intent) {
        order.push("launch");
        if (intent.sessionId) throw new AgentSessionRecoveryError(code);
        return { sessionId: "fresh", state: "empty" };
      },
      invalidateSession(_intent, launchId, sessionId, reportedReason) {
        order.push("invalidate");
        invalidations.push({ sessionId, launchId, reason: reportedReason });
      },
      result: async () => {},
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
      launchId: "launch-3",
      sessionId: "old",
    });

    expect(invalidations).toEqual([
      { sessionId: "old", launchId: invalidations[0]!.launchId, reason },
    ]);
    // Invalidate is reported before the retry launch it precedes.
    expect(order).toEqual(["launch", "invalidate", "launch"]);
  },
);

test("reports the invalidated session even when the fresh launch that follows it fails", async () => {
  let record: AgentRuntimeRecord | undefined;
  const invalidations: string[] = [];
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
    rebind: async () => undefined,
    stop: async () => undefined,
    async launch(intent) {
      if (intent.sessionId) throw new AgentSessionRecoveryError("session_missing");
      throw new Error("fresh launch also fails");
    },
    invalidateSession(_intent, _launchId, sessionId) {
      invalidations.push(sessionId);
    },
    result: async () => {},
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
    launchId: "launch-4",
    sessionId: "old",
  });

  expect(invalidations).toEqual(["old"]);
});

test("session_in_use retries without invoking invalidateSession or carrying a reason into the retry launch", async () => {
  let record: AgentRuntimeRecord | undefined;
  const invalidations: string[] = [];
  const attempts: Array<{ replacedSessionId?: string; reason?: string }> = [];
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
    rebind: async () => undefined,
    stop: async () => undefined,
    async launch(intent, _launchId, replacedSessionId, reason) {
      attempts.push({ replacedSessionId, reason });
      if (intent.sessionId) throw new AgentSessionRecoveryError("session_in_use");
      return { sessionId: "fresh", state: "empty" };
    },
    invalidateSession(_intent, _launchId, sessionId) {
      invalidations.push(sessionId);
    },
    result: async () => {},
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
    launchId: "launch-5",
    sessionId: "old",
  });

  expect(invalidations).toEqual([]);
  // The retry still happens (harmless, per fix 1) even though nothing is reported.
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toEqual({ replacedSessionId: "old", reason: undefined });
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
    rebind: async () => undefined,
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
    launchId: "launch-6",
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
    rebind: async () => undefined,
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
  const start: AgentStartIntent = {
    ...request,
    controlEpoch: 1,
    launchId: "launch-7",
    model: "",
    reasoning: "",
  };
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
  await control.start({
    ...start,
    requestId: next.requestId,
    controlEpoch: 2,
    launchId: "launch-8",
  });
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
    rebind: async () => undefined,
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
    control.start({
      ...scope,
      requestId: "start",
      controlEpoch: 1,
      launchId: "launch-9",
      model: "",
      reasoning: "",
    }),
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
      rebind: async () => undefined,
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
    rebind: async () => undefined,
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
    launchId: "launch-10",
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
      launchId: "launch-11",
      requestId: "new-r",
    }),
  ).rejects.toThrow("previous_process_stop_unconfirmed");
  expect(creates).toBe(1);
});

/** Shared fixture for the two "a newer Start ... does not block" tests below: a hand-built
 * record with `action: "reset-workspace"` at a given phase, a state store that tracks writes,
 * and an AgentControl wired to count launches and capture results. */
function replacedRecordFixture(options: {
  phase: AgentRuntimeRecord["phase"];
  clearWorkspace?: () => Promise<void>;
  launchIdentity?: { sessionId: string; state: "empty" | "resumable" | "unknown" };
}) {
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
    phase: options.phase,
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
    clearWorkspace: options.clearWorkspace ?? (async () => {}),
  });
  const control = new AgentControl("daemon", state, new AgentSessions(state, async () => {}), {
    running: () => false,
    cleanupUnconfirmed,
    rebind: async () => undefined,
    stop: async () => undefined,
    async launch() {
      launches++;
      return options.launchIdentity;
    },
    async result(result) {
      results.push(result);
    },
  });
  return { scope, control, results, record: () => record, launches: () => launches };
}

test("a newer Start cannot bypass an in-progress (clearing) workspace deletion", async () => {
  const { scope, control, launches } = replacedRecordFixture({ phase: "clearing" });
  await expect(
    control.start({
      ...scope,
      requestId: "automatic",
      controlEpoch: 2,
      launchId: "launch-12",
      model: "",
      reasoning: "",
    }),
  ).rejects.toThrow("previous_control_not_completed");
  expect(launches()).toBe(0);
  // Mid-deletion always blocks, regardless of epoch: a deliberate destructive-operation
  // guard, unrelated to the reset-workspace-failure latch this suite removes below.
  const retry = { ...scope, requestId: "explicit-retry", epoch: 2 };
  await control.stop(retry);
  await expect(
    control.start({ ...retry, controlEpoch: 2, launchId: "launch-13", model: "", reasoning: "" }),
  ).rejects.toThrow("previous_control_not_completed");
  await control.resetWorkspace(retry);
  await control.start({
    ...retry,
    controlEpoch: 2,
    launchId: "launch-14",
    model: "",
    reasoning: "",
  });
  expect(launches()).toBe(1);
});

test("a pre-existing failed reset-workspace record from an older daemon does not block a newer Start", async () => {
  // Simulates a record left behind by a daemon that predates the non-fatal-clear-failure fix:
  // action "reset-workspace" with a terminal "failed" phase. The reset-workspace-specific latch
  // that used to block every future Start regardless of epoch is gone; only the generic
  // same-epoch pending-retry rule remains, so a newer-epoch Start now proceeds directly. Start
  // never routes through resetWorkspace/clearWorkspace at all, so clearWorkspace must not be
  // called on this path.
  const { scope, control, results, record, launches } = replacedRecordFixture({
    phase: "failed",
    clearWorkspace: async () => {
      throw new Error("must not clear");
    },
    launchIdentity: { sessionId: "new-session", state: "empty" },
  });
  await control.start({
    ...scope,
    requestId: "automatic",
    controlEpoch: 2,
    launchId: "launch-15",
    model: "",
    reasoning: "",
  });
  expect(launches()).toBe(1);
  expect(results.at(-1)).toMatchObject({ phase: "started", requestId: "automatic" });
  expect(record()).toMatchObject({ phase: "running" });
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
    rebind: async () => undefined,
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
      rebind: async () => undefined,
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
      launchId: "launch-16",
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
      rebind: async () => undefined,
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
      rebind: async () => undefined,
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
    launchId: "launch-17",
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
      rebind: async () => undefined,
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
    rebind: async () => undefined,
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

  // Non-fatal: the daemon-level outcome is plain "workspace-reset", never "failed" — matching
  // Raft 1.0.32, which only logs a clear failure and reports nothing on the wire for it.
  expect(record).toMatchObject({ phase: "workspace-reset" });
  expect(record?.identity).toBeUndefined();
  const resetResult = results.at(-1);
  expect(resetResult).toEqual({ ...scope, phase: "workspace-reset", sequence: 2 });

  const failureLog = logs.find(
    (entry) => entry.properties.event === "agent_control:workspace_clear_failed",
  );
  expect(failureLog?.level).toBe("error");
  expect(failureLog?.properties).toMatchObject({
    request_id: "reset-a",
    workspace_id: "w",
    computer_id: "c",
    agent_id: "a",
    error_code: "Error",
    outcome: "failed",
  });

  // The chain still proceeds: Start is not blocked by the clear failure.
  const start: AgentStartIntent = {
    ...scope,
    controlEpoch: 1,
    launchId: "launch-18",
    model: "",
    reasoning: "",
  };
  await control.start(start);
  expect(launches).toBe(1);
  expect(results.at(-1)).toMatchObject({ phase: "started" });
  expect(sentSessions).toBe(0);
  await sessions.replay("a");
  expect(sentSessions).toBe(1);
});

test("a workspace clear failure does not weaken confirmed_stop_required: a later reset without a fresh stop still throws", async () => {
  let record: AgentRuntimeRecord | undefined;
  let active = true;
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
  const control = new AgentControl("daemon", state, new AgentSessions(state, async () => {}), {
    running: () => active,
    cleanupUnconfirmed,
    rebind: async () => undefined,
    async stop() {
      active = false;
      return { sessionId: "old", state: "resumable" };
    },
    async launch() {
      active = true;
      return { sessionId: "new", state: "empty" };
    },
    async result(result) {
      results.push(result);
    },
  });
  const scope: AgentWorkspaceResetRequest = {
    protocolMajor: 1,
    requestId: "reset-b",
    workspaceId: "w",
    computerId: "c",
    agentId: "a",
    provider: "pi",
    epoch: 1,
  };
  // First reset: confirmed Stop, then a non-fatal clear failure. This must still complete and
  // proceed, exactly like the test above.
  await control.stop(scope);
  await control.resetWorkspace(scope);
  expect(record).toMatchObject({ phase: "workspace-reset" });
  await control.start({
    ...scope,
    controlEpoch: 1,
    launchId: "launch-19",
    model: "",
    reasoning: "",
  });
  expect(record).toMatchObject({ phase: "running" });

  // Second reset at a new epoch: no fresh Stop has been confirmed for this epoch, so the
  // deliberate confirmed_stop_required guard still applies — a prior clear failure never
  // weakens it.
  const next = { ...scope, requestId: "reset-c", epoch: 2 };
  await expect(control.resetWorkspace(next)).rejects.toThrow("confirmed_stop_required");
  expect(record).toMatchObject({ phase: "running" });
});

function rebindScope(overrides: Partial<AgentStartIntent> = {}): AgentStartIntent {
  return {
    protocolMajor: 1,
    requestId: "start-1",
    workspaceId: "w",
    computerId: "c",
    agentId: "a",
    provider: "codex",
    model: "",
    reasoning: "",
    controlEpoch: 1,
    launchId: "launch-old",
    ...overrides,
  };
}

test("a Start that meets an already-running process under an older, terminal operation rebinds (ADR 0041)", async () => {
  let record: AgentRuntimeRecord | undefined;
  let active = false;
  let launches = 0;
  let rebinds = 0;
  let wakes = 0;
  const results: AgentControlResult[] = [];
  const store: AgentRuntimeStateStore = {
    listAgentIds: async () => [],
    workspaceExists: async () => false,
    read: async () => record && structuredClone(record),
    write: async (_id, value) => {
      record = structuredClone(value);
    },
    clearWorkspace: async () => {},
  };
  const state = new AgentRuntimeState(store);
  const control = new AgentControl("daemon", state, new AgentSessions(state, async () => {}), {
    running: () => active,
    cleanupUnconfirmed,
    async stop() {
      active = false;
      return undefined;
    },
    async launch() {
      launches++;
      active = true;
      return { sessionId: "native-1", state: "resumable" };
    },
    async wake() {
      wakes++;
    },
    async rebind() {
      rebinds++;
      return { sessionId: "native-1", state: "resumable" };
    },
    async result(result) {
      results.push(result);
    },
  });

  await control.start(rebindScope());
  expect(launches).toBe(1);
  expect(record).toMatchObject({ phase: "running", launchId: "launch-old" });

  const { records: logs } = await captureLogs(() =>
    control.start(
      rebindScope({
        requestId: "start-2",
        controlEpoch: 2,
        launchId: "launch-new",
        wakeMessage: {
          messageId: "m1",
          deliveryId: "d1",
          conversationId: "c1",
          sequence: 1,
          target: "@a",
          latestSender: "@u",
          body: "hi",
        },
      }),
    ),
  );

  // No second process was ever launched; the running one was rebound instead.
  expect(launches).toBe(1);
  expect(rebinds).toBe(1);
  expect(wakes).toBe(1);
  expect(record).toMatchObject({
    phase: "running",
    launchId: "launch-new",
    daemonInstanceId: "daemon",
    identity: { sessionId: "native-1", state: "resumable" },
    scope: { requestId: "start-2", epoch: 2, provider: "codex" },
  });
  // The previous epoch's own receipts never leak into this epoch's replay logic.
  expect(record?.stopResult).toBeUndefined();
  expect(record?.workspaceResetResult).toBeUndefined();

  const started = results.filter((r) => r.phase === "started");
  expect(started).toHaveLength(2);
  expect(started[1]).toMatchObject({
    requestId: "start-2",
    epoch: 2,
    launchId: "launch-new",
    phase: "started",
    identity: { sessionId: "native-1", state: "resumable" },
  });

  const rebound = logs.find((entry) => entry.properties.event === "agent_control:start_rebound");
  expect(rebound?.level).toBe("info");
  expect(rebound?.properties).toMatchObject({
    agent_id: "a",
    request_id: "start-2",
    previous_epoch: 1,
    epoch: 2,
    launch_id: "launch-new",
    outcome: "rebound",
  });
});

test("an equal-epoch replay after a rebind re-sends the rebound result without rebinding again", async () => {
  let record: AgentRuntimeRecord | undefined;
  let active = false;
  let launches = 0;
  let rebinds = 0;
  const results: AgentControlResult[] = [];
  const store: AgentRuntimeStateStore = {
    listAgentIds: async () => [],
    workspaceExists: async () => false,
    read: async () => record && structuredClone(record),
    write: async (_id, value) => {
      record = structuredClone(value);
    },
    clearWorkspace: async () => {},
  };
  const state = new AgentRuntimeState(store);
  const control = new AgentControl("daemon", state, new AgentSessions(state, async () => {}), {
    running: () => active,
    cleanupUnconfirmed,
    async stop() {
      active = false;
      return undefined;
    },
    async launch() {
      launches++;
      active = true;
      return { sessionId: "native-1", state: "resumable" };
    },
    async rebind() {
      rebinds++;
      return { sessionId: "native-1", state: "resumable" };
    },
    async result(result) {
      results.push(result);
    },
  });

  await control.start(rebindScope());
  const rebound = rebindScope({ requestId: "start-2", controlEpoch: 2, launchId: "launch-new" });
  await control.start(rebound);
  expect(rebinds).toBe(1);

  await control.start(rebound);
  await control.start(rebound);

  expect(launches).toBe(1);
  expect(rebinds).toBe(1);
  const started = results.filter((r) => r.phase === "started" && r.requestId === "start-2");
  expect(started).toHaveLength(3);
  expect(new Set(started.map((r) => r.launchId))).toEqual(new Set(["launch-new"]));
});

test("a lower epoch is still rejected as stale even while the process is running", async () => {
  let record: AgentRuntimeRecord | undefined;
  const store: AgentRuntimeStateStore = {
    listAgentIds: async () => [],
    workspaceExists: async () => false,
    read: async () => record && structuredClone(record),
    write: async (_id, value) => {
      record = structuredClone(value);
    },
    clearWorkspace: async () => {},
  };
  const state = new AgentRuntimeState(store);
  let active = false;
  const control = new AgentControl("daemon", state, new AgentSessions(state, async () => {}), {
    running: () => active,
    cleanupUnconfirmed,
    stop: async () => undefined,
    async launch() {
      active = true;
      return { sessionId: "native-1", state: "resumable" };
    },
    async rebind() {
      throw new Error("must not rebind a stale request");
    },
    async result() {},
  });
  await control.start(rebindScope({ controlEpoch: 5, launchId: "launch-5" }));
  await expect(
    control.start(rebindScope({ requestId: "start-old", controlEpoch: 3, launchId: "launch-3" })),
  ).rejects.toThrow("stale_control_request");
});

test("a running record with a different provider is not rebound", async () => {
  let record: AgentRuntimeRecord | undefined;
  const results: AgentControlResult[] = [];
  const store: AgentRuntimeStateStore = {
    listAgentIds: async () => [],
    workspaceExists: async () => false,
    read: async () => record && structuredClone(record),
    write: async (_id, value) => {
      record = structuredClone(value);
    },
    clearWorkspace: async () => {},
  };
  const state = new AgentRuntimeState(store);
  let active = false;
  const control = new AgentControl("daemon", state, new AgentSessions(state, async () => {}), {
    running: () => active,
    cleanupUnconfirmed,
    stop: async () => undefined,
    async launch() {
      active = true;
      return { sessionId: "native-1", state: "resumable" };
    },
    async rebind() {
      throw new Error("must not rebind across a provider mismatch");
    },
    async result(result) {
      results.push(result);
    },
  });
  await control.start(rebindScope({ provider: "codex", controlEpoch: 1, launchId: "launch-1" }));
  await expect(
    control.start(
      rebindScope({
        requestId: "start-2",
        provider: "claude-code",
        controlEpoch: 2,
        launchId: "launch-2",
      }),
    ),
  ).rejects.toThrow("agent_already_running");
  expect(results.at(-1)).toMatchObject({
    phase: "failed",
    requestId: "start-2",
    errorCode: "agent_already_running",
  });
});

test("record phase starting still rejects with previous_control_not_completed even while running", async () => {
  let record: AgentRuntimeRecord | undefined;
  const store: AgentRuntimeStateStore = {
    listAgentIds: async () => [],
    workspaceExists: async () => false,
    read: async () => record && structuredClone(record),
    write: async (_id, value) => {
      record = structuredClone(value);
    },
    clearWorkspace: async () => {},
  };
  const state = new AgentRuntimeState(store);
  const scope: AgentControlScope = {
    protocolMajor: 1,
    requestId: "start-1",
    workspaceId: "w",
    computerId: "c",
    agentId: "a",
    provider: "codex",
    epoch: 1,
  };
  record = {
    version: 1,
    scope,
    action: "start",
    phase: "starting",
    daemonInstanceId: "daemon",
    sequence: 0,
    launchId: "launch-1",
  };
  const control = new AgentControl("daemon", state, new AgentSessions(state, async () => {}), {
    running: () => true,
    cleanupUnconfirmed,
    stop: async () => undefined,
    async launch() {
      return { sessionId: "native-1", state: "resumable" };
    },
    async rebind() {
      throw new Error("must not rebind a still-launching operation");
    },
    async result() {},
  });
  await expect(
    control.start(rebindScope({ requestId: "start-2", controlEpoch: 2, launchId: "launch-2" })),
  ).rejects.toThrow("previous_control_not_completed");
});

test("a running process with no matching running record sends a failed result instead of hanging", async () => {
  let record: AgentRuntimeRecord | undefined;
  const results: AgentControlResult[] = [];
  const store: AgentRuntimeStateStore = {
    listAgentIds: async () => [],
    workspaceExists: async () => false,
    read: async () => record && structuredClone(record),
    write: async (_id, value) => {
      record = structuredClone(value);
    },
    clearWorkspace: async () => {},
  };
  const state = new AgentRuntimeState(store);
  const control = new AgentControl("daemon", state, new AgentSessions(state, async () => {}), {
    running: () => true,
    cleanupUnconfirmed,
    stop: async () => undefined,
    async launch() {
      return { sessionId: "native-1", state: "resumable" };
    },
    async rebind() {
      throw new Error("must not rebind with no matching record");
    },
    async result(result) {
      results.push(result);
    },
  });
  await expect(control.start(rebindScope())).rejects.toThrow("agent_already_running");
  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({
    phase: "failed",
    requestId: "start-1",
    errorCode: "agent_already_running",
  });
});

test("back-to-back Starts for the same Agent serialize through state.run: exactly one launch, the second rebinds", async () => {
  let record: AgentRuntimeRecord | undefined;
  let active = false;
  let launches = 0;
  let rebinds = 0;
  const results: AgentControlResult[] = [];
  const store: AgentRuntimeStateStore = {
    listAgentIds: async () => [],
    workspaceExists: async () => false,
    read: async () => record && structuredClone(record),
    write: async (_id, value) => {
      record = structuredClone(value);
    },
    clearWorkspace: async () => {},
  };
  const state = new AgentRuntimeState(store);
  const control = new AgentControl("daemon", state, new AgentSessions(state, async () => {}), {
    running: () => active,
    cleanupUnconfirmed,
    stop: async () => undefined,
    async launch() {
      launches++;
      // Yield so a concurrently-issued second Start's `state.run` callback provably queues
      // behind this one instead of interleaving.
      await Promise.resolve();
      active = true;
      return { sessionId: "native-1", state: "resumable" };
    },
    async rebind() {
      rebinds++;
      return { sessionId: "native-1", state: "resumable" };
    },
    async result(result) {
      results.push(result);
    },
  });

  const first = rebindScope();
  const second = rebindScope({ requestId: "start-2", controlEpoch: 2, launchId: "launch-new" });
  await Promise.all([control.start(first), control.start(second)]);

  expect(launches).toBe(1);
  expect(rebinds).toBe(1);
  expect(record).toMatchObject({ phase: "running", launchId: "launch-new" });
  const started = results.filter((r) => r.phase === "started");
  expect(started).toHaveLength(2);
});

test("a managed Start intent with no launchId sends a failed result instead of minting one locally (ADR 0041)", async () => {
  let record: AgentRuntimeRecord | undefined;
  const results: AgentControlResult[] = [];
  let launches = 0;
  const store: AgentRuntimeStateStore = {
    listAgentIds: async () => [],
    workspaceExists: async () => false,
    read: async () => record && structuredClone(record),
    write: async (_id, value) => {
      record = structuredClone(value);
    },
    clearWorkspace: async () => {},
  };
  const state = new AgentRuntimeState(store);
  const control = new AgentControl("daemon", state, new AgentSessions(state, async () => {}), {
    running: () => false,
    cleanupUnconfirmed,
    stop: async () => undefined,
    async launch() {
      launches++;
      return { sessionId: "native-1", state: "resumable" };
    },
    async rebind() {
      throw new Error("must not rebind here");
    },
    async result(result) {
      results.push(result);
    },
  });
  // The server always supplies launchId for a managed (controlEpoch-carrying) start; the SDK
  // decode step already rejects one with none, so this exercises the daemon's own defensive
  // guard for a malformed intent that somehow still reaches AgentControl.
  const intent = rebindScope();
  delete intent.launchId;
  await expect(control.start(intent)).rejects.toThrow("agent_launch_id_required");
  expect(launches).toBe(0);
  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({
    phase: "failed",
    requestId: "start-1",
    errorCode: "agent_launch_id_required",
  });
});
