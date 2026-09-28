import { expect, test } from "bun:test";
import { WindowsUserDaemonHost } from "@lrm/coforge-daemon";

test("Windows task dispatches the daemon through XML logon registration", async () => {
  const commands: string[][] = [];
  const written: string[] = [];
  const task = new WindowsUserDaemonHost({
    executablePath: "C:\\Users\\alice\\Coforge\\coforge-computer.exe",
    socketPath: "C:\\Users\\alice\\.coforge\\daemon\\daemon.sock",
    userId: "DESKTOP\\alice",
    timeoutMilliseconds: 20,
    writeTaskXml: async (_path, content) => {
      written.push(content);
    },
    run: async (command) => {
      commands.push(command);
      return command[1] === "/Run" ? 1 : 0;
    },
  });
  await expect(
    task.ensureStarted({
      workspaceId: "w",
      computerId: "computer",
      workspaceRoot: "/w",
      daemonApiKey: "secret",
    }),
  ).rejects.toThrow("Run `coforge-computer foreground` under an external supervisor");
  expect(written[0]).toContain("<LogonTrigger>");
  expect(written[0]).toContain("<RunLevel>LeastPrivilege</RunLevel>");
  expect(commands[0]!.slice(0, 5)).toEqual([
    "schtasks.exe",
    "/Create",
    "/TN",
    "CoForge Daemon",
    "/XML",
  ]);
  expect(commands[0]!).toContain("/F");
  expect(commands[1]).toEqual(["schtasks.exe", "/Run", "/TN", "CoForge Daemon"]);
});

test("ensureStarted falls back to a live local supervisor when task Create is refused", async () => {
  const commands: string[][] = [];
  const task = new WindowsUserDaemonHost({
    executablePath: "C:\\Coforge\\coforge-computer.exe",
    socketPath: "C:\\Users\\alice\\.coforge\\daemon\\daemon.sock",
    userId: "DESKTOP\\alice",
    writeTaskXml: async () => {},
    run: async (command) => {
      commands.push(command);
      return 1;
    },
    timeoutMilliseconds: 20,
  });
  await expect(
    task.ensureStarted({
      workspaceId: "w",
      computerId: "computer",
      workspaceRoot: "/w",
      daemonApiKey: "secret",
    }),
  ).rejects.toThrow("Run `coforge-computer foreground` under an external supervisor");
  expect(commands).toHaveLength(1);
  expect(commands[0]!.slice(0, 5)).toEqual([
    "schtasks.exe",
    "/Create",
    "/TN",
    "CoForge Daemon",
    "/XML",
  ]);
});

test("Windows ensureRunning reports task start failure before waiting for a socket", async () => {
  const commands: string[][] = [];
  const task = new WindowsUserDaemonHost({
    executablePath: "C:\\Coforge\\coforge-computer.exe",
    socketPath: "C:\\Users\\alice\\.coforge\\daemon\\daemon.sock",
    userId: "DESKTOP\\alice",
    writeTaskXml: async () => {},
    run: async (command) => {
      commands.push(command);
      return 1;
    },
  });

  await expect(task.ensureRunning()).rejects.toThrow(
    "Run `coforge-computer foreground` under an external supervisor",
  );
  expect(commands[0]![1]).toBe("/Create");
});

test("restart ends then reinstalls and runs the scheduled task", async () => {
  const commands: string[][] = [];
  const task = new WindowsUserDaemonHost({
    executablePath: "C:\\Coforge\\coforge-computer.exe",
    socketPath: "C:\\Users\\alice\\.coforge\\daemon\\daemon.sock",
    userId: "DESKTOP\\alice",
    writeTaskXml: async () => {},
    run: async (command) => {
      commands.push(command);
      // Fail /Run so this exercises only the command sequence, not the local handshake.
      return command[1] === "/Run" ? 1 : 0;
    },
  });

  await expect(task.restart()).rejects.toThrow("could not restart the CoForge Daemon user task");
  expect(commands[0]).toEqual(["schtasks.exe", "/End", "/TN", "CoForge Daemon"]);
  expect(commands[1]!.slice(0, 5)).toEqual([
    "schtasks.exe",
    "/Create",
    "/TN",
    "CoForge Daemon",
    "/XML",
  ]);
  expect(commands[2]).toEqual(["schtasks.exe", "/Run", "/TN", "CoForge Daemon"]);
});

test("restart ignores /End's own exit code (the task may already be stopped)", async () => {
  const commands: string[][] = [];
  const task = new WindowsUserDaemonHost({
    executablePath: "C:\\Coforge\\coforge-computer.exe",
    socketPath: "C:\\Users\\alice\\.coforge\\daemon\\daemon.sock",
    userId: "DESKTOP\\alice",
    writeTaskXml: async () => {},
    run: async (command) => {
      commands.push(command);
      return 1;
    },
  });

  await expect(task.restart()).rejects.toThrow("could not restart the CoForge Daemon user task");
  expect(commands[0]).toEqual(["schtasks.exe", "/End", "/TN", "CoForge Daemon"]);
  expect(commands[1]![1]).toBe("/Create");
});
