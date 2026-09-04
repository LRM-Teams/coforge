import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ClaudeCodeAgentAdapter } from "../src/code-agent/claude-code/adapter";
import { AGENT_RUNTIME_EVENT_TYPE, type AgentRuntimeEvent } from "../src/code-agent/contract";

test("Claude Code waits for the installed CLI init event before becoming ready", async () => {
  const agentWorkspaceDirectory = await mkdtemp(join(tmpdir(), "coforge-claude-code-"));
  const adapter = new ClaudeCodeAgentAdapter({
    command: [
      process.execPath,
      new URL("./fixtures/claude-stream-json.ts", import.meta.url).pathname,
    ],
  });

  try {
    const session = await adapter.start({ agentWorkspaceDirectory });
    expect(session).toBeDefined();
    await session.dispose();
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
    const session = await new ClaudeCodeAgentAdapter().start({
      agentWorkspaceDirectory,
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
    const session = await adapter.start({ agentWorkspaceDirectory });
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
          activity: "running_command",
          level: "info",
          message: "printf safe",
          occurredAt: "2026-01-02T03:04:05.000Z",
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
    const session = await fixtureAdapter().start({ agentWorkspaceDirectory });
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
    const session = await adapter.start({ agentWorkspaceDirectory });
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

test("Claude Code sends notifications through stream-json and rejects them while busy", async () => {
  const agentWorkspaceDirectory = await mkdtemp(join(tmpdir(), "coforge-claude-notify-"));

  try {
    const session = await fixtureAdapter().start({ agentWorkspaceDirectory });
    const events: AgentRuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));
    await session.notify!("New message available. Run coforge message check.");
    await waitForEvent(events, "completed");
    expect(events.at(-1)).toEqual({ type: "completed", status: "completed" });

    await session.sendMessage("wait");
    await expect(
      session.notify!("New message available. Run coforge message check."),
    ).rejects.toThrow("already running");
    await session.dispose();
  } finally {
    await rm(agentWorkspaceDirectory, { recursive: true, force: true });
  }
});

test("Claude Code rejects interrupt when the CLI exits after SIGINT", async () => {
  const adapter = new ClaudeCodeAgentAdapter({
    command: [
      process.execPath,
      new URL("./fixtures/claude-stream-json.ts", import.meta.url).pathname,
      "exit-on-interrupt",
    ],
  });

  const session = await adapter.start({ agentWorkspaceDirectory: tmpdir() });
  try {
    await session.sendMessage("wait");
    await expect(session.interrupt()).rejects.toThrow("exited unexpectedly");
  } finally {
    await session.dispose();
  }
});

test("Claude Code startup fails when its CLI does not complete initialization", async () => {
  const adapter = new ClaudeCodeAgentAdapter({
    command: [process.execPath, new URL("./fixtures/invalid-jsonl.ts", import.meta.url).pathname],
  });

  await expect(
    Promise.race([
      adapter.start({ agentWorkspaceDirectory: tmpdir() }),
      Bun.sleep(200).then(() => {
        throw new Error("startup timed out");
      }),
    ]),
  ).rejects.toThrow("invalid output");
});

function fixtureAdapter(): ClaudeCodeAgentAdapter {
  return new ClaudeCodeAgentAdapter({
    command: [
      process.execPath,
      new URL("./fixtures/claude-stream-json.ts", import.meta.url).pathname,
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
