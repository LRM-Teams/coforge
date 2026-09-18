import { afterAll, afterEach, expect, jest, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { DaemonRuntime, type WorkspaceConfig } from "../src/daemon-runtime/runtime";
import type {
  AgentRuntimeConfig,
  AgentRuntimeEvent,
  AgentSession,
} from "../src/code-agent/contract";
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

// Without this, DaemonRuntime falls back to real Code Agent discovery, which spawns Pi's
// embedded SDK in the background to report its live model catalog (see runtime.ts
// #reportCodeAgentCatalogs). That background work outlives `await runtime.start()`, uses real
// timers of its own (Pi's session-lock renewal), and races the test's `jest.useFakeTimers()` -
// leaking timers the heartbeat tests never armed. daemon-runtime.test.ts already stubs this for
// the same reason.
const emptyCodeAgentDiscovery = {
  runtimes: async () => [],
  cachedCatalogs: async () => ({ catalogs: [], needsRefresh: false }),
  catalogs: async () => [],
};

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
    undefined,
    emptyCodeAgentDiscovery,
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
      entries?: AgentActivity["entries"];
    }) {
      listener({ type: "activity", activity: { ...activity, observedAtMs: Date.now() } });
    },
    /** Raw AgentRuntimeEvent injection, for events with no activity shorthand
     * (tool-end, completed). */
    emitEvent(event: AgentRuntimeEvent) {
      listener(event);
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

test("busy Agent replies to an activity probe with the remembered activity and re-arms the heartbeat", async () => {
  const { runtime, activities, emit } = await harness();
  jest.useFakeTimers();
  try {
    activities.length = 0;
    emit({ detailKind: "tool_started", level: "info", detail: "Read" });
    expect(activities).toHaveLength(1);

    jest.advanceTimersByTime(30_000);
    await runtime.handleAgentActivityProbe({
      protocolMajor: 1,
      requestId: "probe-request-1",
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      agentId: "agent-a",
      probeId: "probe-1",
    });

    expect(activities).toHaveLength(2);
    expect(activities[1]).toMatchObject({
      detailKind: "tool_started",
      probeId: "probe-1",
      isHeartbeat: false,
    });
    expect(activities[1]!.entries ?? []).toHaveLength(0);

    // The original 60s heartbeat (armed at t=0) would have fired at t=60_000; the probe reply at
    // t=30_000 re-arms it, so nothing more is due until t=90_000.
    jest.advanceTimersByTime(59_999);
    expect(activities).toHaveLength(2);

    jest.advanceTimersByTime(1);
    expect(activities).toHaveLength(3);
    expect(activities[2]).toMatchObject({ detailKind: "tool_started", isHeartbeat: true });
  } finally {
    await runtime.stop();
  }
});

test("idle launched Agent replies to an activity probe with idle", async () => {
  const { runtime, activities, emit } = await harness();
  jest.useFakeTimers();
  try {
    activities.length = 0;
    emit({ detailKind: "idle", level: "info", detail: "" });
    expect(activities).toHaveLength(1);

    await runtime.handleAgentActivityProbe({
      protocolMajor: 1,
      requestId: "probe-request-2",
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      agentId: "agent-a",
      probeId: "probe-2",
    });

    expect(activities).toHaveLength(2);
    expect(activities[1]).toMatchObject({ detailKind: "idle", probeId: "probe-2" });
  } finally {
    await runtime.stop();
  }
});

test("an activity probe for an unknown Agent sends nothing", async () => {
  const { runtime, activities } = await harness();
  jest.useFakeTimers();
  try {
    activities.length = 0;
    await runtime.handleAgentActivityProbe({
      protocolMajor: 1,
      requestId: "probe-request-3",
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      agentId: "agent-unknown",
      probeId: "probe-3",
    });

    expect(activities).toHaveLength(0);
  } finally {
    await runtime.stop();
  }
});

test("a progress event announces runtime_progress while the Agent is not yet visibly busy", async () => {
  const { runtime, activities, emitEvent } = await harness();
  try {
    activities.length = 0;
    emitEvent({ type: "progress" });
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({ detailKind: "runtime_progress", detail: "" });
    // A second ping before anything else makes the Agent look busy still announces: the first
    // progress activity itself is now the Agent's last busy signal, so this is the "already
    // working" case exercised by the next test, not a rate-limit window.
  } finally {
    await runtime.stop();
  }
});

test("a progress event is suppressed once the Agent already looks busy, but keeps refreshing liveness", async () => {
  const { runtime, activities, emitEvent } = await harness();
  try {
    activities.length = 0;
    emitEvent({ type: "tool-start", id: "tool-1", name: "Bash" });
    emitEvent({
      type: "activity",
      activity: {
        detailKind: "tool_started",
        level: "info",
        detail: "ls",
        observedAtMs: Date.now(),
      },
    });
    activities.length = 0;
    emitEvent({ type: "progress" });
    emitEvent({ type: "progress" });
    // Suppressed: the Agent's last announced activity is already a visible busy kind.
    expect(activities).toHaveLength(0);
  } finally {
    await runtime.stop();
  }
});

test("a progress event never flushes buffered text or ends thinking", async () => {
  const { runtime, activities, emitEvent } = await harness();
  jest.useFakeTimers();
  try {
    activities.length = 0;
    emitEvent({ type: "progress" });
    // Not yet busy: the ping announces runtime_progress.
    expect(activities.map((a) => a.detailKind)).toEqual(["runtime_progress"]);
    emitEvent({ type: "text-delta", text: "still writing" });
    emitEvent({ type: "progress" });
    // Already busy (the run-start frame): the ping announces nothing and flushes nothing.
    expect(activities.map((a) => a.detailKind)).toEqual([
      "runtime_progress",
      "model_response_started",
    ]);
    jest.advanceTimersByTime(350);
    expect(activities.map((a) => a.detailKind)).toEqual([
      "runtime_progress",
      "model_response_started",
      "model_response_started",
    ]);
    expect(activities[2]?.entries).toMatchObject([{ kind: "text", text: "still writing" }]);
  } finally {
    await runtime.stop();
  }
});

test("compaction-started reports Compacting context once, and a repeat is deduped", async () => {
  const { runtime, activities, emitEvent } = await harness();
  try {
    activities.length = 0;
    emitEvent({ type: "compaction-started" });
    emitEvent({ type: "compaction-started" });
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({ detailKind: "compacting_context" });
  } finally {
    await runtime.stop();
  }
});

test("compaction-finished ends an open compaction, and without one is a no-op", async () => {
  const { runtime, activities, emitEvent } = await harness();
  try {
    activities.length = 0;
    emitEvent({ type: "compaction-finished" });
    expect(activities).toHaveLength(0);
    emitEvent({ type: "compaction-started" });
    activities.length = 0;
    emitEvent({ type: "compaction-finished" });
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({ detailKind: "compaction_finished" });
  } finally {
    await runtime.stop();
  }
});

test("resumed text after an open compaction infers it finished, reported before the resumed text", async () => {
  const { runtime, activities, emitEvent } = await harness();
  jest.useFakeTimers();
  try {
    emitEvent({ type: "compaction-started" });
    activities.length = 0;
    emitEvent({ type: "text-delta", text: "back to work" });
    jest.advanceTimersByTime(350);
    // Inferred finish, then the run-start frame, then the text.
    expect(activities.map((a) => a.detailKind)).toEqual([
      "compaction_finished",
      "model_response_started",
      "model_response_started",
    ]);
  } finally {
    await runtime.stop();
  }
});

test("a started tool after an open compaction infers it finished, reported before the tool", async () => {
  const { runtime, activities, emitEvent } = await harness();
  try {
    emitEvent({ type: "compaction-started" });
    activities.length = 0;
    emitEvent({ type: "tool-start", id: "tool-1", name: "Bash", input: { command: "ls" } });
    expect(activities.map((a) => a.detailKind)).toEqual(["compaction_finished", "running_command"]);
  } finally {
    await runtime.stop();
  }
});

test("a turn ending after an open compaction infers it finished, reported before idle", async () => {
  const { runtime, activities, emitEvent } = await harness();
  try {
    emitEvent({ type: "compaction-started" });
    activities.length = 0;
    emitEvent({ type: "completed", status: "completed" });
    expect(activities.map((a) => a.detailKind)).toEqual(["compaction_finished", "idle"]);
  } finally {
    await runtime.stop();
  }
});

test("compaction-interrupted silently clears an open compaction with no visible Activity", async () => {
  const { runtime, activities, emitEvent } = await harness();
  try {
    emitEvent({ type: "compaction-started" });
    activities.length = 0;
    emitEvent({ type: "compaction-interrupted" });
    expect(activities).toHaveLength(0);
    // Cleared: a later explicit finish is now a no-op too.
    emitEvent({ type: "compaction-finished" });
    expect(activities).toHaveLength(0);
  } finally {
    await runtime.stop();
  }
});

test("stopping the Agent's launch clears its compaction watchdog without leaking a timer", async () => {
  const { runtime, emitEvent } = await harness();
  jest.useFakeTimers();
  try {
    emitEvent({ type: "compaction-started" });
    expect(jest.getTimerCount()).toBeGreaterThan(0);
    await runtime.stopAgent("agent-a");
    expect(jest.getTimerCount()).toBe(0);
  } finally {
    await runtime.stop();
  }
});

// ADR 0021: tool_end/thinking_end/compaction_finished are busy-but-filler,
// exactly like runtime_progress — they re-arm the heartbeat.
for (const detailKind of ["tool_end", "thinking_end", "compaction_finished"] as const) {
  test(`${detailKind} is busy-but-filler: it re-arms the heartbeat`, async () => {
    const { runtime, activities, emit } = await harness();
    jest.useFakeTimers();
    try {
      activities.length = 0;
      emit({ detailKind, level: "info", detail: "" });
      expect(activities).toHaveLength(1);
      jest.advanceTimersByTime(60_000);
      expect(activities).toHaveLength(2);
      expect(activities[1]).toMatchObject({ detailKind, isHeartbeat: true });
    } finally {
      await runtime.stop();
    }
  });
}

test("tool-end AgentRuntimeEvent reports as tool_end", async () => {
  const { runtime, activities, emitEvent } = await harness();
  try {
    activities.length = 0;
    emitEvent({ type: "tool-end", id: "tool-1", isError: false });
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      detailKind: "tool_end",
      level: "info",
      detail: "Tool finished",
    });
  } finally {
    await runtime.stop();
  }
});

