import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CodexAgentAdapter } from "../src/code-agent/codex/adapter";
import type { CodeAgentEvent } from "../src/code-agent/contract";

test("Codex loads skills before running app-server behind the code-agent seam", async () => {
  const agentWorkspaceDirectory = await mkdtemp(join(tmpdir(), "coforge-codex-"));
  const adapter = new CodexAgentAdapter({
    command: [
      process.execPath,
      new URL("./fixtures/codex-app-server.ts", import.meta.url).pathname,
    ],
  });

  try {
    const session = await adapter.start({ agentWorkspaceDirectory });
    const events: CodeAgentEvent[] = [];
    session.subscribe((event) => events.push(event));

    await session.prompt("finish");
    await waitForEvent(events, "completed");
    expect(events).toEqual([
      { type: "text-delta", text: "Codex response" },
      { type: "tool-start", id: "item-1", name: "command" },
      { type: "tool-output", id: "item-1", text: "tests passed" },
      { type: "tool-end", id: "item-1", isError: false },
      { type: "completed", status: "completed" },
    ]);

    events.length = 0;
    await session.prompt("wait");
    await session.interrupt();
    await waitForEvent(events, "completed");
    expect(events.at(-1)).toEqual({ type: "completed", status: "interrupted" });

    await session.dispose();
  } finally {
    await rm(agentWorkspaceDirectory, { recursive: true, force: true });
  }
});

test("installed Codex app-server completes the adapter handshake", async () => {
  const agentWorkspaceDirectory = await mkdtemp(join(tmpdir(), "coforge-codex-installed-"));
  try {
    const session = await new CodexAgentAdapter().start({ agentWorkspaceDirectory });
    await session.dispose();
  } finally {
    await rm(agentWorkspaceDirectory, { recursive: true, force: true });
  }
});

test("Codex returns to idle when turn creation is invalid", async () => {
  const agentWorkspaceDirectory = await mkdtemp(join(tmpdir(), "coforge-codex-invalid-"));
  const adapter = fixtureAdapter();

  try {
    const session = await adapter.start({ agentWorkspaceDirectory });
    await expect(session.prompt("invalid-turn")).rejects.toThrow("did not create a turn");
    await session.prompt("finish");
    await session.dispose();
  } finally {
    await rm(agentWorkspaceDirectory, { recursive: true, force: true });
  }
});

test("Codex rejects overlapping prompts and dispose does not wait on interrupt", async () => {
  const agentWorkspaceDirectory = await mkdtemp(join(tmpdir(), "coforge-codex-lifecycle-"));
  const adapter = fixtureAdapter();

  try {
    const session = await adapter.start({ agentWorkspaceDirectory });
    await session.prompt("wait");
    await expect(session.prompt("overlap")).rejects.toThrow("already running");
    await session.dispose();
  } finally {
    await rm(agentWorkspaceDirectory, { recursive: true, force: true });
  }
});

function fixtureAdapter(): CodexAgentAdapter {
  return new CodexAgentAdapter({
    command: [
      process.execPath,
      new URL("./fixtures/codex-app-server.ts", import.meta.url).pathname,
    ],
  });
}

async function waitForEvent(events: CodeAgentEvent[], type: CodeAgentEvent["type"]): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (events.some((event) => event.type === type)) return;
    await Bun.sleep(5);
  }
  throw new Error(`timed out waiting for ${type}`);
}
