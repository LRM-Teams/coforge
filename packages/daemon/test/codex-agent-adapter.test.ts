import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CodexDriver } from "../src/code-agent/codex/driver";
import type { AgentRuntimeEvent } from "../src/code-agent/contract";

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
      "expected-communication-instructions",
    ],
  });

  try {
    const session = await adapter.createAgentSession({
      agentWorkspaceDirectory,
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
    expect(events).toEqual([
      { type: "text-delta", text: "Codex response" },
      { type: "tool-start", id: "item-1", name: "command" },
      {
        type: "activity",
        activity: {
          activity: "running_command",
          level: "info",
          message: "printf safe",
          occurredAt: "2026-01-02T03:04:05.000Z",
        },
      },
      { type: "tool-output", id: "item-1", text: "tests passed" },
      { type: "tool-end", id: "item-1", isError: false },
      { type: "completed", status: "completed" },
    ]);

    events.length = 0;
    await session.sendMessage("wait");
    await session.interrupt();
    await waitForEvent(events, "completed");
    expect(events.at(-1)).toEqual({ type: "completed", status: "interrupted" });

    events.length = 0;
    await session.sendMessage("files");
    await waitForEvent(events, "completed");
    expect(events).toEqual([
      { type: "text-delta", text: "Codex response" },
      {
        type: "activity",
        activity: {
          activity: "writing_file",
          level: "info",
          message: "src/new.ts",
          occurredAt: "2026-01-02T03:04:05.000Z",
        },
      },
      {
        type: "activity",
        activity: {
          activity: "editing_file",
          level: "info",
          message: "src/existing.ts",
          occurredAt: "2026-01-02T03:04:05.000Z",
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
    const session = await adapter.createAgentSession({ agentWorkspaceDirectory });
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
    const session = await adapter.createAgentSession({ agentWorkspaceDirectory });
    await session.sendMessage("wait");
    await expect(session.sendMessage("overlap")).rejects.toThrow("already running");
    await session.dispose();
  } finally {
    await rm(agentWorkspaceDirectory, { recursive: true, force: true });
  }
});

test("Codex sends notifications through turn/start and rejects them while busy", async () => {
  const agentWorkspaceDirectory = await mkdtemp(join(tmpdir(), "coforge-codex-notify-"));

  try {
    const session = await fixtureAdapter().createAgentSession({ agentWorkspaceDirectory });
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
