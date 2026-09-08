import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ClaudeCodeDriver } from "../src/code-agent/claude-code/driver";
import { AGENT_RUNTIME_EVENT_TYPE, type AgentRuntimeEvent } from "../src/code-agent/contract";

const TEST_AGENT_INSTRUCTIONS = "Test Agent instructions.";

test.each(["missing-resume", "missing-before-initialize"])(
  "Claude %s closes before fresh launch and reports replacement without losing first input",
  async (mode) => {
    const reports: Array<[string, string | undefined]> = [];
    const confirmed = Promise.withResolvers<void>();
    const session = await fixtureAdapter(mode).createAgentSession({
      agentWorkspaceDirectory: tmpdir(),
      instructions: TEST_AGENT_INSTRUCTIONS,
      sessionId: "missing-session",
      async onSessionId(id, replaced) {
        reports.push([id, replaced]);
        if (reports.length === 2) confirmed.resolve();
      },
    });
    const completed = Promise.withResolvers<void>();
    let exits = 0;
    session.onExit(() => {
      exits++;
      completed.reject(new Error("unexpected terminal exit"));
    });
    session.subscribe((event) => {
      if (event.type === "completed") completed.resolve();
    });
    try {
      await session.sendMessage("finish");
      await completed.promise;
      await confirmed.promise;
      expect(reports).toEqual([
        ["fixture-session", "missing-session"],
        ["fixture-session", "missing-session"],
      ]);
      expect(exits).toBe(0);
    } finally {
      await session.dispose();
    }
  },
);

