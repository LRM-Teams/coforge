import { afterAll, afterEach, expect, jest, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { DaemonRuntime, type WorkspaceConfig } from "../src/daemon-runtime/runtime";
import type { AgentRuntimeConfig, AgentSession } from "../src/code-agent/contract";
import { InMemoryDaemonCredentialStore } from "../src/credentials/credential-store";
import type { AgentActivity, AgentActivityDetailKind } from "@lrm/coforge-sdk/internal";

// macOS tmpdir lives under /var, a symlink; the state store rejects linked ancestors.
const tempRoot = realpathSync(tmpdir());
const workspaceRoot = join(tempRoot, `coforge-activity-heartbeat-${crypto.randomUUID()}`);
const connection: WorkspaceConfig = {
  computerId: "computer-a",
  workspaceId: "workspace-a",
  workspaceRoot,
};

afterAll(() => rm(workspaceRoot, { recursive: true, force: true }));
afterEach(() => jest.useRealTimers());

const config: AgentRuntimeConfig = {
  provider: "pi",
  model: "default",
  modelProvider: "anthropic",
  reasoning: "balanced",
};

function sessionSpy() {
  return {
    async sendMessage() {},
    subscribe() {
      return () => undefined;
    },
    async interrupt() {},
    onExit() {
      return () => undefined;
    },
    async dispose() {},
  } satisfies AgentSession;
}

function agentLaunchConfig(agentApiKey: string) {
  return { agentApiKey };
}

/** Boots a runtime whose one Agent session hands the test direct control over runtime events. */
async function harness() {
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");
  const activities: AgentActivity[] = [];
  let listener: Parameters<AgentSession["subscribe"]>[0] = () => undefined;
  const runtime = new DaemonRuntime(
    connection,
    () => ({
      provider: "pi",
      async createAgentSession() {
        return {
          ...sessionSpy(),
          subscribe(next) {
            listener = next;
            return () => undefined;
          },
        };
      },
    }),
    credentials,
    {
      create: () => ({
        async start() {},
        async ready() {},
        async stop() {},
        sendAgentActivity(activity) {
          activities.push(activity);
        },
        async requestAgentLaunchConfig() {
          return agentLaunchConfig(`sk_agent_${"a".repeat(43)}`);
        },
        async revokeAgentApiKey() {},
      }),
    },
  );
  await runtime.start(connection);
  await runtime.startAgent("agent-a", config);
  return {
    runtime,
    activities,
    emit(activity: {
      detailKind: AgentActivityDetailKind;
      level: AgentActivity["level"];
      detail: string;
    }) {
      listener({ type: "activity", activity: { ...activity, observedAtMs: Date.now() } });
    },
  };
}

test("re-sends the last busy Activity every heartbeat interval while the Agent stays busy", async () => {
  const { runtime, activities, emit } = await harness();
  jest.useFakeTimers();
  try {
    activities.length = 0;
    emit({ detailKind: "tool_started", level: "info", detail: "Read" });
    expect(activities).toHaveLength(1);
    const seqAfterFirst = activities[0]!.clientSeq;

    jest.advanceTimersByTime(60_000);
    expect(activities).toHaveLength(2);
    expect(activities[1]).toMatchObject({ detailKind: "tool_started", isHeartbeat: true });
    expect(activities[1]!.clientSeq).toBeGreaterThan(seqAfterFirst);
    expect(activities[1]!.entries ?? []).toHaveLength(0);

    jest.advanceTimersByTime(60_000);
    expect(activities).toHaveLength(3);
    expect(activities[2]).toMatchObject({ detailKind: "tool_started", isHeartbeat: true });
    expect(activities[2]!.clientSeq).toBeGreaterThan(activities[1]!.clientSeq);
  } finally {
    await runtime.stop();
  }
});

test("idle stops the heartbeat", async () => {
  const { runtime, activities, emit } = await harness();
  jest.useFakeTimers();
  try {
    activities.length = 0;
    emit({ detailKind: "thinking_started", level: "info", detail: "" });
    emit({ detailKind: "idle", level: "info", detail: "" });
    const countAfterIdle = activities.length;
    jest.advanceTimersByTime(600_000);
    expect(activities).toHaveLength(countAfterIdle);
  } finally {
    await runtime.stop();
  }
});

test("runtime_error stops the heartbeat", async () => {
  const { runtime, activities, emit } = await harness();
  jest.useFakeTimers();
  try {
    activities.length = 0;
    emit({ detailKind: "running_command", level: "info", detail: "ls" });
    emit({ detailKind: "runtime_error", level: "error", detail: "boom" });
    const countAfterError = activities.length;
    jest.advanceTimersByTime(600_000);
    expect(activities).toHaveLength(countAfterError);
  } finally {
    await runtime.stop();
  }
});

test("stopping the Agent's launch stops the heartbeat without leaking a timer", async () => {
  const { runtime, activities, emit } = await harness();
  jest.useFakeTimers();
  try {
    activities.length = 0;
    emit({ detailKind: "model_response_started", level: "info", detail: "" });
    expect(jest.getTimerCount()).toBeGreaterThan(0);
    await runtime.stopAgent("agent-a");
    expect(jest.getTimerCount()).toBe(0);
    const countAfterStop = activities.length;
    jest.advanceTimersByTime(600_000);
    expect(activities).toHaveLength(countAfterStop);
  } finally {
    await runtime.stop();
  }
});

test("stopping the runtime clears every pending heartbeat timer", async () => {
  const { runtime, emit } = await harness();
  jest.useFakeTimers();
  emit({ detailKind: "running_command", level: "info", detail: "ls" });
  expect(jest.getTimerCount()).toBeGreaterThan(0);
  await runtime.stop();
  expect(jest.getTimerCount()).toBe(0);
});

test("no heartbeat is scheduled once Activity is disabled", async () => {
  const { runtime, activities, emit } = await harness();
  await runtime.stop();
  jest.useFakeTimers();
  const countAfterStop = activities.length;
  emit({ detailKind: "tool_started", level: "info", detail: "Read" });
  jest.advanceTimersByTime(600_000);
  expect(activities).toHaveLength(countAfterStop);
});

test("rate-limits runtime_progress to at most one every 10s per Agent", async () => {
  const { runtime, activities, emit } = await harness();
  jest.useFakeTimers();
  try {
    activities.length = 0;
    emit({ detailKind: "runtime_progress", level: "info", detail: "" });
    emit({ detailKind: "runtime_progress", level: "info", detail: "" });
    jest.advanceTimersByTime(9_999);
    emit({ detailKind: "runtime_progress", level: "info", detail: "" });
    expect(activities.filter((a) => !a.isHeartbeat)).toHaveLength(1);

    jest.advanceTimersByTime(1);
    emit({ detailKind: "runtime_progress", level: "info", detail: "" });
    expect(activities.filter((a) => !a.isHeartbeat)).toHaveLength(2);
    expect(activities[0]).toMatchObject({ detailKind: "runtime_progress", detail: "" });
  } finally {
    await runtime.stop();
  }
});
