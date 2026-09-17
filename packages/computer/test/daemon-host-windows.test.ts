import { expect, test } from "bun:test";
import { WindowsUserDaemonHost } from "@lrm/coforge-daemon";

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

test("restart ends then runs the scheduled task, in that order", async () => {
  const commands: string[][] = [];
  const task = new WindowsUserDaemonHost({
    executablePath: "C:\\Coforge\\coforge-computer.exe",
    socketPath: "\\\\.\\pipe\\coforge-daemon",
    run: async (command) => {
      commands.push(command);
      // Fails the /Run step deliberately so this exercises only the command sequence and
      // error handling, not the local-handshake wait that a real success would go on to do.
      return command[1] === "/Run" ? 1 : 0;
    },
  });

  await expect(task.restart()).rejects.toThrow("could not restart the CoForge Daemon user task");
  expect(commands).toEqual([
    ["schtasks.exe", "/End", "/TN", "CoForge Daemon"],
    ["schtasks.exe", "/Run", "/TN", "CoForge Daemon"],
  ]);
});

test("restart ignores /End's own exit code (the task may already be stopped)", async () => {
  const commands: string[][] = [];
  const task = new WindowsUserDaemonHost({
    executablePath: "C:\\Coforge\\coforge-computer.exe",
    socketPath: "\\\\.\\pipe\\coforge-daemon",
    run: async (command) => {
      commands.push(command);
      return 1;
    },
  });

  // /End's failure (1) is ignored; /Run's own failure (also 1 here) is what surfaces.
  await expect(task.restart()).rejects.toThrow("could not restart the CoForge Daemon user task");
  expect(commands).toEqual([
    ["schtasks.exe", "/End", "/TN", "CoForge Daemon"],
    ["schtasks.exe", "/Run", "/TN", "CoForge Daemon"],
  ]);
});
