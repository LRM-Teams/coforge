import { expect, test } from "bun:test";
import { WindowsUserDaemonHost } from "@coforge/daemon";

test("Windows task dispatches the daemon through the unified executable at logon", async () => {
  const commands: string[][] = [];
  const taskStartFailed = new Error("task start failed for test");
  const task = new WindowsUserDaemonHost({
    executablePath: "C:\\Users\\alice\\Coforge\\coforge-computer.exe",
    socketPath: "\\\\.\\pipe\\coforge-daemon",
    run: async (command) => {
      commands.push(command);
      if (command[1] === "/Run") throw taskStartFailed;
      return 0;
    },
  });
  await expect(
    task.ensureStarted({
      workspaceId: "w",
      computerId: "computer",
      workspaceRoot: "/w",
      daemonApiKey: "secret",
    }),
  ).rejects.toBe(taskStartFailed);
  expect(commands[0]).toContain("ONLOGON");
  expect(commands[0]).toContain("/F");
  expect(commands[0]).toContain(
    '"C:\\Users\\alice\\Coforge\\coforge-computer.exe" __daemon --socket \\\\.\\pipe\\coforge-daemon',
  );
  expect(commands[1]).toEqual(["schtasks.exe", "/Run", "/TN", "CoForge Daemon"]);
});

test("Windows ensureRunning reports task start failure before waiting for a socket", async () => {
  const commands: string[][] = [];
  const task = new WindowsUserDaemonHost({
    executablePath: "C:\\Coforge\\coforge-computer.exe",
    socketPath: "\\\\.\\pipe\\coforge-daemon",
    run: async (command) => {
      commands.push(command);
      return 1;
    },
  });

  await expect(task.ensureRunning()).rejects.toThrow(
    "Run `coforge-computer foreground` under an external supervisor",
  );
  expect(commands).toEqual([["schtasks.exe", "/Run", "/TN", "CoForge Daemon"]]);
});