test.each([
  ["auth", ["resume-error", "Authentication failed"]],
  ["I/O", ["resume-error", "EACCES: permission denied"]],
  ["corruption", ["resume-error", "Invalid session transcript JSON"]],
  ["wrong ID", ["resume-error", "No conversation found with session ID: another-session"]],
  ["model progress", ["missing-resume", "progress-before-missing"]],
  ["validated identity", ["missing-resume", "init-before-missing"]],
  ["mixed errors", ["missing-resume", "mixed-error"]],
  ["invalid output", ["missing-resume", "invalid-output"]],
  ["failed fresh launch", ["missing-resume", "fresh-fails"]],
] as const)("Claude does not retry %s as missing history", async (name, args) => {
  const directory = await mkdtemp(join(tmpdir(), "claude-no-replay-"));
  const log = join(directory, "launches");
  const session = await fixtureAdapter(...args, "--launch-log", log).createAgentSession({
    agentWorkspaceDirectory: directory,
    instructions: TEST_AGENT_INSTRUCTIONS,
    sessionId: "missing-session",
  });
  const exited = Promise.withResolvers<void>();
  const events: AgentRuntimeEvent[] = [];
  session.onExit(() => exited.resolve());
  session.subscribe((event) => events.push(event));
  try {
    await session.sendMessage("finish");
    await exited.promise;
    expect(await readFile(log, "utf8")).toBe(
      name === "failed fresh launch" ? "resume\nfresh\n" : "resume\n",
    );
    expect(events.filter((event) => event.type === "completed")).toEqual([]);
    await expect(session.notify!("do not replay")).rejects.toThrow();
  } finally {
    await session.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Claude forwards cloud-selected persistent resume while retaining approved permissions", async () => {
  const driver = new ClaudeCodeDriver({
    command: [
      process.execPath,
      new URL("./fixtures/claude-stream-json.ts", import.meta.url).pathname,
      "expect-resume",
    ],
  });
  const session = await driver.createAgentSession({
    agentWorkspaceDirectory: tmpdir(),
    instructions: TEST_AGENT_INSTRUCTIONS,
    sessionId: "selected-session",
  });
  try {
    expect(session).toBeDefined();
  } finally {
    await session.dispose();
  }
});

test("Claude missing-session replacement retains notices until fresh turn boundary and dispose cancels them", async () => {
  const fixture = await controlledClaude("missing-session", undefined, "missing-resume");
  let accepted = 0;
  try {
    await fixture.session.sendMessage("wait");
    const notice = fixture.session.notify!("wait").then(() => {
      accepted++;
    });
    await toolBoundary(fixture.emit);
    expect(accepted).toBe(0);
    await fixture.emit({ type: "result", subtype: "success" });
    await notice;
    expect(accepted).toBe(1);
    const retained = Promise.allSettled([fixture.session.notify!("wait")]);
    await fixture.session.dispose();
    expect((await retained)[0]?.status).toBe("rejected");
  } finally {
    await fixture.dispose();
  }
});

test("Claude first input and turn boundary flow while late identity ACK is pending", async () => {
  const observed = Promise.withResolvers<void>();
  const ack = Promise.withResolvers<void>();
  const confirmed = Promise.withResolvers<void>();
  let reports = 0;
  const session = await fixtureAdapter().createAgentSession({
    agentWorkspaceDirectory: tmpdir(),
    instructions: TEST_AGENT_INSTRUCTIONS,
    async onSessionId(id) {
      expect(id).toBe("fixture-session");
      reports++;
      observed.resolve();
      if (reports === 2) confirmed.resolve();
      await ack.promise;
    },
  });
  const complete = Promise.withResolvers<void>();
  session.subscribe((event) => {
    if (event.type === "completed") complete.resolve();
  });
  try {
    expect(reports).toBe(0);
    await session.sendMessage("finish");
    await observed.promise;
    await complete.promise;
    expect(reports).toBe(1);
    await session.notify!("wait");
    await session.interrupt();
    expect(reports).toBe(1);
    ack.resolve();
    await confirmed.promise;
    expect(reports).toBeGreaterThanOrEqual(2);
  } finally {
    ack.resolve();
    await session.dispose();
  }
});

test("Claude serializes duplicate init and turn-end identity observations without suppressing confirmation", async () => {
  const ack = Promise.withResolvers<void>();
  const confirmed = Promise.withResolvers<void>();
  const ids: string[] = [];
  const fixture = await controlledClaude(undefined, async (id) => {
    ids.push(id);
    if (ids.length === 3) confirmed.resolve();
    await ack.promise;
  });
  try {
    await fixture.session.sendMessage("wait");
    await fixture.emit(
      { type: "system", subtype: "init", session_id: "fixture-session" },
      { type: "result", subtype: "success" },
    );
    expect(ids).toEqual(["fixture-session"]);
    ack.resolve();
    await confirmed.promise;
    expect(ids).toEqual(["fixture-session", "fixture-session", "fixture-session"]);
  } finally {
    ack.resolve();
    await fixture.dispose();
  }
});

test("Claude surfaces failed identity ACK and retries the observation at turn end", async () => {
  const failed = Promise.withResolvers<string>();
  const reported = Promise.withResolvers<void>();
  let attempts = 0;
  const fixture = await controlledClaude(undefined, async () => {
    if (++attempts === 1) throw new Error("identity ACK unavailable");
    reported.resolve();
  });
  fixture.session.subscribe((event) => {
    if (event.type === "activity" && event.activity.detailKind === "runtime_error")
      failed.resolve(event.activity.detail);
  });
  try {
    await fixture.session.sendMessage("wait");
    expect(await failed.promise).toBe("identity ACK unavailable");
    await fixture.emit({ type: "result", subtype: "success" });
    await reported.promise;
    expect(attempts).toBe(2);
  } finally {
    await fixture.dispose();
  }
});

for (const [mode, sessionId] of [
  ["mismatched-init", "selected-session"],
  ["missing-init", "selected-session"],
  ["missing-init", undefined],
  ["invalid-init", undefined],
] as const) {
  test(`Claude terminates ${sessionId ? "resume" : "fresh session"} on ${mode} without accepting later success`, async () => {
    const reports: string[] = [];
    const session = await fixtureAdapter(mode).createAgentSession({
      agentWorkspaceDirectory: tmpdir(),
      instructions: TEST_AGENT_INSTRUCTIONS,
      sessionId,
      async onSessionId(id) {
        reports.push(id);
      },
    });
    const events: AgentRuntimeEvent[] = [];
    const exited = Promise.withResolvers<void>();
    session.onExit(() => exited.resolve());
    session.subscribe((event) => events.push(event));
    try {
      await session.sendMessage("finish");
      await exited.promise;
      expect(reports).toEqual([]);
      expect(events.filter((event) => event.type === "completed")).toEqual([]);
      await expect(session.notify!("not accepted")).rejects.toThrow("session");
    } finally {
      await session.dispose();
    }
  });
}

test("Claude Code initializes before the first prompt without waiting for turn metadata", async () => {
  const agentWorkspaceDirectory = await mkdtemp(join(tmpdir(), "coforge-claude-code-"));
  const adapter = new ClaudeCodeDriver({
    command: [
      process.execPath,
      new URL("./fixtures/claude-stream-json.ts", import.meta.url).pathname,
    ],
  });

  try {
    const session = await adapter.createAgentSession({
      agentWorkspaceDirectory,
      instructions: TEST_AGENT_INSTRUCTIONS,
    });
    expect(session).toBeDefined();
    await session.dispose();
  } finally {
    await rm(agentWorkspaceDirectory, { recursive: true, force: true });
  }
});

test("Claude Code resolves a written notification without any input replay or run completion", async () => {
  const session = await fixtureAdapter().createAgentSession({
    agentWorkspaceDirectory: tmpdir(),
    instructions: TEST_AGENT_INSTRUCTIONS,
  });
  const events: AgentRuntimeEvent[] = [];
  session.subscribe((event) => events.push(event));
  try {
    await session.notify!("wait");
    expect(events.filter((event) => event.type === "completed")).toEqual([]);
    await expect(session.sendMessage("overlap")).rejects.toThrow("already running");
  } finally {
    await session.dispose();
  }
});

test("Claude Code retains concurrent notices while initial session metadata is pending", async () => {
  const agentWorkspaceDirectory = await mkdtemp(join(tmpdir(), "coforge-claude-starting-"));
  const arrived = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const gate = Bun.serve({
    port: 0,
    async fetch() {
      arrived.resolve();
      await release.promise;
      return new Response("ready");
    },
  });
  const session = await fixtureAdapter().createAgentSession({
    agentWorkspaceDirectory,
    instructions: TEST_AGENT_INSTRUCTIONS,
    environment: { COFORGE_CLAUDE_INIT_GATE: gate.url.href },
  });
  const metadataObserved = Promise.withResolvers<void>();
  session.subscribe((event) => {
    if (event.type === "text-delta" && event.text === "fixture-input-observed")
      metadataObserved.resolve();
  });
  try {
    const first = session.sendMessage("wait");
    await arrived.promise;
    let written = false;
    const notification = session.notify!("busy notice").then(() => {
      written = true;
    });
    await first;
    expect(written).toBe(false);
    release.resolve();
    await metadataObserved.promise;
    await session.interrupt();
    await notification;
    await expect(session.sendMessage("overlap")).rejects.toThrow("already running");
  } finally {
    release.resolve();
    await session.dispose();
    gate.stop(true);
    await rm(agentWorkspaceDirectory, { recursive: true, force: true });
  }
});

test("Claude Code rejects concurrent first notifications after process exit", async () => {
  const agentWorkspaceDirectory = await mkdtemp(join(tmpdir(), "coforge-claude-input-exit-"));
  const session = await new ClaudeCodeDriver({
    command: [
      process.execPath,
      new URL("./fixtures/claude-stream-json.ts", import.meta.url).pathname,
      "exit-after-init",
    ],
  }).createAgentSession({ agentWorkspaceDirectory, instructions: TEST_AGENT_INSTRUCTIONS });
  try {
    await new Promise<void>((resolve) => session.onExit(resolve));
    const results = await Promise.allSettled([session.notify!("first"), session.notify!("second")]);
    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
  } finally {
    await session.dispose();
    await rm(agentWorkspaceDirectory, { recursive: true, force: true });
  }
});

test("Claude Code rejects a failed initialization handshake", async () => {
  const agentWorkspaceDirectory = await mkdtemp(join(tmpdir(), "coforge-claude-init-rejected-"));
  try {
    await expect(
      new ClaudeCodeDriver({
        command: [
          process.execPath,
          new URL("./fixtures/claude-stream-json.ts", import.meta.url).pathname,
          "reject-initialize",
        ],
      }).createAgentSession({ agentWorkspaceDirectory, instructions: TEST_AGENT_INSTRUCTIONS }),
    ).rejects.toThrow("initialization was rejected");
  } finally {
    await rm(agentWorkspaceDirectory, { recursive: true, force: true });
  }
});

test("Claude Code starts the user's installed CLI from PATH in streaming mode", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coforge-claude-installed-"));
  const agentWorkspaceDirectory = join(directory, "workspace");
  const binDirectory = join(directory, "bin");
  await mkdir(agentWorkspaceDirectory);
  await mkdir(binDirectory);
  const executable = join(binDirectory, "claude");
  await writeFile(
    executable,
    '#!/bin/sh\nprintf "%s" "$*" > "$COFORGE_CLAUDE_ARGS"\nexec "$COFORGE_BUN_EXEC" "$COFORGE_CLAUDE_FIXTURE" -- "$@"\n',
  );
  await chmod(executable, 0o755);
  const argumentsFile = join(directory, "claude-arguments");

  try {
    const session = await new ClaudeCodeDriver().createAgentSession({
      agentWorkspaceDirectory,
      instructions: TEST_AGENT_INSTRUCTIONS,
      runtime: {
        provider: "claude-code",
        model: "claude-sonnet-5",
        modelProvider: "",
        reasoning: "high",
      },
      environment: {
        PATH: binDirectory,
        COFORGE_BUN_EXEC: process.execPath,
        COFORGE_CLAUDE_FIXTURE: new URL("./fixtures/claude-stream-json.ts", import.meta.url)
          .pathname,
        COFORGE_CLAUDE_ARGS: argumentsFile,
      },
    });
    expect(await readFile(argumentsFile, "utf8")).toContain(
      "-p --input-format stream-json --output-format stream-json",
    );
    expect(await readFile(argumentsFile, "utf8")).toContain(
      "--model claude-sonnet-5 --effort high",
    );
    expect(await readFile(argumentsFile, "utf8")).toContain("--append-system-prompt-file");
    await session.dispose();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Claude Code maps stream-json turns behind the code-agent seam", async () => {
  const agentWorkspaceDirectory = await mkdtemp(join(tmpdir(), "coforge-claude-events-"));
  const adapter = fixtureAdapter();

  try {
    const session = await adapter.createAgentSession({
      agentWorkspaceDirectory,
      instructions: TEST_AGENT_INSTRUCTIONS,
    });
    const events: AgentRuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));

    await session.sendMessage("finish");
    await waitForEvent(events, "completed");
    expect(events).toEqual([
      { type: "text-delta", text: "Claude response" },
      { type: "tool-start", id: "tool-1", name: "Bash" },
      {
        type: "activity",
        activity: {
          detailKind: "running_command",
          level: "info",
          detail: "printf safe",
          observedAtMs: Date.parse("2026-01-02T03:04:05.000Z"),
          entries: [{ kind: "tool_start", toolName: "bash" }],
        },
      },
      { type: "tool-output", id: "tool-1", text: "tests passed" },
      { type: "tool-end", id: "tool-1", isError: false },
      { type: "completed", status: "completed" },
    ]);

    await session.dispose();
  } finally {
    await rm(agentWorkspaceDirectory, { recursive: true, force: true });
  }
});

