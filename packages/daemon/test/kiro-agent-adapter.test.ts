import { expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { KiroProvider } from "../src/code-agent/kiro/provider";
import type { AgentRuntimeEvent, AgentSession } from "../src/code-agent/contract";

// macOS tmpdir lives under /var, a symlink; the Kiro provider rejects a linked
// agent profile directory (comparing realpath to the literal resolved path).
const tempRoot = realpathSync(tmpdir());

const command = [process.execPath, new URL("./fixtures/kiro-acp.ts", import.meta.url).pathname];

test.each(["--delayed-config", "--early-config"])(
  "Kiro waits for native model configuration %s",
  async (flag) => {
    const cwd = await mkdtemp(join(tempRoot, "kiro-config-"));
    try {
      const session = await new KiroProvider({ command: [...command, flag] }).createAgentSession({
        agentWorkspaceDirectory: cwd,
        instructions: "Keep the asymmetric marker 719 in the system prompt.",
        runtime: { provider: "kiro", model: "model-reasoning", reasoning: "high" },
      });
      try {
        await session.notify!("require-model");
        expect(await session.readSessionIdentity!()).toMatchObject({ state: "resumable" });
      } finally {
        await session.dispose();
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

test.each(["--missing-config", "--invalid-model", "--closed-config"])(
  "Kiro fails closed and cleans up %s",
  async (flag) => {
    const cwd = await mkdtemp(join(tempRoot, "kiro-config-fail-"));
    try {
      await expect(
        new KiroProvider({ command: [...command, flag], configTimeoutMs: 30 }).createAgentSession({
          agentWorkspaceDirectory: cwd,
          instructions: "Keep the asymmetric marker 719 in the system prompt.",
          runtime: {
            provider: "kiro",
            model: flag === "--invalid-model" ? "not-a-model" : "auto",
            reasoning: "",
          },
        }),
      ).rejects.toThrow(
        flag === "--invalid-model"
          ? "model selection is unavailable"
          : flag === "--closed-config"
            ? "process closed before configuration"
            : "operation timed out",
      );
      expect(await readdir(join(cwd, ".kiro/agents"))).toEqual([]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

test("Kiro launch is rejected before any workspace side effect when the resolved CLI is below the ADR 0010 baseline", async () => {
  const cwd = await mkdtemp(join(tempRoot, "kiro-version-gate-reject-"));
  try {
    await expect(
      new KiroProvider({
        command: [...command, "--version-output=kiro-cli 2.16.0"],
      }).createAgentSession({
        agentWorkspaceDirectory: cwd,
        instructions: "Keep the asymmetric marker 719 in the system prompt.",
        runtime: { provider: "kiro", model: "auto", reasoning: "" },
      }),
    ).rejects.toThrow(
      "Kiro CLI 2.16.0 is unsupported; requires Kiro CLI >= 2.21.2. Upgrade kiro-cli before starting this runtime.",
    );
    // The gate rejects before mkdir, so the workspace's agent profile directory never exists.
    await expect(readdir(join(cwd, ".kiro/agents"))).rejects.toThrow();
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test.each(["kiro-cli 2.21.2", "unexpected-output-with-no-dotted-version"])(
  "Kiro launch proceeds when the resolved CLI meets the baseline or cannot be confidently parsed (%s)",
  async (versionOutput) => {
    const cwd = await mkdtemp(join(tempRoot, "kiro-version-gate-proceed-"));
    try {
      const session = await new KiroProvider({
        command: [...command, `--version-output=${versionOutput}`],
      }).createAgentSession({
        agentWorkspaceDirectory: cwd,
        instructions: "Keep the asymmetric marker 719 in the system prompt.",
        runtime: { provider: "kiro", model: "auto", reasoning: "" },
      });
      await session.dispose();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

test("Kiro verifies the selected native session before loading and reapplies model/effort", async () => {
  const cwd = await mkdtemp(join(tempRoot, "kiro-resume-"));
  const reports: string[] = [];
  try {
    const session = await new KiroProvider({ command }).createAgentSession({
      agentWorkspaceDirectory: cwd,
      instructions: "Keep the asymmetric marker 719 in the system prompt.",
      sessionId: "sess-fixture-kiro",
      runtime: { provider: "kiro", model: "model-reasoning", reasoning: "high" },
      onSessionId: async (id) => {
        reports.push(id);
      },
    });
    try {
      expect(reports).toEqual(["sess-fixture-kiro"]);
      expect(await session.readSessionIdentity!()).toEqual({
        sessionId: "sess-fixture-kiro",
        state: "resumable",
      });
      await session.notify!("require-model");
    } finally {
      await session.dispose();
    }
    await expect(
      new KiroProvider({ command }).createAgentSession({
        agentWorkspaceDirectory: cwd,
        instructions: "test",
        sessionId: "missing",
      }),
    ).rejects.toMatchObject({ code: "session_missing" });
    expect(reports).toHaveLength(1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Kiro v3 injects native instructions and accepts input before its turn completes", async () => {
  const cwd = await mkdtemp(join(tempRoot, "kiro-adapter-"));
  const identities: string[] = [];
  const session = await new KiroProvider({ command }).createAgentSession({
    agentWorkspaceDirectory: cwd,
    instructions: "Keep the asymmetric marker 719 in the system prompt.",
    onSessionId: async (id) => {
      identities.push(id);
    },
  });
  const events: AgentRuntimeEvent[] = [];
  session.subscribe((event) => events.push(event));
  try {
    await session.notify!("wait");
    expect(identities).toEqual(["sess-fixture-kiro"]);
    expect(events.some((event) => event.type === "completed")).toBe(false);
    expect(await session.readSessionIdentity!()).toEqual({
      sessionId: "sess-fixture-kiro",
      state: "resumable",
    });
    await session.interrupt();
    expect(events).toContainEqual({ type: "completed", status: "interrupted" });
    // A stop/restart we asked for stays a silent interruption; it is not reported as an error.
    expect(events.some((event) => event.type === "error")).toBe(false);
  } finally {
    await session.dispose();
    expect(await readdir(join(cwd, ".kiro/agents"))).toEqual([]);
    await rm(cwd, { recursive: true, force: true });
  }
});

/** `notify()` resolves on admission, not on turn completion (the earlier "accepts input before
 * its turn completes" test proves that); waiting on it is not proof the turn's own `error`/
 * `completed` events have arrived. Wait on the real public contract instead: the event the
 * subscription callback actually delivers. */
function waitForCompletion(session: AgentSession, events: AgentRuntimeEvent[]) {
  const completed = Promise.withResolvers<void>();
  const unsubscribe = session.subscribe((event) => {
    events.push(event);
    if (event.type === "completed") completed.resolve();
  });
  return { unsubscribe, completion: completed.promise };
}

test("Kiro forwards its own scrubbed reason for a turn that ends with its private error stop reason", async () => {
  const cwd = await mkdtemp(join(tempRoot, "kiro-turn-error-"));
  const session = await new KiroProvider({ command }).createAgentSession({
    agentWorkspaceDirectory: cwd,
    instructions: "Keep the asymmetric marker 719 in the system prompt.",
  });
  const events: AgentRuntimeEvent[] = [];
  const { completion } = waitForCompletion(session, events);
  try {
    await session.notify!("turn-error-with-reason");
    await completion;
    // The session_info_update's message and errorType are Kiro's real, specific reason
    // (matches the 2026-09-18 incident); a leaked-looking token is scrubbed before it is ever
    // forwarded, the same way every other runtime error is scrubbed.
    expect(events).toContainEqual({
      type: "error",
      message: "connection failed token=[REDACTED]",
      providerErrorCode: "ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC",
    });
    expect(events).toContainEqual({ type: "completed", status: "failed" });
    // Exactly one error for the one failed turn: the stop-reason handling does not repeat it.
    expect(events.filter((event) => event.type === "error")).toHaveLength(1);
  } finally {
    await session.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Kiro reports a fixed fallback for a turn that ends with its private error stop reason and no observed cause", async () => {
  const cwd = await mkdtemp(join(tempRoot, "kiro-turn-error-silent-"));
  const session = await new KiroProvider({ command }).createAgentSession({
    agentWorkspaceDirectory: cwd,
    instructions: "Keep the asymmetric marker 719 in the system prompt.",
  });
  const events: AgentRuntimeEvent[] = [];
  const { completion } = waitForCompletion(session, events);
  try {
    await session.notify!("turn-error-silent");
    await completion;
    expect(events).toContainEqual({
      type: "error",
      message: "Kiro ended the turn with an error",
    });
    expect(events).toContainEqual({ type: "completed", status: "failed" });
    expect(events.filter((event) => event.type === "error")).toHaveLength(1);
  } finally {
    await session.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Kiro reports a cancellation it never asked for as a failed turn, not a silent interrupted", async () => {
  const cwd = await mkdtemp(join(tempRoot, "kiro-turn-cancelled-unrequested-"));
  const session = await new KiroProvider({ command }).createAgentSession({
    agentWorkspaceDirectory: cwd,
    instructions: "Keep the asymmetric marker 719 in the system prompt.",
  });
  const events: AgentRuntimeEvent[] = [];
  const { completion } = waitForCompletion(session, events);
  try {
    await session.notify!("turn-cancelled-unrequested");
    await completion;
    expect(events).toContainEqual({ type: "error", message: "Kiro cancelled the turn" });
    expect(events).toContainEqual({ type: "completed", status: "failed" });
    expect(
      events.some((event) => event.type === "completed" && event.status === "interrupted"),
    ).toBe(false);
  } finally {
    await session.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Kiro names the stop reason for a turn that ends before finishing (max_tokens)", async () => {
  const cwd = await mkdtemp(join(tempRoot, "kiro-turn-max-tokens-"));
  const session = await new KiroProvider({ command }).createAgentSession({
    agentWorkspaceDirectory: cwd,
    instructions: "Keep the asymmetric marker 719 in the system prompt.",
  });
  const events: AgentRuntimeEvent[] = [];
  const { completion } = waitForCompletion(session, events);
  try {
    await session.notify!("turn-max-tokens");
    await completion;
    expect(events).toContainEqual({
      type: "error",
      message: "Kiro reached its token limit before finishing the turn",
    });
    expect(events).toContainEqual({ type: "completed", status: "failed" });
  } finally {
    await session.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Kiro forwards a scrubbed session/prompt rejection reason instead of a fixed summary", async () => {
  const cwd = await mkdtemp(join(tempRoot, "kiro-reject-"));
  const session = await new KiroProvider({ command }).createAgentSession({
    agentWorkspaceDirectory: cwd,
    instructions: "Keep the asymmetric marker 719 in the system prompt.",
  });
  const events: AgentRuntimeEvent[] = [];
  session.subscribe((event) => events.push(event));
  try {
    await expect(session.notify!("reject-with-secret")).rejects.toThrow();
    expect(events).toContainEqual({
      type: "error",
      message: "Upstream rejected api_key=[REDACTED]",
      providerErrorCode: "-32000",
    });
    expect(events).toContainEqual({ type: "completed", status: "failed" });
  } finally {
    await session.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Kiro replaces busy input, suppresses late completion, and normalizes ACP events", async () => {
  const cwd = await mkdtemp(join(tempRoot, "kiro-events-"));
  const session = await new KiroProvider({ command }).createAgentSession({
    agentWorkspaceDirectory: cwd,
    instructions: "Keep the asymmetric marker 719 in the system prompt.",
  });
  const events: AgentRuntimeEvent[] = [];
  session.subscribe((event) => events.push(event));
  try {
    await session.notify!("busy-old");
    await session.notify!("events");
    expect(events.filter((event) => event.type === "completed")).toEqual([]);
    // Kiro's tool_call frames never carry a programmatic name, only a title
    // and an ACP kind; the provider must derive the canonical tool name from
    // kind, not echo the title back as the name. Kiro reports only the raw
    // tool-start event; the daemon core alone decides what Activity it is.
    expect(events).toContainEqual({
      type: "tool-start",
      id: "tool-1",
      name: "bash",
      input: { command: "bun test", run_in_background: false },
    });
    expect(events).toContainEqual({ type: "tool-output", id: "tool-1", text: "tests passed" });
    expect(events).toContainEqual({ type: "tool-end", id: "tool-1", isError: false });

    // kind: "read" maps to the canonical "read_file" tool and reports the
    // path, not the "Read File" title.
    expect(events).toContainEqual({
      type: "tool-start",
      id: "tool-2",
      name: "read_file",
      input: { path: "/abs/probe.py", offset: null, limit: null },
    });

    // A kind with no canonical CoForge tool (e.g. "other") falls back to the
    // human-readable title instead of losing the tool name entirely.
    expect(events).toContainEqual({
      type: "tool-start",
      id: "tool-3",
      name: "Task List",
      input: {},
    });

    // The provider forwards Kiro's own diagnostic as a raw `error` event (scrubbed by the
    // shared daemon-core redaction below, in the dedicated scrubbing test); the daemon core
    // (agent-runtime/runtime-error-activity.ts) builds the visible Activity from it.
    expect(
      events.some((event) => event.type === "error" && event.message === "provider unavailable"),
    ).toBe(true);
  } finally {
    await session.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Kiro reports a compaction-started event per in_progress update, and compaction-finished from CompactionUpdate.status=completed", async () => {
  // The adapter relays the raw signal as-is; de-duping repeated "in_progress" updates into a
  // single reported episode is the daemon core's job now (agent-runtime/compaction-tracker.ts,
  // exercised in activity-heartbeat.test.ts), not the adapter's.
  const cwd = await mkdtemp(join(tempRoot, "kiro-compaction-"));
  const session = await new KiroProvider({ command }).createAgentSession({
    agentWorkspaceDirectory: cwd,
    instructions: "Keep the asymmetric marker 719 in the system prompt.",
  });
  const events: AgentRuntimeEvent[] = [];
  session.subscribe((event) => events.push(event));
  try {
    await session.notify!("compaction");
    expect(events.filter((event) => event.type === "compaction-started")).toHaveLength(2);
    expect(events.filter((event) => event.type === "compaction-finished")).toHaveLength(1);
    expect(events.filter((event) => event.type === "compaction-interrupted")).toHaveLength(0);
  } finally {
    await session.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Kiro reports compaction-interrupted from CompactionUpdate.status=failed", async () => {
  const cwd = await mkdtemp(join(tempRoot, "kiro-compaction-failed-"));
  const session = await new KiroProvider({ command }).createAgentSession({
    agentWorkspaceDirectory: cwd,
    instructions: "Keep the asymmetric marker 719 in the system prompt.",
  });
  const events: AgentRuntimeEvent[] = [];
  session.subscribe((event) => events.push(event));
  try {
    await session.notify!("compaction-failed");
    expect(events.filter((event) => event.type === "compaction-started")).toHaveLength(1);
    expect(events.filter((event) => event.type === "compaction-interrupted")).toHaveLength(1);
    expect(events.filter((event) => event.type === "compaction-finished")).toHaveLength(0);
  } finally {
    await session.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Kiro reports progress for content-free tool_call_update, plan, and usage updates", async () => {
  const cwd = await mkdtemp(join(tempRoot, "kiro-progress-"));
  const session = await new KiroProvider({ command }).createAgentSession({
    agentWorkspaceDirectory: cwd,
    instructions: "Keep the asymmetric marker 719 in the system prompt.",
  });
  const events: AgentRuntimeEvent[] = [];
  session.subscribe((event) => events.push(event));
  try {
    await session.notify!("progress-updates");
    const sources = events
      .filter((event) => event.type === "progress")
      .map((event) => event.source);
    expect(sources).toEqual(["kiro_tool_call_update", "kiro_plan_update", "kiro_usage_update"]);
  } finally {
    await session.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Kiro rejects protocol disconnect before admission and mismatched resume identity", async () => {
  const cwd = await mkdtemp(join(tempRoot, "kiro-failures-"));
  try {
    const session = await new KiroProvider({ command }).createAgentSession({
      agentWorkspaceDirectory: cwd,
      instructions: "Keep the asymmetric marker 719 in the system prompt.",
    });
    await expect(session.notify!("disconnect-before-admission")).rejects.toThrow();
    await session.dispose();
    await expect(
      new KiroProvider({ command }).createAgentSession({
        agentWorkspaceDirectory: cwd,
        instructions: "test",
        sessionId: "sess-fixture-kiro",
        environment: { KIRO_BAD_RESUME: "1" },
      }),
    ).rejects.toMatchObject({ code: "provider_replay_rejected" });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
