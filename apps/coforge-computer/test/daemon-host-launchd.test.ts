import { expect, test } from "bun:test";
import { LaunchdDaemonHost, launchdPlist } from "@coforge/daemon";

test("launchd service uses a per-user agent and the verified daemon payload", () => {
  const plist = launchdPlist({
    label: "cn.coforge.computer.daemon",
    executablePath:
      "/Users/alice/Library/Application Support/Coforge/Computer/active/coforge-daemon",
    socketPath: "/Users/alice/Library/Application Support/Coforge/daemon.sock",
  });

  expect(plist).toContain("<key>RunAtLoad</key>");
  expect(plist).toContain("<key>KeepAlive</key>");
  expect(plist).toContain("coforge-daemon");
  expect(plist).toContain("--socket");
  expect(plist).not.toContain("alice-secret");
});

test("launchd installation is idempotent and only bootstraps the user agent", async () => {
  const commands: string[][] = [];
  let installed = false;
  const service = new LaunchdDaemonHost({
    label: "cn.coforge.computer.daemon",
    executablePath: "/install/coforge-daemon",
    socketPath: "/state/daemon.sock",
    homeDirectory: "/Users/alice",
    uid: 501,
    writeFile: async () => {},
    run: async (command) => {
      commands.push(command);
      if (command[1] === "print") return installed ? 0 : 1;
      if (command[1] === "bootstrap") installed = true;
      return 0;
    },
  });

  await service.ensureInstalled();
  await service.ensureInstalled();
  expect(commands).toEqual([
    ["launchctl", "print", "gui/501/cn.coforge.computer.daemon"],
    [
      "launchctl",
      "bootstrap",
      "gui/501",
      "/Users/alice/Library/LaunchAgents/cn.coforge.computer.daemon.plist",
    ],
    ["launchctl", "print", "gui/501/cn.coforge.computer.daemon"],
    ["launchctl", "kickstart", "-k", "gui/501/cn.coforge.computer.daemon"],
  ]);
});