test("Claude Code exposes account rate-limit events as partial usage snapshots", async () => {
  const agentWorkspaceDirectory = await mkdtemp(join(tmpdir(), "coforge-claude-usage-event-"));

  try {
    const session = await fixtureAdapter().createAgentSession({
      agentWorkspaceDirectory,
      instructions: TEST_AGENT_INSTRUCTIONS,
    });
    const events: AgentRuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));

    await session.sendMessage("usage");
    await waitForEvent(events, "completed");
    expect(events[0]).toEqual({
      type: AGENT_RUNTIME_EVENT_TYPE.USAGE,
      snapshot: {
        provider: "claude-code",
        primary: {
          status: "rate-limited",
          windowDurationMinutes: 300,
          resetsAt: "2026-09-04T03:00:00.000Z",
        },
      },
    });

    await session.dispose();
  } finally {
    await rm(agentWorkspaceDirectory, { recursive: true, force: true });
  }
});

test("Claude Code rejects overlapping turns and interrupts without replacing its CLI process", async () => {
  const agentWorkspaceDirectory = await mkdtemp(join(tmpdir(), "coforge-claude-lifecycle-"));
  const adapter = fixtureAdapter();

  try {
    const session = await adapter.createAgentSession({
      agentWorkspaceDirectory,
      instructions: TEST_AGENT_INSTRUCTIONS,
    });
    const events: AgentRuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));

    await session.sendMessage("wait");
    await expect(session.sendMessage("overlap")).rejects.toThrow("already running");
    await session.interrupt();
    await waitForEvent(events, "completed");
    expect(events.at(-1)).toEqual({ type: "completed", status: "interrupted" });

    events.length = 0;
    await session.sendMessage("finish");
    await waitForEvent(events, "completed");
    expect(events.at(-1)).toEqual({ type: "completed", status: "completed" });
    await session.dispose();
  } finally {
    await rm(agentWorkspaceDirectory, { recursive: true, force: true });
  }
});

