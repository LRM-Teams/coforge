import { expect, test } from "bun:test";
import { createCommand } from "../src/daemon-client";

test("Computer daemon commands delegate to Daemon", async () => {
  const calls: string[] = [];
  const command = createCommand({
    daemon: {
      ensureRunning: async () => {
        calls.push("ensure-running");
      },
      command: async (operation) => {
        calls.push(operation);
      },
      stop: async () => {
        calls.push("process-stop");
      },
    },
  });

  await command.start();
  await command.stop();
  await command.restart();

  expect(calls).toEqual(["ensure-running", "start", "stop", "process-stop", "restart"]);
});
