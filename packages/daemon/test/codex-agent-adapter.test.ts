import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CodexDriver } from "../src/code-agent/codex/driver";
import type { AgentRuntimeEvent } from "../src/code-agent/contract";

const TEST_AGENT_INSTRUCTIONS = "Test Agent instructions.";

test("Codex resumes or starts fresh only for the native missing-thread error", async () => {
  const adapter = new CodexDriver({
    command: [
      process.execPath,
      new URL("./fixtures/codex-app-server.ts", import.meta.url).pathname,
    ],
  });
  const session = await adapter.createAgentSession({
    agentWorkspaceDirectory: tmpdir(),
    instructions: TEST_AGENT_INSTRUCTIONS,
    sessionId: "thread-1",
  });
  await session.dispose();
  const reports: Array<[string, string | undefined]> = [];
  const fresh = await adapter.createAgentSession({
    agentWorkspaceDirectory: tmpdir(),
    instructions: TEST_AGENT_INSTRUCTIONS,
    sessionId: "missing-thread",
    async onSessionId(id, replaced) {
      reports.push([id, replaced]);
    },
  });
  await fresh.dispose();
  expect(reports).toEqual([["thread-1", "missing-thread"]]);
  await expect(
    adapter.createAgentSession({
      agentWorkspaceDirectory: tmpdir(),
      instructions: TEST_AGENT_INSTRUCTIONS,
      sessionId: "unreadable-thread",
    }),
  ).rejects.toMatchObject({
    responseError: {
      code: -32603,
      message: "failed to read thread: permission denied",
    },
  });
});

test("Codex loads skills before running app-server behind the code-agent seam", async () => {
  const agentWorkspaceDirectory = await mkdtemp(join(tmpdir(), "coforge-codex-"));
  const skillDirectory = join(agentWorkspaceDirectory, ".agents", "skills", "fixture-skill");
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(
    join(skillDirectory, "SKILL.md"),
    "---\nname: fixture-skill\ndescription: Fixture skill\n---\n",
  );
  const adapter = new CodexDriver({
    command: [
      process.execPath,
      new URL("./fixtures/codex-app-server.ts", import.meta.url).pathname,
      "expected-skill=fixture-skill",
      "expected-coforge-environment",
      "expected-runtime-config",
      "expected-agent-instructions",
    ],
  });

  try {
    const session = await adapter.createAgentSession({
      agentWorkspaceDirectory,
      instructions: TEST_AGENT_INSTRUCTIONS,
      runtime: {
        provider: "codex",
        model: "gpt-5.6-sol",
        modelProvider: "",
        reasoning: "high",
      },
    });
    const events: AgentRuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));

    await session.sendMessage("finish");
    await waitForEvent(events, "completed");
    expect(events.filter((event) => event.type !== "session")).toEqual([
      { type: "text-delta", text: "Codex response" },
      { type: "tool-start", id: "item-1", name: "command" },
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
      { type: "tool-output", id: "item-1", text: "tests passed" },
      { type: "tool-end", id: "item-1", isError: false },
      { type: "completed", status: "completed" },
    ]);

    expect(events.filter((event) => event.type === "session")).toEqual([
      { type: "session", identity: { sessionId: "thread-1", state: "unknown" } },
      { type: "session", identity: { sessionId: "thread-1", state: "resumable" } },
    ]);
    events.length = 0;
    await session.sendMessage("wait");
    await session.interrupt();
    await waitForEvent(events, "completed");
    expect(events.at(-1)).toEqual({ type: "completed", status: "interrupted" });

    events.length = 0;
    await session.sendMessage("files");
    await waitForEvent(events, "completed");
    expect(events.filter((event) => event.type !== "session")).toEqual([
      { type: "text-delta", text: "Codex response" },
      {
        type: "activity",
        activity: {
          detailKind: "tool_started",
          level: "info",
          detail: "src/new.ts",
          observedAtMs: Date.parse("2026-01-02T03:04:05.000Z"),
          entries: [{ kind: "tool_start", toolName: "write_file" }],
        },
      },
      {
        type: "activity",
        activity: {
          detailKind: "tool_started",
          level: "info",
          detail: "src/existing.ts",
          observedAtMs: Date.parse("2026-01-02T03:04:05.000Z"),
          entries: [{ kind: "tool_start", toolName: "edit_file" }],
        },
      },
      { type: "completed", status: "completed" },
    ]);

    await session.dispose();
  } finally {
    await rm(agentWorkspaceDirectory, { recursive: true, force: true });
  }
});

