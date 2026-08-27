import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ClaudeCodeAgentAdapter } from "../src/code-agent/claude-code/adapter";
import type { AgentRuntimeEvent } from "../src/code-agent/contract";

test("Claude Code discovers workspace skills before its resident CLI process is ready", async () => {
  const agentWorkspaceDirectory = await mkdtemp(join(tmpdir(), "coforge-claude-code-"));
  const skillDirectory = join(agentWorkspaceDirectory, ".claude", "skills", "fixture-skill");
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(
    join(skillDirectory, "SKILL.md"),
    "---\nname: fixture-skill\ndescription: Fixture skill\n---\n",
  );
  const adapter = new ClaudeCodeAgentAdapter({
    command: [
      process.execPath,
      new URL("./fixtures/claude-stream-json.ts", import.meta.url).pathname,
      "expected-skill=fixture-skill",
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
    '#!/bin/sh\nprintf "%s" "$*" > "$COFORGE_CLAUDE_ARGS"\nexec "$COFORGE_BUN_EXEC" "$COFORGE_CLAUDE_FIXTURE"\n',
  );
  await chmod(executable, 0o755);
  const argumentsFile = join(directory, "claude-arguments");

  try {
    const session = await new ClaudeCodeAgentAdapter().start({
      agentWorkspaceDirectory,
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

    await session.prompt("finish");
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

test("Claude Code rejects overlapping turns and interrupts without replacing its CLI process", async () => {
  const agentWorkspaceDirectory = await mkdtemp(join(tmpdir(), "coforge-claude-lifecycle-"));
  const adapter = fixtureAdapter();

  try {
    const session = await adapter.start({ agentWorkspaceDirectory });
    const events: AgentRuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));

    await session.prompt("wait");
    await expect(session.prompt("overlap")).rejects.toThrow("already running");
    await session.interrupt();
    await waitForEvent(events, "completed");
    expect(events.at(-1)).toEqual({ type: "completed", status: "interrupted" });

    events.length = 0;
    await session.prompt("finish");
    await waitForEvent(events, "completed");
    expect(events.at(-1)).toEqual({ type: "completed", status: "completed" });
    await session.dispose();
  } finally {
    await rm(agentWorkspaceDirectory, { recursive: true, force: true });
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