test("Claude Code accepts busy notifications in the existing session", async () => {
  const agentWorkspaceDirectory = await mkdtemp(join(tmpdir(), "coforge-claude-notify-"));

  try {
    const session = await fixtureAdapter().createAgentSession({
      agentWorkspaceDirectory,
      instructions: TEST_AGENT_INSTRUCTIONS,
    });
    const events: AgentRuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));
    await session.notify!("New message available. Run coforge message check.");
    await waitForEvent(events, "completed");
    expect(events.at(-1)).toEqual({ type: "completed", status: "completed" });

    await session.sendMessage("wait");
    events.length = 0;
    const notification = session.notify!("busy notice");
    await session.interrupt();
    await notification;
    expect(events.filter((event) => event.type === "completed")).toEqual([
      { type: "completed", status: "interrupted" },
    ]);
    await expect(session.sendMessage("overlap")).rejects.toThrow("already running");
    await session.dispose();
  } finally {
    await rm(agentWorkspaceDirectory, { recursive: true, force: true });
  }
});

test("Claude Code resolves a busy notification at the tool boundary without a replay", async () => {
  const fixture = await controlledClaude();
  const { session, emit } = fixture;
  const events: AgentRuntimeEvent[] = [];
  session.subscribe((event) => {
    events.push(event);
  });
  try {
    await session.sendMessage("wait");
    await emit({ type: "result", subtype: "success" });
    await session.sendMessage("wait");
    events.length = 0;
    let accepted = false;
    const notification = session.notify!("busy notice").then(() => {
      accepted = true;
    });
    void notification.catch(() => {});
    await emit({ type: "stream_event", event: { type: "message_stop" } });
    expect(accepted).toBe(false);
    await toolBoundary(emit);
    await notification;
    expect(accepted).toBe(true);
    expect(events.filter((event) => event.type === "completed")).toEqual([]);
  } finally {
    await fixture.dispose();
  }
});

