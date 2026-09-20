import { expect, test } from "bun:test";
import { rejection } from "./rejection";
import { systemdUserUnit, SystemdUserDaemonHost } from "@lrm/coforge-daemon";

const ok = { code: 0, stdout: "", stderr: "" };
const failed = (stderr: string, code = 1) => ({ code, stdout: "", stderr });

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
      return command.includes("start") ? failed("Job for coforge-daemon.service failed.") : ok;
    },
  });
  await expect(
    service.ensureStarted({
      workspaceId: "w",
      computerId: "computer",
      workspaceRoot: "/w",
      daemonApiKey: "secret",
    }),
  ).rejects.toThrow("`systemctl --user start coforge-daemon.service` failed (1)");
  expect(commands.slice(0, 3)).toEqual([
    ["systemctl", "--user", "daemon-reload"],
    ["systemctl", "--user", "enable", "coforge-daemon.service"],
    ["systemctl", "--user", "start", "coforge-daemon.service"],
  ]);
});

test("a failed start repeats systemd's own reason and names the unit to inspect", async () => {
  const service = new SystemdUserDaemonHost({
    homeDirectory: "/home/alice",
    executablePath: "/install/coforge-computer",
    socketPath: "/missing/daemon.sock",
    run: async () =>
      failed("Job for coforge-daemon.service failed because the control process exited.", 3),
  });
  const error = await rejection(service.ensureRunning());
  expect(error.message).toContain("`systemctl --user start coforge-daemon.service` failed (3)");
  expect(error.message).toContain("the control process exited");
  expect(error.message).toContain("systemctl --user status coforge-daemon.service");
});

test("a shell with no systemd user session says so and gives the commands that open one", async () => {
  const service = new SystemdUserDaemonHost({
    homeDirectory: "/home/alice",
    executablePath: "/install/coforge-computer",
    socketPath: "/missing/daemon.sock",
    run: async () => failed("Failed to connect to bus: No medium found"),
  });
  const error = await rejection(service.ensureRunning());
  expect(error.message).toContain("Failed to connect to bus: No medium found");
  expect(error.message).toContain("no systemd user session");
  expect(error.message).toContain("su");
  expect(error.message).toContain("machinectl shell");
});

test("stopping a Daemon that has no user service installed says how to install one", async () => {
  const service = new SystemdUserDaemonHost({
    homeDirectory: "/home/alice",
    executablePath: "/install/coforge-computer",
    socketPath: "/missing/daemon.sock",
    run: async () =>
      failed("Failed to stop coforge-daemon.service: Unit coforge-daemon.service not loaded.", 5),
  });
  const error = await rejection(service.stop());
  expect(error.message).toContain("`systemctl --user stop coforge-daemon.service` failed (5)");
  expect(error.message).toContain("not loaded");
  expect(error.message).toContain("coforge-computer start");
});

test("start uses systemd rather than launching an unmanaged process", async () => {
  const commands: string[][] = [];
  const service = new SystemdUserDaemonHost({
    homeDirectory: "/home/alice",
    executablePath: "/missing/coforge-computer",
    socketPath: "/missing/daemon.sock",
    run: async (command) => {
      commands.push(command);
      return failed("Failed to connect to bus: No medium found");
    },
  });
  await expect(service.ensureRunning()).rejects.toThrow(
    "`systemctl --user start coforge-daemon.service` failed (1)",
  );
  expect(commands).toEqual([["systemctl", "--user", "start", "coforge-daemon.service"]]);
});

test("restart resets any failed-state latch before restarting the systemd user service", async () => {
  const commands: string[][] = [];
  const service = new SystemdUserDaemonHost({
    homeDirectory: "/home/alice",
    executablePath: "/install/coforge-daemon",
    socketPath: "/run/user/501/coforge/daemon.sock",
    run: async (command) => {
      commands.push(command);
      // Fails the restart step deliberately so this exercises only the command sequence and
      // error handling, not the local-handshake wait a real success would go on to do.
      return command.includes("restart") ? failed("Job for coforge-daemon.service failed.") : ok;
    },
  });
  await expect(service.restart()).rejects.toThrow(
    "`systemctl --user restart coforge-daemon.service` failed (1)",
  );
  expect(commands).toEqual([
    ["systemctl", "--user", "reset-failed", "coforge-daemon.service"],
    ["systemctl", "--user", "restart", "coforge-daemon.service"],
  ]);
});

test("restart ignores reset-failed's own exit code", async () => {
  const commands: string[][] = [];
  const service = new SystemdUserDaemonHost({
    homeDirectory: "/home/alice",
    executablePath: "/install/coforge-daemon",
    socketPath: "/run/user/501/coforge/daemon.sock",
    run: async (command) => {
      commands.push(command);
      // reset-failed's own exit code (1: nothing to reset) must not fail the restart; the
      // restart step is also failed here only to avoid a real local-handshake wait.
      return failed("Job for coforge-daemon.service failed.");
    },
  });
  await expect(service.restart()).rejects.toThrow(
    "`systemctl --user restart coforge-daemon.service` failed (1)",
  );
  expect(commands).toEqual([
    ["systemctl", "--user", "reset-failed", "coforge-daemon.service"],
    ["systemctl", "--user", "restart", "coforge-daemon.service"],
  ]);
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
      return command.includes("start") ? failed("Job failed.") : ok;
    },
  });
  await expect(service.ensureRunning()).rejects.toThrow(
    "`systemctl --user start coforge-native-test-a1b2.service` failed (1)",
  );
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
