import { expect, test } from "bun:test";
import type { LogRecord } from "@logtape/logtape";
import { configure, reset } from "@logtape/logtape";
import { AgentControl, type LaunchRetryScheduler } from "../src/agent-runtime/agent-control";
import { AgentSessions } from "../src/agent-runtime/agent-session";
import {
  AgentRuntimeState,
  type AgentRuntimeRecord,
} from "../src/agent-runtime/agent-runtime-state";
import type {
  AgentControlResult,
  AgentStartIntent,
  SessionIdentity,
} from "@lrm/coforge-sdk/internal";
import { LAUNCH_FAILURE_MAX_ATTEMPTS } from "../src/agent-runtime/launch-failure-backoff";

/** A scheduler that only records what `AgentControl` asked for, so a test drives every retry
 * itself instead of sleeping through real cooldowns. */
function manualScheduler() {
  type Entry = { callback: () => void; delayMs: number; cancelled: boolean };
  const entries: Entry[] = [];
  const scheduler: LaunchRetryScheduler = {
    schedule(callback, delayMs) {
      const entry: Entry = { callback, delayMs, cancelled: false };
      entries.push(entry);
      return entry;
    },
    cancel(handle) {
      (handle as Entry).cancelled = true;
    },
  };
  const live = () => entries.filter((entry) => !entry.cancelled);
  return {
    scheduler,
    entries,
    delays: () => entries.map((entry) => entry.delayMs),
    /** Fires the most recently armed retry and lets its `state.run` chain settle. */
    async fireLatest(): Promise<void> {
      const entry = live().at(-1);
      if (!entry) throw new Error("no retry armed");
      entry.callback();
      await settle();
    },
  };
}

/** Lets the fire-and-forget retry chain in `AgentControl` finish (its store is in memory, so a
 * few macrotask turns are enough). */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

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

const startIntent: AgentStartIntent = {
  protocolMajor: 1,
  requestId: "r",
  workspaceId: "w",
  computerId: "c",
  agentId: "a",
  provider: "pi",
  model: "default",
  reasoning: "",
  controlEpoch: 1,
  launchId: "launch-1",
};

function harness(launch: (attempt: number) => Promise<SessionIdentity | undefined>) {
  let record: AgentRuntimeRecord | undefined;
  const results: AgentControlResult[] = [];
  const launches: number[] = [];
  const state = new AgentRuntimeState({
    listAgentIds: async () => [],
    workspaceExists: async () => false,
    read: async () => record && structuredClone(record),
    write: async (_id, value) => {
      record = structuredClone(value);
    },
    clearWorkspace: async () => {},
  });
  const timers = manualScheduler();
  const control = new AgentControl(
    "daemon",
    state,
    new AgentSessions(state, async () => {}),
    {
      running: () => false,
      rebind: async () => undefined,
      stop: async () => undefined,
      async launch() {
        launches.push(launches.length + 1);
        return launch(launches.length);
      },
      async result(result) {
        results.push(result);
      },
    },
    timers.scheduler,
  );
  return { control, results, launches, timers, record: () => record };
}

test("a failed launch is counted, retried after the cooldown, and reports started once it succeeds", async () => {
  const h = harness(async (attempt) => {
    if (attempt === 1) throw new Error("spawn blew up");
    return { sessionId: "fresh", state: "empty" };
  });

  await h.control.start(startIntent);
  // The failure no longer ends the operation: nothing terminal is reported, the record stays a
  // live "starting" so a later daemon instance repairs/recover it, and exactly one retry is armed.
  expect(h.launches).toEqual([1]);
  expect(h.results).toEqual([]);
  expect(h.record()?.phase).toBe("starting");
  expect(h.timers.delays()).toEqual([1_000]);

  await h.timers.fireLatest();
  expect(h.launches).toEqual([1, 2]);
  expect(h.results.at(-1)?.phase).toBe("started");
  expect(h.results.at(-1)?.identity?.sessionId).toBe("fresh");
  expect(h.record()?.phase).toBe("running");
  // A successful retry resets the streak and arms nothing further.
  expect(h.timers.delays()).toEqual([1_000]);
});

