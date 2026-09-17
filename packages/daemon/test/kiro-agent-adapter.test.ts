import { expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { KiroProvider } from "../src/code-agent/kiro/provider";
import type { AgentRuntimeEvent } from "../src/code-agent/contract";

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
  } finally {
    await session.dispose();
    expect(await readdir(join(cwd, ".kiro/agents"))).toEqual([]);
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
    expect(events).toContainEqual({ type: "tool-start", id: "tool-1", name: "Bash" });
    expect(events).toContainEqual({ type: "tool-output", id: "tool-1", text: "tests passed" });
    expect(events).toContainEqual({ type: "tool-end", id: "tool-1", isError: false });
    expect(
      events.some(
        (event) => event.type === "activity" && event.activity.detailKind === "running_command",
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "activity" &&
          event.activity.detailKind === "runtime_error" &&
          event.activity.detail === "Kiro reported a runtime error",
      ),
    ).toBe(true);
  } finally {
    await session.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Kiro reports compacting_context once, then compaction_finished, from CompactionUpdate.status", async () => {
  const cwd = await mkdtemp(join(tempRoot, "kiro-compaction-"));
  const session = await new KiroProvider({ command }).createAgentSession({
    agentWorkspaceDirectory: cwd,
    instructions: "Keep the asymmetric marker 719 in the system prompt.",
  });
  const events: AgentRuntimeEvent[] = [];
  session.subscribe((event) => events.push(event));
  try {
    await session.notify!("compaction");
    const kinds = events
      .filter((event) => event.type === "activity")
      .map((event) => event.activity.detailKind);
    expect(kinds.filter((kind) => kind === "compacting_context")).toHaveLength(1);
    expect(kinds.filter((kind) => kind === "compaction_finished")).toHaveLength(1);
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
