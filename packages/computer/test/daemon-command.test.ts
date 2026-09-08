import { expect, test } from "bun:test";
import type { DaemonCommandRunner } from "@coforge/daemon";
import { createCommand } from "../src/daemon-client";

test("scoped stop and restart dispatch to supervisor without stopping the machine", async () => {
  const calls: string[] = [];
  const command = createCommand({
    daemon: {
      ensureRunning: async () => {},
      command: async (operation, workspaceId) => {
        calls.push(`${operation}:${workspaceId}`);
      },
    },
  });
  await command.stop("workspace-a");
  await command.restart("workspace-a");
  expect(calls).toEqual(["stop:workspace-a", "restart:workspace-a"]);
});

test("Computer commands delegate machine-wide lifecycle to the resident supervisor", async () => {
  const calls: string[] = [];
  const daemon: DaemonCommandRunner & { stop(): Promise<void> } = {
    ensureRunning: async () => {
      calls.push("ensure-running");
    },
    command: async (operation) => {
      calls.push(operation);
    },
    stop: async () => {
      calls.push("process-stop");
    },
  };
  const command = createCommand({ daemon });

  await command.start();
  await command.stop();
  await command.restart();

  expect(calls).toEqual([
    "ensure-running",
    "start",
    "ensure-running",
    "stop",
    "ensure-running",
    "restart",
  ]);
});

test("restart waits for the supervisor's completed replacement response", async () => {
  const stopping = Promise.withResolvers<void>();
  const stopCalled = Promise.withResolvers<void>();
  const calls: string[] = [];
  const command = createCommand({
    daemon: {
      ensureRunning: async () => {},
      command: async (operation) => {
        stopCalled.resolve();
        await stopping.promise;
        calls.push(operation);
      },
    },
  });
  const restarting = command.restart();
  try {
    await stopCalled.promise;
    expect(calls).toEqual([]);
  } finally {
    stopping.resolve();
    await restarting;
  }
  // No unconditional start: the supervisor preserves stopped bindings on global restart.
  expect(calls).toEqual(["restart"]);
});
