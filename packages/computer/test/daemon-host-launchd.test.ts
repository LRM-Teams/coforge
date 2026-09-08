import { expect, test } from "bun:test";
import { LaunchdDaemonHost, launchdPlist } from "@coforge/daemon";

test("launchd service dispatches the daemon through the unified executable", () => {
  const plist = launchdPlist({
    label: "cn.coforge.computer.daemon",
    executablePath: "/Users/alice/.coforge/computer/install/active/coforge-computer",
    socketPath: "/Users/alice/.coforge/daemon/daemon.sock",
  });

  expect(plist).toContain("<key>RunAtLoad</key>");
  expect(plist).toContain("<key>KeepAlive</key>");
  expect(plist).toContain(
    "<array><string>/Users/alice/.coforge/computer/install/active/coforge-computer</string><string>__daemon</string><string>--socket</string>",
  );
  expect(plist).not.toContain("alice-secret");
});

test("launchd installation is idempotent and does not restart an installed user agent", async () => {
  const commands: string[][] = [];
  const writes: string[] = [];
  let installed = false;
  const service = new LaunchdDaemonHost({
    serverUrl: "https://coforge.test",
    label: "cn.coforge.computer.daemon",
    executablePath: "/install/coforge-daemon",
    socketPath: "/state/daemon.sock",
    homeDirectory: "/Users/alice",
    uid: 501,
    writeFile: async (path) => {
      writes.push(path);
    },
    run: async (command) => {
      commands.push(command);
      if (command[1] === "print") return installed ? 0 : 1;
      if (command[1] === "bootstrap") installed = true;
      return 0;
    },
  });

  await service.ensureInstalled();
  await service.ensureInstalled();
  expect(writes).toHaveLength(1);
  expect(commands).toEqual([
    ["launchctl", "print", "gui/501/cn.coforge.computer.daemon"],
    [
      "launchctl",
      "bootstrap",
      "gui/501",
      "/Users/alice/Library/LaunchAgents/cn.coforge.computer.daemon.plist",
    ],
    ["launchctl", "print", "gui/501/cn.coforge.computer.daemon"],
  ]);
});

test("launchd ensureRunning starts only through the user agent before handshaking", async () => {
  const commands: string[][] = [];
  const registrationFailed = new Error("registration failed for test");
  const service = new LaunchdDaemonHost({
    label: "cn.coforge.computer.daemon",
    executablePath: "/install/coforge-computer",
    socketPath: "/state/daemon.sock",
    homeDirectory: "/Users/alice",
    uid: 501,
    writeFile: async () => {},
    run: async (command) => {
      commands.push(command);
      if (command[1] === "print") return 1;
      throw registrationFailed;
    },
  });

  await expect(service.ensureRunning()).rejects.toBe(registrationFailed);
  expect(commands).toEqual([
    ["launchctl", "print", "gui/501/cn.coforge.computer.daemon"],
    [
      "launchctl",
      "bootstrap",
      "gui/501",
      "/Users/alice/Library/LaunchAgents/cn.coforge.computer.daemon.plist",
    ],
  ]);
});

test("launchd stop accepts an absent process but preserves permission errors", async () => {
  let exitCode = 3;
  const service = new LaunchdDaemonHost({
    label: "cn.coforge.computer.daemon",
    executablePath: "/install/coforge-computer",
    socketPath: "/state/daemon.sock",
    homeDirectory: "/Users/alice",
    uid: 501,
    run: async () => exitCode,
  });
  await service.stop();
  exitCode = 13;
  await expect(service.stop()).rejects.toThrow("could not stop the CoForge Daemon");
});
