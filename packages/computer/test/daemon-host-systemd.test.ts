import { expect, test } from "bun:test";
import { systemdUserUnit, SystemdUserDaemonHost } from "@coforge/daemon";

test("systemd user unit dispatches the daemon through the unified executable", () => {
  const unit = systemdUserUnit(
    "/home/alice/.local/share/coforge/active/coforge-computer",
    "/run/user/501/coforge/daemon.sock",
  );
  expect(unit).toContain("WantedBy=default.target");
  expect(unit).toContain("Restart=on-failure");
  expect(unit).toContain("KillMode=mixed");
  expect(unit).toContain(
    "ExecStart=/home/alice/.local/share/coforge/active/coforge-computer __daemon --socket /run/user/501/coforge/daemon.sock",
  );
});

test("systemd user service is installed and started without a system service", async () => {
  const commands: string[][] = [];
  const service = new SystemdUserDaemonHost({
    serverUrl: "https://coforge.test",
    homeDirectory: "/home/alice",
    executablePath: "/install/coforge-daemon",
    socketPath: "/run/user/501/coforge/daemon.sock",
    writeFile: async () => {},
    run: async (command) => {
      commands.push(command);
      return command.includes("start") ? 1 : 0;
    },
  });
  await expect(
    service.ensureStarted({
      workspaceId: "w",
      computerId: "computer",
      workspaceRoot: "/w",
      daemonApiKey: "secret",
    }),
  ).rejects.toThrow("Run `coforge-computer foreground` under an external supervisor");
  expect(commands.slice(0, 3)).toEqual([
    ["systemctl", "--user", "daemon-reload"],
    ["systemctl", "--user", "enable", "coforge-daemon.service"],
    ["systemctl", "--user", "start", "coforge-daemon.service"],
  ]);
});

test("start uses systemd rather than launching an unmanaged process", async () => {
  const commands: string[][] = [];
  const service = new SystemdUserDaemonHost({
    homeDirectory: "/home/alice",
    executablePath: "/missing/coforge-computer",
    socketPath: "/missing/daemon.sock",
    run: async (command) => {
      commands.push(command);
      return 1;
    },
  });
  await expect(service.ensureRunning()).rejects.toThrow(
    "Run `coforge-computer foreground` under an external supervisor",
  );
  expect(commands).toEqual([["systemctl", "--user", "start", "coforge-daemon.service"]]);
});

test("a validated injected service name isolates native lifecycle integration", async () => {
  const commands: string[][] = [];
  let writtenPath = "";
  const service = new SystemdUserDaemonHost({
    homeDirectory: "/tmp/coforge-native-test",
    executablePath: "/install/coforge-computer",
    socketPath: "/tmp/coforge-native-test/daemon.sock",
    serviceName: "coforge-native-test-a1b2.service",
    writeFile: async (path) => {
      writtenPath = path;
    },
    run: async (command) => {
      commands.push(command);
      return command.includes("start") ? 1 : 0;
    },
  });
  await expect(service.ensureRunning()).rejects.toThrow();
  expect(commands).toEqual([["systemctl", "--user", "start", "coforge-native-test-a1b2.service"]]);
  expect(writtenPath).toBe("");
});

test("systemd host rejects unsafe injected service names", () => {
  expect(
    () =>
      new SystemdUserDaemonHost({
        homeDirectory: "/tmp/test",
        executablePath: "/install/coforge-computer",
        socketPath: "/tmp/test/daemon.sock",
        serviceName: "../coforge-daemon.service",
      }),
  ).toThrow("invalid systemd user service name");
});
