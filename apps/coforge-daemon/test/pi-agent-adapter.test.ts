import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentRuntimeEvent } from "../src/code-agent/contract";
import { PiAgentAdapter } from "../src/code-agent/pi/adapter";

test("Pi loads skills before running in a child process behind the code-agent seam", async () => {
  const agentWorkspaceDirectory = await mkdtemp(join(tmpdir(), "coforge-pi-rpc-"));
  process.env.COFORGE_UNDECLARED_TEST_VALUE = "present";
  const adapter = new PiAgentAdapter({
    command: [process.execPath, new URL("./fixtures/pi-rpc.ts", import.meta.url).pathname],
  });

  try {
    const session = await adapter.start({
      agentWorkspaceDirectory,
      environment: { COFORGE_DECLARED_TEST_VALUE: "allowed" },
    });
    const events: AgentRuntimeEvent[] = [];
    const unsubscribe = session.subscribe((event) => events.push(event));

    await session.sendMessage("finish");
    await waitForEvent(events, "completed");
    expect(events).toEqual([
      { type: "text-delta", text: "Pi response" },
      { type: "tool-start", id: "tool-1", name: "bash" },
      {
        type: "activity",
        activity: {
          activity: "running_command",
          level: "info",
          message: "printf safe",
          occurredAt: "2024-12-03T14:02:47.890Z",
        },
      },
      { type: "tool-output", id: "tool-1", text: "tests passed" },
      { type: "tool-end", id: "tool-1", isError: false },
      { type: "completed", status: "completed" },
    ]);

    events.length = 0;
    await session.sendMessage("wait");
    await session.interrupt();
    await waitForEvent(events, "completed");
    expect(events.at(-1)).toEqual({ type: "completed", status: "interrupted" });

    unsubscribe();
    await session.dispose();
  } finally {
    delete process.env.COFORGE_UNDECLARED_TEST_VALUE;
    await rm(agentWorkspaceDirectory, { recursive: true, force: true });
  }
});

test("installed coforge-agent process completes the adapter handshake", async () => {
  const agentWorkspaceDirectory = await mkdtemp(join(tmpdir(), "coforge-pi-installed-"));
  try {
    const session = await new PiAgentAdapter().start({ agentWorkspaceDirectory });
    await session.dispose();
  } finally {
    await rm(agentWorkspaceDirectory, { recursive: true, force: true });
  }
});

test("Pi rejects overlapping prompts and dispose cannot wait on provider interrupt", async () => {
  const agentWorkspaceDirectory = await mkdtemp(join(tmpdir(), "coforge-pi-lifecycle-"));
  const adapter = new PiAgentAdapter({
    command: [process.execPath, new URL("./fixtures/pi-rpc.ts", import.meta.url).pathname],
  });

  try {
    const session = await adapter.start({
      agentWorkspaceDirectory,
      environment: { COFORGE_DECLARED_TEST_VALUE: "allowed" },
    });
    await session.sendMessage("ignore-abort");
    await expect(session.sendMessage("overlap")).rejects.toThrow("already running");
    await session.dispose();
  } finally {
    await rm(agentWorkspaceDirectory, { recursive: true, force: true });
  }
});

test("Pi sends notifications through the prompt protocol and rejects them while busy", async () => {
  const agentWorkspaceDirectory = await mkdtemp(join(tmpdir(), "coforge-pi-notify-"));
  const adapter = new PiAgentAdapter({
    command: [process.execPath, new URL("./fixtures/pi-rpc.ts", import.meta.url).pathname],
  });

  try {
    const session = await adapter.start({
      agentWorkspaceDirectory,
      environment: { COFORGE_DECLARED_TEST_VALUE: "allowed" },
    });
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

test("Pi rejects prompts after its resident Agent runtime process exits", async () => {
  const agentWorkspaceDirectory = await mkdtemp(join(tmpdir(), "coforge-pi-exit-"));
  const adapter = new PiAgentAdapter({
    command: [process.execPath, new URL("./fixtures/pi-rpc.ts", import.meta.url).pathname],
  });

  try {
    const session = await adapter.start({
      agentWorkspaceDirectory,
      environment: {
        COFORGE_DECLARED_TEST_VALUE: "allowed",
        COFORGE_EXIT_AFTER_READY: "1",
      },
    });
    await Bun.sleep(20);
    await expect(session.sendMessage("after-exit")).rejects.toThrow("exited unexpectedly");
    await expect(session.sendMessage("still-exited")).rejects.toThrow("exited unexpectedly");
    await session.dispose();
  } finally {
    await rm(agentWorkspaceDirectory, { recursive: true, force: true });
  }
});

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