test("Codex starts the user's installed CLI from PATH", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coforge-codex-installed-"));
  const agentWorkspaceDirectory = join(directory, "workspace");
  const binDirectory = join(directory, "bin");
  await mkdir(agentWorkspaceDirectory);
  await mkdir(binDirectory);
  const executable = join(binDirectory, "codex");
  await writeFile(
    executable,
    '#!/bin/sh\nprintf started > "$COFORGE_CODEX_MARKER"\nexec "$COFORGE_BUN_EXEC" "$COFORGE_CODEX_FIXTURE" "$@"\n',
  );
  await chmod(executable, 0o755);
  const marker = join(directory, "codex-started");

  try {
    const session = await new CodexDriver().createAgentSession({
      agentWorkspaceDirectory,
      instructions: TEST_AGENT_INSTRUCTIONS,
      environment: {
        PATH: binDirectory,
        COFORGE_BUN_EXEC: process.execPath,
        COFORGE_CODEX_FIXTURE: new URL("./fixtures/codex-app-server.ts", import.meta.url).pathname,
        COFORGE_CODEX_MARKER: marker,
      },
    });
    expect(await readFile(marker, "utf8")).toBe("started");
    await session.dispose();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Codex returns to idle when turn creation is invalid", async () => {
  const agentWorkspaceDirectory = await mkdtemp(join(tmpdir(), "coforge-codex-invalid-"));
  const adapter = fixtureAdapter();

  try {
    const session = await adapter.createAgentSession({
      agentWorkspaceDirectory,
      instructions: TEST_AGENT_INSTRUCTIONS,
    });
    await expect(session.sendMessage("invalid-turn")).rejects.toThrow("did not create a turn");
    await session.sendMessage("finish");
    await session.dispose();
  } finally {
    await rm(agentWorkspaceDirectory, { recursive: true, force: true });
  }
});

test("Codex rejects overlapping prompts and dispose does not wait on interrupt", async () => {
  const agentWorkspaceDirectory = await mkdtemp(join(tmpdir(), "coforge-codex-lifecycle-"));
  const adapter = fixtureAdapter();

  try {
    const session = await adapter.createAgentSession({
      agentWorkspaceDirectory,
      instructions: TEST_AGENT_INSTRUCTIONS,
    });
    await session.sendMessage("wait");
    await expect(session.sendMessage("overlap")).rejects.toThrow("already running");
    await session.dispose();
  } finally {
    await rm(agentWorkspaceDirectory, { recursive: true, force: true });
  }
});

test("Codex starts idle notifications and steers busy notifications in the same session", async () => {
  const agentWorkspaceDirectory = await mkdtemp(join(tmpdir(), "coforge-codex-notify-"));

  try {
    const session = await fixtureAdapter().createAgentSession({
      agentWorkspaceDirectory,
      instructions: TEST_AGENT_INSTRUCTIONS,
    });
    const events: AgentRuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));
    await session.notify!("New message available. Run coforge message check.");
    await waitForEvent(events, "completed");
    expect(events.filter((event) => event.type === "completed").at(-1)).toEqual({
      type: "completed",
      status: "completed",
    });

    await session.sendMessage("wait");
    await session.notify!("New message available. Run coforge message check.");
    await expect(session.sendMessage("reentrant")).rejects.toThrow("already running");
    await session.dispose();
  } finally {
    await rm(agentWorkspaceDirectory, { recursive: true, force: true });
  }
});