test("Claude Code rejects interrupt when the CLI exits after SIGINT", async () => {
  const adapter = new ClaudeCodeDriver({
    command: [
      process.execPath,
      new URL("./fixtures/claude-stream-json.ts", import.meta.url).pathname,
      "exit-on-interrupt",
    ],
  });

  const session = await adapter.createAgentSession({
    agentWorkspaceDirectory: tmpdir(),
    instructions: TEST_AGENT_INSTRUCTIONS,
  });
  try {
    await session.sendMessage("wait");
    await expect(session.interrupt()).rejects.toThrow("exited unexpectedly");
  } finally {
    await session.dispose();
  }
});

test("Claude Code startup fails when its CLI does not complete initialization", async () => {
  const adapter = new ClaudeCodeDriver({
    command: [process.execPath, new URL("./fixtures/invalid-jsonl.ts", import.meta.url).pathname],
  });

  await expect(
    Promise.race([
      adapter.createAgentSession({
        agentWorkspaceDirectory: tmpdir(),
        instructions: TEST_AGENT_INSTRUCTIONS,
      }),
      Bun.sleep(200).then(() => {
        throw new Error("startup timed out");
      }),
    ]),
  ).rejects.toThrow("invalid output");
});

test("Claude Code holds first-turn notifications until result, not text or tool completion", async () => {
  const fixture = await controlledClaude();
  const { session, emit } = fixture;
  try {
    await session.sendMessage("wait");
    let accepted = false;
    const notification = session.notify!("busy notice").then(() => {
      accepted = true;
    });
    await emit({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "first-tool", name: "Bash", input: {} }] },
    });
    await emit({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "first-tool", content: "done" }] },
    });
    expect(accepted).toBe(false);
    await emit({ type: "result", subtype: "success" });
    await notification;
    expect(accepted).toBe(true);
    await expect(session.sendMessage("overlap")).rejects.toThrow("already running");
  } finally {
    await fixture.dispose();
  }
});