test("compacting_context and subagent_activity are visible busy kinds that re-arm the heartbeat", async () => {
  const { runtime, activities, emit } = await harness();
  jest.useFakeTimers();
  try {
    activities.length = 0;
    emit({ detailKind: "compacting_context", level: "info", detail: "" });
    emit({ detailKind: "subagent_activity", level: "info", detail: "" });
    expect(activities).toHaveLength(2);
    jest.advanceTimersByTime(60_000);
    expect(activities).toHaveLength(3);
    expect(activities[2]).toMatchObject({ detailKind: "subagent_activity", isHeartbeat: true });
  } finally {
    await runtime.stop();
  }
});

test("a subagent-scoped activity is reclassified as subagent_activity", async () => {
  const { runtime, activities, emitEvent } = await harness();
  try {
    activities.length = 0;
    emitEvent({
      type: "activity",
      activity: {
        detailKind: "tool_started",
        level: "info",
        detail: "",
        observedAtMs: Date.now(),
        entries: [{ kind: "tool_start", toolName: "Bash", subagent: { parentToolUseId: "t1" } }],
      },
    });
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({ detailKind: "subagent_activity" });
  } finally {
    await runtime.stop();
  }
});

test("a subagent-scoped error activity keeps its error classification", async () => {
  const { runtime, activities, emitEvent } = await harness();
  try {
    activities.length = 0;
    emitEvent({
      type: "activity",
      activity: {
        detailKind: "runtime_error",
        level: "error",
        detail: "subagent failed",
        observedAtMs: Date.now(),
        entries: [{ kind: "text", text: "boom", subagent: { parentToolUseId: "t1" } }],
      },
    });
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({ detailKind: "runtime_error", level: "error" });
  } finally {
    await runtime.stop();
  }
});