test("consecutive failures back off 1s, 2s, 4s... 30s and then report launch_failed", async () => {
  const h = harness(async () => {
    throw new Error("never spawns");
  });

  await h.control.start(startIntent);
  for (let attempt = 1; attempt < LAUNCH_FAILURE_MAX_ATTEMPTS; attempt++) {
    await h.timers.fireLatest();
  }

  expect(h.launches).toHaveLength(LAUNCH_FAILURE_MAX_ATTEMPTS);
  expect(h.timers.delays()).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000]);
  // Only after every attempt is used up does the operation end exactly as it used to.
  expect(h.results).toHaveLength(1);
  expect(h.results[0]).toMatchObject({ phase: "failed", errorCode: "launch_failed" });
  expect(h.record()?.phase).toBe("failed");
  expect(h.record()?.lastResult?.phase).toBe("failed");
});

test("the terminal launch-failed warning carries the classified launch trace", async () => {
  const classified = Object.assign(new Error("Pi model not found: gpt-5"), {
    name: "PiLaunchError",
    policyCode: "PI_LAUNCH_MODEL_MISSING",
    trace: {
      provider: "ollama-cloud",
      providerPresent: true,
      providerKeyPresent: true,
      baseUrlPresent: true,
      modelPresent: false,
    },
  });

  const { records } = await captureLogs(async () => {
    const h = harness(async () => {
      throw classified;
    });
    await h.control.start(startIntent);
    for (let attempt = 1; attempt < LAUNCH_FAILURE_MAX_ATTEMPTS; attempt++) {
      await h.timers.fireLatest();
    }
    return h;
  });

  const terminal = records.find(
    (record) => record.properties.event === "agent_control:launch_failed",
  );
  expect(terminal?.properties).toMatchObject({
    agent_id: "a",
    attempts: LAUNCH_FAILURE_MAX_ATTEMPTS,
    error_code: "PiLaunchError",
    launchCategory: "PI_LAUNCH_MODEL_MISSING",
    provider: "ollama-cloud",
    providerPresent: true,
    providerKeyPresent: true,
    baseUrlPresent: true,
    modelPresent: false,
  });
  // The retry warnings carry the same evidence, so one exhausted launch is diagnosable from the
  // first backoff to the terminal record instead of only the retry line above it.
  const retry = records.find(
    (record) => record.properties.event === "agent_control:launch_retry_scheduled",
  );
  expect(retry?.properties).toMatchObject({
    launchCategory: "PI_LAUNCH_MODEL_MISSING",
    modelPresent: false,
  });
});

test("each retry keeps the managed scope and launchId of the operation it is recovering", async () => {
  const intents: AgentStartIntent[] = [];
  const launchIds: string[] = [];
  let record: AgentRuntimeRecord | undefined;
  const results: AgentControlResult[] = [];
  const state = new AgentRuntimeState({
    listAgentIds: async () => [],
    workspaceExists: async () => false,
    read: async () => record && structuredClone(record),
    write: async (_id, value) => {
      record = structuredClone(value);
    },
    clearWorkspace: async () => {},
  });
  const timers = manualScheduler();
  const control = new AgentControl(
    "daemon",
    state,
    new AgentSessions(state, async () => {}),
    {
      running: () => false,
      rebind: async () => undefined,
      stop: async () => undefined,
      async launch(intent, launchId) {
        intents.push(structuredClone(intent));
        launchIds.push(launchId);
        if (intents.length === 1) throw new Error("first attempt fails");
        return { sessionId: "fresh", state: "empty" };
      },
      async result(result) {
        results.push(result);
      },
    },
    timers.scheduler,
  );

  await control.start(startIntent);
  await timers.fireLatest();

  // The server authorizes a daemon-side relaunch only while its operation is still `starting`
  // with a matching requestId/epoch/launchId, so a retry must reuse that scope verbatim.
  expect(intents).toHaveLength(2);
  expect(intents[1]).toEqual(intents[0]!);
  expect(launchIds).toEqual(["launch-1", "launch-1"]);
  expect(results.at(-1)).toMatchObject({ phase: "started", requestId: "r", epoch: 1 });
});