test("Claude resumed identity accepts a tool boundary without a new first-turn result", async () => {
  const fixture = await controlledClaude("fixture-session");
  try {
    await fixture.session.sendMessage("wait");
    let written = false;
    const accepted = fixture.session.notify!("busy notice").then(() => {
      written = true;
    });
    void accepted.catch(() => {});
    await toolBoundary(fixture.emit);
    await accepted;
    expect(written).toBe(true);
  } finally {
    await fixture.dispose();
  }
});

test("Claude Code delivers at the complete tool batch in an established session", async () => {
  const fixture = await controlledClaude();
  const { session, emit } = fixture;
  const events: AgentRuntimeEvent[] = [];
  session.subscribe((event) => events.push(event));
  try {
    await session.sendMessage("wait");
    await emit({ type: "result", subtype: "success" });
    await session.sendMessage("wait");
    events.length = 0;
    let accepted = false;
    const notification = session.notify!("busy notice").then(() => {
      accepted = true;
    });
    void notification.catch(() => {});
    await emit({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "a", name: "Bash", input: {} },
          { type: "tool_use", id: "b", name: "Bash", input: {} },
        ],
      },
    });
    await emit({
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "a", content: "done" },
          { type: "tool_result", tool_use_id: "unknown", content: "irrelevant" },
        ],
      },
    });
    expect(accepted).toBe(false);
    await emit({
      type: "user",
      parent_tool_use_id: "child",
      message: { content: [{ type: "tool_result", tool_use_id: "b", content: "child output" }] },
    });
    expect(accepted).toBe(false);
    await emit({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "b", content: "done" }] },
    });
    await notification;
    expect(accepted).toBe(true);
    expect(events.filter((event) => event.type === "completed")).toEqual([]);
  } finally {
    await fixture.dispose();
  }
});

test("Claude Code retains notifications during compaction until the compact boundary", async () => {
  const fixture = await controlledClaude();
  const { session, emit } = fixture;
  try {
    await session.sendMessage("wait");
    await emit({ type: "result", subtype: "success" });
    await session.sendMessage("wait");
    await emit(
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "tool", name: "Bash", input: {} }] },
      },
      { type: "system", subtype: "status", status: "compacting" },
    );
    let accepted = false;
    const notification = session.notify!("busy notice").then(() => {
      accepted = true;
    });
    void notification.catch(() => {});
    await emit({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "tool", content: "done" }] },
    });
    await emit({ type: "system", subtype: "status", status: null });
    expect(accepted).toBe(false);
    await emit({ type: "system", subtype: "compact_boundary" });
    await notification;
    expect(accepted).toBe(true);
  } finally {
    await fixture.dispose();
  }
});