// A `tool-start` AgentRuntimeEvent carries only the provider's raw name/input;
// the daemon core is the single place that turns it into an Activity, via the
// same `toolActivity` allowlist every provider used to call for itself.
test("a bash tool-start reports running_command with a generic detail label, the command in toolInput", async () => {
  const { runtime, activities, emitEvent } = await harness();
  try {
    activities.length = 0;
    emitEvent({ type: "tool-start", id: "1", name: "Bash", input: { command: "ls -la" } });
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      detailKind: "running_command",
      level: "info",
      detail: "Running command…",
      entries: [{ kind: "tool_start", toolName: "bash", toolInput: "ls -la" }],
    });
  } finally {
    await runtime.stop();
  }
});

test("a Codex-shaped bash tool-start resolves `coforge message send` to send_message, not a generic command", async () => {
  const { runtime, activities, emitEvent } = await harness();
  try {
    activities.length = 0;
    emitEvent({
      type: "tool-start",
      id: "item-1",
      name: "bash",
      input: {
        command: [
          "coforge message send --target '#x' <<'COFORGE_MESSAGE'",
          "hi",
          "COFORGE_MESSAGE",
        ].join("\n"),
      },
    });
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      detailKind: "tool_started",
      detail: "Sending message…",
      entries: [{ kind: "tool_start", toolName: "send_message", toolInput: "#x" }],
    });
  } finally {
    await runtime.stop();
  }
});