test("Codex waits for the starting turn ID before steering", async () => {
  const agentWorkspaceDirectory = await mkdtemp(join(tmpdir(), "coforge-codex-starting-"));
  const session = await fixtureAdapter().createAgentSession({
    agentWorkspaceDirectory,
    instructions: TEST_AGENT_INSTRUCTIONS,
  });
  try {
    const start = session.sendMessage("wait");
    const notification = session.notify!("starting notice");
    await Promise.all([start, notification]);
    await expect(session.sendMessage("overlap")).rejects.toThrow("already running");
  } finally {
    await session.dispose();
    await rm(agentWorkspaceDirectory, { recursive: true, force: true });
  }
});

for (const notice of ["race-before", "race-after"]) {
  test(`Codex starts a notification rejected at turn end (${notice})`, async () => {
    const agentWorkspaceDirectory = await mkdtemp(join(tmpdir(), "coforge-codex-race-"));
    const session = await fixtureAdapter().createAgentSession({
      agentWorkspaceDirectory,
      instructions: TEST_AGENT_INSTRUCTIONS,
    });
    try {
      await session.sendMessage("wait");
      const startedInput = new Promise<string>((resolve) => {
        session.subscribe((event) => {
          if (event.type === "text-delta" && event.text.startsWith("Started: "))
            resolve(event.text);
        });
      });
      await session.notify!(notice);
      expect(await startedInput).toBe(`Started: ${notice}`);
      // The retry created turn 2, still in the original thread; a subsequent
      // steer validates that ID at the app-server boundary.
      await session.notify!("after race");
      await expect(session.sendMessage("overlap")).rejects.toThrow("already running");
    } finally {
      await session.dispose();
      await rm(agentWorkspaceDirectory, { recursive: true, force: true });
    }
  });
}

test("Codex propagates steering rejection without starting another turn", async () => {
  const agentWorkspaceDirectory = await mkdtemp(join(tmpdir(), "coforge-codex-rejection-"));
  const session = await fixtureAdapter().createAgentSession({
    agentWorkspaceDirectory,
    instructions: TEST_AGENT_INSTRUCTIONS,
  });
  try {
    await session.sendMessage("wait");
    await expect(session.notify!("reject-notice")).rejects.toThrow("code agent request failed");
    await expect(session.notify!("wrong-turn-response")).rejects.toThrow(
      "Codex did not accept the notification",
    );
    await expect(session.sendMessage("overlap")).rejects.toThrow("already running");
    await session.notify!("retry accepted");
  } finally {
    await session.dispose();
    await rm(agentWorkspaceDirectory, { recursive: true, force: true });
  }
});

function fixtureAdapter(): CodexDriver {
  return new CodexDriver({
    command: [
      process.execPath,
      new URL("./fixtures/codex-app-server.ts", import.meta.url).pathname,
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

test("Codex reports retry errors as activity without ending the active turn", async () => {
  const session = await fixtureAdapter().createAgentSession({
    agentWorkspaceDirectory: tmpdir(),
    instructions: TEST_AGENT_INSTRUCTIONS,
  });
  const events: AgentRuntimeEvent[] = [];
  const observed = new Promise<void>((resolve) => {
    session.subscribe((event) => {
      events.push(event);
      if (event.type === "text-delta" && event.text === "retry observed") resolve();
    });
  });
  try {
    await session.sendMessage("retry-error");
    await observed;
    expect(events.filter((event) => event.type === "activity")).toEqual([
      {
        type: "activity",
        activity: expect.objectContaining({
          detailKind: "runtime_error",
          level: "error",
          detail: "Retrying: request timed out: Bearer [redacted]",
        }),
      },
    ]);
    expect(events.some((event) => event.type === "completed")).toBe(false);
    await session.notify!("retry accepted");
    await expect(session.sendMessage("overlap")).rejects.toThrow("already running");
  } finally {
    await session.dispose();
  }
});
