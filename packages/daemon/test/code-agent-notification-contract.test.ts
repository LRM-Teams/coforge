import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeEvent } from "../src/code-agent/contract";
import { CodexDriver } from "../src/code-agent/codex/driver";
import { ClaudeCodeDriver } from "../src/code-agent/claude-code/driver";
import { PiDriver } from "../src/code-agent/pi/driver";

const command = (fixture: string) => [
  process.execPath,
  new URL(`./fixtures/${fixture}`, import.meta.url).pathname,
];
const drivers = [
  new CodexDriver({ command: command("codex-app-server.ts") }),
  new ClaudeCodeDriver({ command: command("claude-stream-json.ts") }),
  new PiDriver({ command: command("pi-rpc.ts") }),
];

for (const driver of drivers) {
  test(`${driver.provider}: notification acceptance is independent of run completion`, async () => {
    const agentWorkspaceDirectory = await mkdtemp(join(tmpdir(), "coforge-notification-contract-"));
    const session = await driver.createAgentSession({
      agentWorkspaceDirectory,
      environment: { COFORGE_DECLARED_TEST_VALUE: "allowed" },
    });
    const events: AgentRuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      await session.notify!("wait");
      await expect(session.sendMessage("overlap")).rejects.toThrow();
      expect(events.filter((event) => event.type === "completed")).toEqual([]);
      // Busy delivery timing is provider-specific and covered by adapter tests.
      await session.dispose();
      await expect(session.notify!("after disposal")).rejects.toThrow();
    } finally {
      await session.dispose();
      await rm(agentWorkspaceDirectory, { recursive: true, force: true });
    }
  });
}