test("`coforge message check` reports checking_messages with a generic detail label", async () => {
  const { runtime, activities, emitEvent } = await harness();
  try {
    activities.length = 0;
    emitEvent({
      type: "tool-start",
      id: "1",
      name: "bash",
      input: { command: "coforge message check" },
    });
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      detailKind: "checking_messages",
      detail: "Checking messages…",
      entries: [{ kind: "tool_start", toolName: "check_messages" }],
    });
  } finally {
    await runtime.stop();
  }
});

test("`coforge inbox check` uses the existing checking-messages Activity path", async () => {
  const { runtime, activities, emitEvent } = await harness();
  try {
    activities.length = 0;
    emitEvent({
      type: "tool-start",
      id: "1",
      name: "bash",
      input: { command: "coforge inbox check" },
    });
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      detailKind: "checking_messages",
      detail: "Checking messages…",
      entries: [{ kind: "tool_start", toolName: "check_inbox" }],
    });
  } finally {
    await runtime.stop();
  }
});

test("a file tool-start reports a generic detail label, its path in toolInput", async () => {
  const { runtime, activities, emitEvent } = await harness();
  try {
    activities.length = 0;
    emitEvent({
      type: "tool-start",
      id: "1",
      name: "read_file",
      input: { file_path: "src/a.ts" },
    });
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      detailKind: "tool_started",
      detail: "Reading file…",
      entries: [{ kind: "tool_start", toolName: "read_file", toolInput: "src/a.ts" }],
    });
  } finally {
    await runtime.stop();
  }
});

test("an unrecognized tool-start reports a generic unknown-tool label built from its name alone", async () => {
  const { runtime, activities, emitEvent } = await harness();
  try {
    activities.length = 0;
    emitEvent({
      type: "tool-start",
      id: "1",
      name: "MysteryTool",
      input: { secret: "private" },
    });
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      detailKind: "tool_started",
      detail: "Using MysteryTool…",
      entries: [{ kind: "tool_start", toolName: "MysteryTool" }],
    });
    expect(activities[0]!.entries![0]).not.toHaveProperty("toolInput");
  } finally {
    await runtime.stop();
  }
});

test("the busy heartbeat and an activity probe reply re-send only the generic detail label, never the command", async () => {
  const { runtime, activities, emitEvent } = await harness();
  jest.useFakeTimers();
  try {
    activities.length = 0;
    emitEvent({
      type: "tool-start",
      id: "1",
      name: "Bash",
      input: { command: 'mise exec -- bun test 2>&1 | grep -iE "error:|DATABASE_URL"' },
    });
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      detailKind: "running_command",
      detail: "Running command…",
    });
    expect(activities[0]!.entries).toHaveLength(1);

    jest.advanceTimersByTime(60_000);
    expect(activities).toHaveLength(2);
    expect(activities[1]).toMatchObject({
      detailKind: "running_command",
      detail: "Running command…",
      isHeartbeat: true,
    });
    expect(activities[1]!.entries ?? []).toHaveLength(0);
    expect(JSON.stringify(activities[1])).not.toContain("mise exec");
    expect(JSON.stringify(activities[1])).not.toContain("DATABASE_URL");

    await runtime.handleAgentActivityProbe({
      protocolMajor: 1,
      requestId: "probe-request-heartbeat-label",
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      agentId: "agent-a",
      probeId: "probe-heartbeat-label",
    });
    expect(activities).toHaveLength(3);
    expect(activities[2]).toMatchObject({
      detailKind: "running_command",
      detail: "Running command…",
      probeId: "probe-heartbeat-label",
    });
    expect(activities[2]!.entries ?? []).toHaveLength(0);
    expect(JSON.stringify(activities[2])).not.toContain("mise exec");
  } finally {
    await runtime.stop();
  }
});

