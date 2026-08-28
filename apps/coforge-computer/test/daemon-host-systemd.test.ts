import { expect, test } from "bun:test";
import { systemdUserUnit, SystemdUserDaemonHost } from "@coforge/daemon";

test("systemd user unit starts the verified daemon and restarts it after failure", () => {
  const unit = systemdUserUnit(
    "/home/alice/.local/share/coforge/active/coforge-daemon",
    "/run/user/501/coforge/daemon.sock",
  );
  expect(unit).toContain("WantedBy=default.target");
  expect(unit).toContain("Restart=on-failure");
  expect(unit).toContain("--socket");
});

test("systemd user service is installed and started without a system service", async () => {
  const commands: string[][] = [];
  const service = new SystemdUserDaemonHost({
    homeDirectory: "/home/alice",
    executablePath: "/install/coforge-daemon",
    socketPath: "/run/user/501/coforge/daemon.sock",
    writeFile: async () => {},
    run: async (command) => {
      commands.push(command);
      return 0;
    },
  });
  await service
    .ensureStarted({
      workspaceId: "w",
      computerId: "computer",
      workspaceRoot: "/w",
      workspaceWorkerToken: "secret",
    })
    .catch(() => undefined);
  expect(commands.slice(0, 3)).toEqual([
    ["systemctl", "--user", "daemon-reload"],
    ["systemctl", "--user", "enable", "coforge-daemon.service"],
    ["systemctl", "--user", "start", "coforge-daemon.service"],
  ]);
});
