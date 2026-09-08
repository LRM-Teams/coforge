import { expect, test } from "bun:test";
import type { DaemonCommandRunner } from "@coforge/daemon";
import { createCommand } from "../src/daemon-client";

test("Computer daemon commands delegate to Daemon", async () => {
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

  expect(calls).toEqual(["ensure-running", "start", "stop", "restart"]);
});