test("a newer Start supersedes the armed retry instead of being refused for the whole window", async () => {
  const h = harness(async (attempt) => {
    if (attempt === 1) throw new Error("cannot spawn");
    return { sessionId: "fresh", state: "empty" };
  });

  await h.control.start(startIntent);
  expect(h.timers.delays()).toEqual([1_000]);

  // A user's Start/Restart arriving while we back off must launch immediately: the retry is a
  // daemon-side timer, not a concurrent launch, so there is nothing for it to race.
  await h.control.start({
    ...startIntent,
    requestId: "r2",
    controlEpoch: 2,
    launchId: "launch-2",
  });

  expect(h.launches).toEqual([1, 2]);
  expect(h.results.at(-1)).toMatchObject({ phase: "started", requestId: "r2", epoch: 2 });
  expect(h.record()?.launchId).toBe("launch-2");
  expect(h.timers.entries.every((entry) => entry.cancelled)).toBe(true);
});

test("an accepted Stop cancels the armed retry instead of letting it spawn behind the Stop", async () => {
  const h = harness(async () => {
    throw new Error("cannot spawn");
  });

  await h.control.start(startIntent);
  expect(h.timers.delays()).toEqual([1_000]);

  await h.control.stop({
    protocolMajor: 1,
    requestId: "stop-1",
    workspaceId: "w",
    computerId: "c",
    agentId: "a",
    provider: "pi",
    epoch: 2,
  });

  expect(h.timers.entries.every((entry) => entry.cancelled)).toBe(true);
  expect(h.record()?.phase).toBe("stopped");
  // Firing a cancelled timer must do nothing: the retry re-reads the record and finds a phase it
  // does not own (a fresh "starting" epoch would be needed for another attempt).
  h.timers.entries[0]!.cancelled = false;
  h.timers.entries[0]!.callback();
  await settle();
  expect(h.launches).toEqual([1]);
});

test("dispose drops armed retries and failure streaks", async () => {
  const h = harness(async () => {
    throw new Error("cannot spawn");
  });

  await h.control.start(startIntent);
  expect(h.timers.delays()).toEqual([1_000]);
  h.control.dispose();
  // `cancel` is what stops the real timer; nothing re-arms it, because a disposed control owns no
  // record the retry callback would accept (and the next daemon instance rebuilds from disk).
  expect(h.timers.entries.every((entry) => entry.cancelled)).toBe(true);
});

test("the retry backoff and its recovery are logged with attempts and cooldown", async () => {
  const { records } = await captureLogs(async () => {
    const h = harness(async (attempt) => {
      if (attempt === 1) throw new Error("spawn blew up");
      return { sessionId: "fresh", state: "empty" };
    });
    await h.control.start(startIntent);
    await h.timers.fireLatest();
    return h;
  });

  const scheduled = records.find(
    (record) => record.properties.event === "agent_control:launch_retry_scheduled",
  );
  expect(scheduled?.properties).toMatchObject({
    agent_id: "a",
    attempt: 1,
    attempts: 1,
    cooldown_ms: 1_000,
    error_code: "Error",
  });
  const recovered = records.find(
    (record) => record.properties.event === "agent_control:launch_retry_recovered",
  );
  expect(recovered?.properties).toMatchObject({ agent_id: "a", attempts: 1 });
  // The terminal "launch failed" warning is reserved for a launch that exhausted its retries.
  expect(records.some((record) => record.properties.event === "agent_control:launch_failed")).toBe(
    false,
  );
});