test("Claude Code holds later text-only turns and delivers all waiting notices once", async () => {
  const fixture = await controlledClaude();
  const { session, emit } = fixture;
  try {
    await session.sendMessage("wait");
    await emit({ type: "result", subtype: "success" });
    await session.sendMessage("wait");
    let accepted = 0;
    const first = session.notify!("first busy notice").then(() => {
      accepted++;
    });
    const second = session.notify!("second busy notice").then(() => {
      accepted++;
    });
    void first.catch(() => {});
    void second.catch(() => {});
    await emit({
      type: "stream_event",
      event: { type: "content_block_start", content_block: { type: "thinking", thinking: "" } },
    });
    await emit(
      { type: "stream_event", event: { type: "message_stop" } },
      { type: "result", parent_tool_use_id: "child", subtype: "success" },
    );
    expect(accepted).toBe(0);
    await emit({ type: "result", subtype: "success" });
    await Promise.all([first, second]);
    expect(accepted).toBe(2);
    await emit({ type: "result", subtype: "success" });
    await session.sendMessage("wait");
    expect(accepted).toBe(2);
  } finally {
    await fixture.dispose();
  }
});

test("Claude Code ignores late user echoes after a completed turn", async () => {
  const fixture = await controlledClaude();
  const { session, emit } = fixture;
  const completions: AgentRuntimeEvent[] = [];
  session.subscribe((event) => {
    if (event.type === "completed") completions.push(event);
  });
  try {
    await session.sendMessage("wait");
    await emit({ type: "result", subtype: "success" });
    expect(completions).toHaveLength(1);
    await emit({ type: "user", uuid: "late-echo", message: { role: "user", content: "wait" } });
    await emit({ type: "result", subtype: "success" });
    expect(completions).toHaveLength(1);
    await session.sendMessage("wait");
  } finally {
    await fixture.dispose();
  }
});

test("Claude Code observes the next native turn after a busy notification was written", async () => {
  const fixture = await controlledClaude();
  const { session, emit } = fixture;
  const completions: AgentRuntimeEvent[] = [];
  session.subscribe((event) => {
    if (event.type === "completed") completions.push(event);
  });
  try {
    await session.sendMessage("wait");
    await emit({ type: "result", subtype: "success" });
    await session.sendMessage("wait");
    const written = session.notify!("busy notice");
    await toolBoundary(emit);
    await written;
    await emit({ type: "result", subtype: "success" });
    expect(completions).toHaveLength(2);
    await emit({ type: "stream_event", event: { type: "message_start" } });
    await expect(session.sendMessage("overlap")).rejects.toThrow("already running");
    await emit({ type: "result", subtype: "success" });
    expect(completions).toHaveLength(3);
  } finally {
    await fixture.dispose();
  }
});

for (const terminal of ["dispose", "exit"] as const) {
  test(`Claude Code rejects retained notices on ${terminal} without completing the active turn`, async () => {
    const session = await fixtureAdapter("exit-on-interrupt").createAgentSession({
      agentWorkspaceDirectory: tmpdir(),
      instructions: TEST_AGENT_INSTRUCTIONS,
    });
    const events: AgentRuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      await session.sendMessage("wait");
      const pending = Promise.allSettled([session.notify!("one"), session.notify!("two")]);
      if (terminal === "dispose") await session.dispose();
      else await expect(session.interrupt()).rejects.toThrow();
      expect((await pending).map((result) => result.status)).toEqual(["rejected", "rejected"]);
      expect(events.filter((event) => event.type === "completed")).toEqual([]);
      await expect(session.notify!("after termination")).rejects.toThrow();
    } finally {
      await session.dispose();
    }
  });
}