test("pending text is flushed before a tool-start's Activity", async () => {
  const { runtime, activities, emitEvent } = await harness();
  try {
    activities.length = 0;
    emitEvent({ type: "text-delta", text: "Thinking about it" });
    emitEvent({ type: "tool-start", id: "1", name: "Bash", input: { command: "ls" } });
    // The run-start frame announces the response first, then the buffered text lands
    // before the tool's own Activity.
    expect(activities.map((activity) => activity.detailKind)).toEqual([
      "model_response_started",
      "model_response_started",
      "running_command",
    ]);
    expect(activities[0]?.entries ?? []).toHaveLength(0);
    expect(activities[1]).toMatchObject({
      entries: [{ kind: "text", text: "Thinking about it" }],
    });
    expect(activities[2]).toMatchObject({
      detail: "Running command…",
      entries: [{ kind: "tool_start", toolName: "bash", toolInput: "ls" }],
    });
  } finally {
    await runtime.stop();
  }
});

test("a subagent-scoped tool-start is reclassified as subagent_activity", async () => {
  const { runtime, activities, emitEvent } = await harness();
  try {
    activities.length = 0;
    emitEvent({
      type: "tool-start",
      id: "1",
      name: "Bash",
      input: { command: "ls" },
      subagent: { parentToolUseId: "t1" },
    });
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({ detailKind: "subagent_activity" });
  } finally {
    await runtime.stop();
  }
});

test.each(["runtime_crashed", "runtime_interrupted"] as const)(
  "%s stops the heartbeat like other terminal kinds",
  async (detailKind) => {
    const { runtime, activities, emit } = await harness();
    jest.useFakeTimers();
    try {
      activities.length = 0;
      emit({ detailKind: "running_command", level: "info", detail: "ls" });
      emit({ detailKind, level: detailKind === "runtime_crashed" ? "error" : "info", detail: "" });
      const countAfter = activities.length;
      jest.advanceTimersByTime(600_000);
      expect(activities).toHaveLength(countAfter);
    } finally {
      await runtime.stop();
    }
  },
);

test("a completed event's interrupted status reports runtime_interrupted", async () => {
  const { runtime, activities, emitEvent } = await harness();
  try {
    activities.length = 0;
    emitEvent({ type: "completed", status: "interrupted" });
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({ detailKind: "runtime_interrupted", level: "info" });
  } finally {
    await runtime.stop();
  }
});

test("stopAgent reports runtime_interrupted before stopped when it cuts a busy turn", async () => {
  const { runtime, activities, emit } = await harness();
  try {
    activities.length = 0;
    emit({ detailKind: "running_command", level: "info", detail: "ls" });
    activities.length = 0;
    await runtime.stopAgent("agent-a");
    const kinds = activities.map((activity) => activity.detailKind);
    expect(kinds).toEqual(["runtime_interrupted", "stopped"]);
  } finally {
    await runtime.stop();
  }
});

test("stopAgent does not report runtime_interrupted when the Agent was idle", async () => {
  const { runtime, activities, emit } = await harness();
  try {
    activities.length = 0;
    emit({ detailKind: "idle", level: "info", detail: "" });
    await runtime.stopAgent("agent-a");
    const kinds = activities.map((activity) => activity.detailKind);
    expect(kinds).not.toContain("runtime_interrupted");
    expect(kinds).toContain("stopped");
  } finally {
    await runtime.stop();
  }
});
