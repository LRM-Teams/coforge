import { expect, test } from "bun:test";
import {
  WindowsUserDaemonHost,
  windowsDaemonTaskXml,
} from "../src/daemon-host/windows-task";
import { windowsUpgradeTaskXml } from "../src/platform/computer-upgrade-launcher";

test("windowsDaemonTaskXml registers a least-privilege interactive logon task", () => {
  const xml = windowsDaemonTaskXml({
    userId: "DESKTOP\\alice",
    executablePath: "C:\\Users\\alice\\Coforge\\coforge-computer.exe",
    socketPath: "C:\\Users\\alice\\.coforge\\daemon\\daemon.sock",
    stateDirectory: "C:\\Users\\alice\\.coforge\\daemon",
  });
  expect(xml).toContain("<LogonTrigger>");
  expect(xml).toContain("<UserId>DESKTOP\\alice</UserId>");
  expect(xml).toContain("<LogonType>InteractiveToken</LogonType>");
  expect(xml).toContain("<RunLevel>LeastPrivilege</RunLevel>");
  expect(xml).toContain("<Command>C:\\Users\\alice\\Coforge\\coforge-computer.exe</Command>");
  expect(xml).toContain(
    "<Arguments>__daemon --socket C:\\Users\\alice\\.coforge\\daemon\\daemon.sock --state-directory C:\\Users\\alice\\.coforge\\daemon</Arguments>",
  );
  expect(xml).toContain("<RestartOnFailure>");
  expect(xml).toContain("<AllowStartOnDemand>true</AllowStartOnDemand>");
  expect(xml).toContain("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
});

test("windowsDaemonTaskXml escapes XML metacharacters in paths", () => {
  const xml = windowsDaemonTaskXml({
    userId: "A&B\\user",
    executablePath: "C:\\Path <x>&\"y\"\\coforge-computer.exe",
    socketPath: "C:\\sock&et.sock",
  });
  expect(xml).toContain("<UserId>A&amp;B\\user</UserId>");
  expect(xml).toContain(
    "<Command>C:\\Path &lt;x&gt;&amp;&quot;y&quot;\\coforge-computer.exe</Command>",
  );
  expect(xml).toContain("<Arguments>__daemon --socket C:\\sock&amp;et.sock</Arguments>");
});

test("windowsDaemonTaskXml wraps a connection endpoint in cmd.exe", () => {
  const xml = windowsDaemonTaskXml({
    userId: "DESKTOP\\alice",
    executablePath: "C:\\coforge-computer.exe",
    socketPath: "C:\\daemon.sock",
    daemonConnectionEndpoint: "ws://127.0.0.1:8000/connection/websocket",
  });
  expect(xml).toContain("<Command>cmd.exe</Command>");
  expect(xml).toContain("COFORGE_DAEMON_CONNECTION_ENDPOINT=");
  expect(xml).toContain("__daemon --socket C:\\daemon.sock");
});

test("ensureStarted creates the daemon host via schtasks /XML then /Run", async () => {
  const commands: string[][] = [];
  const written: { path: string; content: string }[] = [];
  const task = new WindowsUserDaemonHost({
    executablePath: "C:\\Coforge\\coforge-computer.exe",
    socketPath: "C:\\Users\\alice\\.coforge\\daemon\\daemon.sock",
    stateDirectory: "C:\\Users\\alice\\.coforge\\daemon",
    userId: "DESKTOP\\alice",
    timeoutMilliseconds: 20,
    writeTaskXml: async (path, content) => {
      written.push({ path, content });
    },
    run: async (command) => {
      commands.push(command);
      return 1;
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
  expect(written).toHaveLength(1);
  expect(written[0]!.content).toContain("<LogonTrigger>");
  expect(written[0]!.content).toContain("<RunLevel>LeastPrivilege</RunLevel>");
  expect(commands[0]!.slice(0, 5)).toEqual([
    "schtasks.exe",
    "/Create",
    "/TN",
    "CoForge Daemon",
    "/XML",
  ]);
  expect(commands[0]![5]).toBe(written[0]!.path);
  expect(commands[0]!).toContain("/F");
  expect(commands).toHaveLength(1);
});

test("ensureStarted runs the task when XML Create succeeds", async () => {
  const commands: string[][] = [];
  const task = new WindowsUserDaemonHost({
    executablePath: "C:\\Coforge\\coforge-computer.exe",
    socketPath: "C:\\Users\\alice\\.coforge\\daemon\\daemon.sock",
    userId: "DESKTOP\\alice",
    timeoutMilliseconds: 20,
    writeTaskXml: async () => {},
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
  expect(commands[0]![1]).toBe("/Create");
  expect(commands[1]).toEqual(["schtasks.exe", "/Run", "/TN", "CoForge Daemon"]);
});

test("Windows one-shot upgrade XML uses a locale-independent start boundary", () => {
  const xml = windowsUpgradeTaskXml({
    userId: "DESKTOP\\alice",
    action: [
      "C:\\Coforge\\coforge-computer.exe",
      "__remote-upgrade",
      "--request-id",
      "x",
      "--version",
      "1",
    ],
  });
  expect(xml).toContain("<StartBoundary>2099-01-01T00:00:00</StartBoundary>");
  expect(xml).toContain("<RunLevel>LeastPrivilege</RunLevel>");
  expect(xml).toContain("<Command>C:\\Coforge\\coforge-computer.exe</Command>");
  expect(xml).toContain("__remote-upgrade");
});