async function toolBoundary(emit: (...records: Record<string, unknown>[]) => Promise<void>) {
  await emit(
    {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "boundary-tool", name: "Bash", input: {} }] },
    },
    {
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "boundary-tool", content: "done" }],
      },
    },
  );
}

test("Claude tool events retain file semantics for aliases without exposing patch bodies", async () => {
  const fixture = await controlledClaude();
  const activities: AgentRuntimeEvent[] = [];
  fixture.session.subscribe((event) => {
    if (event.type === "activity") activities.push(event);
  });
  try {
    await fixture.session.sendMessage("wait");
    await fixture.emit({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "alias-read", name: "ReadFile", input: { path: "src/read.ts" } },
          {
            type: "tool_use",
            id: "alias-edit",
            name: "apply_patch",
            input: { path: "src/edit.ts", patch: "private patch contents" },
          },
          {
            type: "tool_use",
            id: "alias-other",
            name: "CustomTool",
            input: { prompt: "private prompt" },
          },
        ],
      },
    });
    expect(activities).toMatchObject([
      {
        type: "activity",
        activity: {
          detailKind: "tool_started",
          detail: "src/read.ts",
          entries: [{ kind: "tool_start", toolName: "read_file" }],
        },
      },
      {
        type: "activity",
        activity: {
          detailKind: "tool_started",
          detail: "src/edit.ts",
          entries: [{ kind: "tool_start", toolName: "edit_file" }],
        },
      },
      {
        type: "activity",
        activity: {
          detailKind: "tool_started",
          detail: "CustomTool",
          entries: [{ kind: "tool_start", toolName: "CustomTool" }],
        },
      },
    ]);
  } finally {
    await fixture.dispose();
  }
});

async function controlledClaude(
  sessionId?: string,
  onSessionId?: (id: string) => Promise<void>,
  ...args: string[]
) {
  const responses: Response[] = [];
  let waiting: ((response: Response) => void) | undefined;
  const server = Bun.serve({
    port: 0,
    fetch: () => {
      const response = responses.shift();
      return (
        response ??
        new Promise<Response>((resolve) => {
          waiting = resolve;
        })
      );
    },
  });
  const session = await fixtureAdapter(...args).createAgentSession({
    agentWorkspaceDirectory: tmpdir(),
    instructions: TEST_AGENT_INSTRUCTIONS,
    sessionId,
    onSessionId,
    environment: { COFORGE_CLAUDE_EVENT_FEED: server.url.href },
  });
  let serial = 0;
  const markers = new Map<string, () => void>();
  const initialInput = Promise.withResolvers<void>();
  session.subscribe((event) => {
    if (event.type === "text-delta" && event.text === "fixture-input-observed")
      initialInput.resolve();
    if (event.type === "text-delta") markers.get(event.text)?.();
  });
  return {
    session,
    async emit(...records: Record<string, unknown>[]) {
      await initialInput.promise;
      const marker = `fixture-boundary-${++serial}`;
      const observed = new Promise<void>((resolve) => {
        markers.set(marker, resolve);
      });
      const response = Response.json([
        ...records,
        {
          type: "stream_event",
          event: { type: "content_block_delta", delta: { type: "text_delta", text: marker } },
        },
      ]);
      if (waiting) {
        waiting(response);
        waiting = undefined;
      } else responses.push(response);
      await observed;
      markers.delete(marker);
    },
    async dispose() {
      await session.dispose();
      server.stop(true);
    },
  };
}

function fixtureAdapter(...args: string[]): ClaudeCodeDriver {
  return new ClaudeCodeDriver({
    command: [
      process.execPath,
      new URL("./fixtures/claude-stream-json.ts", import.meta.url).pathname,
      ...args,
    ],
  });
}

async function waitForEvent(
  events: AgentRuntimeEvent[],
  type: AgentRuntimeEvent["type"],
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (events.some((event) => event.type === type)) return;
    await Bun.sleep(5);
  }
  throw new Error(`timed out waiting for ${type}`);
}
