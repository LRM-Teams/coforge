import { expect, test } from "bun:test";
import { WindowsUserDaemonHost } from "@coforge/daemon";

test("Windows daemon task runs at the current user's logon", async () => {
  const commands: string[][] = [];
  const task = new WindowsUserDaemonHost({
    executablePath: "C:\\Users\\alice\\Coforge\\coforge-daemon.exe",
    socketPath: "\\\\.\\pipe\\coforge-daemon",
    run: async (command) => {
      commands.push(command);
      return 0;
    },
  });
  await task
    .ensureStarted({
      workspaceId: "w",
      connectionId: "c",
      workspaceRoot: "/w",
      workspaceWorkerToken: "secret",
    })
    .catch(() => undefined);
  expect(commands[0]).toContain("ONLOGON");
  expect(commands[0]).toContain("/F");
  expect(commands[1]).toEqual(["schtasks.exe", "/Run", "/TN", "CoForge Daemon"]);
});
