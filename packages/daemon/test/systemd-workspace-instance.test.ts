import { expect, test } from "bun:test";
import {
  SystemdWorkspaceInstance,
  workspaceUnit,
  type WorkspaceInstanceConfig,
} from "../src/supervisor/systemd-workspace-instance";

const config: WorkspaceInstanceConfig = {
  stateRoot: "/tmp/coforge-state",
  workspaceId: "workspace-a",
  executablePath: "/opt/coforge-computer",
  socketPath: "/tmp/coforge-state/a/daemon.sock",
  stateDirectory: "/tmp/coforge-state/a",
  unitDirectory: "/tmp/user-systemd",
};

test("Workspace unit explicitly carries only scoped non-secret connection environment", () => {
  const unit = workspaceUnit({
    ...config,
    supervisorSocketPath: "/tmp/coordinator.sock",
    daemonConnectionEndpoint: "ws://127.0.0.1:8000/connection/websocket",
  });
  expect(unit).toContain('Environment="COFORGE_SUPERVISOR_SOCKET=/tmp/coordinator.sock"');
  expect(unit).toContain('Environment="COFORGE_DAEMON_HOME=/tmp/coforge-state/a"');
  expect(unit).toContain(
    'Environment="COFORGE_DAEMON_CONNECTION_ENDPOINT=ws://127.0.0.1:8000/connection/websocket"',
  );
  expect(unit).not.toContain("API_KEY");
  expect(() => workspaceUnit({ ...config, supervisorSocketPath: "/tmp/a\nExecStart=bad" })).toThrow(
    "invalid systemd unit value",
  );
});

test("unit identity is stable for the state root and Workspace, and differs across Workspaces", () => {
  const commands: string[][] = [];
  const a = new SystemdWorkspaceInstance(config, async (args) => {
    commands.push(args);
    return 0;
  });
  const b = new SystemdWorkspaceInstance({ ...config, workspaceId: "workspace-b" }, async () => 0);
  const same = new SystemdWorkspaceInstance(config, async () => 0);
  expect(a.unitName).toBe(same.unitName);
  expect(a.unitName).not.toBe(b.unitName);
  expect(a.unitName).toMatch(/^coforge-workspace-[0-9a-f]{24}\.service$/);
  expect(commands).toEqual([]);
});

test("unit puts the Workspace child in a mixed-kill user-manager scope", () => {
  const unit = workspaceUnit(config);
  expect(unit).toContain("KillMode=mixed");
  expect(unit).toContain("Restart=on-failure");
  expect(unit).toContain("SendSIGKILL=yes");
  expect(unit).toContain("__workspace-daemon");
  expect(unit).toContain(config.workspaceId);
});

test("ensureStarted adopts an active unit without issuing start", async () => {
  const commands: string[][] = [];
  const instance = new SystemdWorkspaceInstance(
    config,
    async (args) => {
      commands.push(args);
      return 0;
    },
    async () => {},
    async (args) => {
      expect(args[0]).toBe("show");
      expect(args).not.toContain("--value");
      return {
        code: 0,
        stdout: `MainPID=4242\nActiveState=active\nLoadState=loaded\nInvocationID=${"a".repeat(32)}\n`,
      };
    },
  );
  const pid = await instance.ensureStarted();
  expect(pid).toBe(4242);
  expect(commands).toEqual([["daemon-reload"]]);
});

test("a failed manager query cannot acknowledge a Workspace stop", async () => {
  const commands: string[][] = [];
  const instance = new SystemdWorkspaceInstance(
    { ...config, unitDirectory: `/tmp/coforge-query-failure-${crypto.randomUUID()}` },
    async (args) => {
      commands.push(args);
      return 0;
    },
    async () => {},
    async () => ({ code: 1, stdout: "" }),
  );
  // The manager can recover before daemon-reload; that does not prove the unit stopped.
  await expect(instance.stop()).rejects.toThrow();
  expect(commands).toEqual([]);
});

test("OS invocation identity distinguishes PID reuse before application readiness", async () => {
  let invocationId = "a".repeat(32);
  const instance = new SystemdWorkspaceInstance(
    config,
    async () => 0,
    async () => {},
    async () => ({
      code: 0,
      stdout: `LoadState=loaded\nActiveState=active\nMainPID=4242\nInvocationID=${invocationId}\n`,
    }),
  );
  expect(await instance.identity()).toMatchObject({ mainPid: 4242, invocationId });
  invocationId = "b".repeat(32);
  expect(await instance.identity()).toMatchObject({ mainPid: 4242, invocationId });
});

test("explicit not-found is absence even when systemctl exits nonzero", async () => {
  const instance = new SystemdWorkspaceInstance(
    config,
    async () => 0,
    async () => {},
    async () => ({ code: 4, stdout: "LoadState=not-found\n" }),
  );
  expect(await instance.identity()).toBeNull();
});

test.each([
  { code: 0, stdout: "" },
  { code: 0, stdout: "LoadState=loaded\nActiveState=active\nMainPID=invalid\n" },
  { code: 0, stdout: "LoadState=loaded\nMainPID=42\n" },
  { code: 1, stdout: "LoadState=loaded\nActiveState=active\nMainPID=42\n" },
])("invalid manager observation cannot acknowledge stop: %j", async (result) => {
  const commands: string[][] = [];
  const instance = new SystemdWorkspaceInstance(
    { ...config, unitDirectory: `/tmp/coforge-query-failure-${crypto.randomUUID()}` },
    async (args) => {
      commands.push(args);
      return 0;
    },
    async () => {},
    async () => result,
  );
  await expect(instance.stop()).rejects.toThrow();
  expect(commands).toEqual([]);
});
