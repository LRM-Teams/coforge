import { expect, test } from "bun:test";

import { collectComputerStatus } from "../src/status/collect-status";
import type { StatusBinding, StatusPorts, WorkspaceAgents } from "../src/status/types";

const NOW = new Date("2026-01-01T00:00:00.000Z");

function healthyBinding(overrides: Partial<StatusBinding> = {}): StatusBinding {
  return { workspaceId: "ws-1", serverHttpUrl: "https://coforge.cn", enabled: true, ...overrides };
}

function fakePorts(overrides: Partial<StatusPorts> = {}): StatusPorts {
  return {
    now: () => NOW,
    platform: "darwin",
    releaseFeedUrl: "https://releases.coforge.cn/",
    socketPath: "/home/user/.coforge/daemon/daemon.sock",
    activeBinaryPath: "/home/user/.coforge/computer/install/active/coforge-computer",
    coordinatorLabel: "cn.coforge.computer.daemon",
    readActiveInstall: async () => ({ kind: "present", current: "1.4.2", previous: "1.4.1" }),
    locateBinaryOnPath: async () => "/home/user/.local/bin/coforge-computer",
    // Both the PATH shim and the active symlink resolve to the same real file: a healthy install.
    resolveRealPath: async () =>
      "/home/user/.coforge/computer/install/versions/1.4.2/coforge-computer",
    probeCoordinator: async () => ({ loaded: true, pid: 4821 }),
    probeDaemonSnapshot: async () => ({
      reachable: true,
      runtimes: [{ workspaceId: "ws-1", processId: 111 }],
    }),
    loadBindings: async () => ({ ok: true, bindings: [healthyBinding()] }),
    listWorkspaceAgents: {
      supported: true,
      list: async (bindings): Promise<WorkspaceAgents[]> =>
        bindings.map((binding) => ({
          workspaceId: binding.workspaceId,
          workspaceJobPid: null,
          jobs: [],
          count: 0,
        })),
    },
    probeMachineMutationLock: () => "free",
    readSupervisorLockOwner: async () => 4821,
    listLeftoverUpgradeJobs: { supported: true, list: async () => [] },
    readWorkspaceHealth: async () => ({ status: "ok" }),
    ...overrides,
  };
}

test("healthy machine reports every section as readable and reachable", async () => {
  const report = await collectComputerStatus(fakePorts());

  expect(report.schemaVersion).toBe(1);
  expect(report.generatedAt).toBe(NOW.toISOString());
  expect(report.install).toEqual({
    readable: true,
    active: { current: "1.4.2", previous: "1.4.1" },
    binaryOnPath: "/home/user/.local/bin/coforge-computer",
    resolvesToActive: true,
    releaseFeedUrl: "https://releases.coforge.cn/",
  });
  expect(report.supervisor).toEqual({
    label: "cn.coforge.computer.daemon",
    loaded: true,
    pid: 4821,
    socketPath: "/home/user/.coforge/daemon/daemon.sock",
    rpc: { reachable: true, runtimeCount: 1 },
  });
  expect(report.workspaces).toEqual({
    readable: true,
    workspaces: [
      {
        workspaceId: "ws-1",
        serverHttpUrl: "https://coforge.cn",
        enabled: true,
        running: true,
        pid: 111,
        pidSource: "daemon-snapshot",
        pending: [],
        unsettledUpgrades: [],
        health: { status: "ok" },
      },
    ],
  });
  expect(report.agents).toEqual({
    supported: true,
    workspaces: [{ workspaceId: "ws-1", workspaceJobPid: null, jobs: [], count: 0 }],
  });
  expect(report.locks).toEqual({
    machineMutationLock: "free",
    supervisorLock: { present: true, ownerPid: 4821 },
  });
  expect(report.leftoverJobs).toEqual({ supported: true, jobs: [] });
});

test("a corrupt install still produces a report, marked unreadable", async () => {
  const report = await collectComputerStatus(
    fakePorts({ readActiveInstall: async () => ({ kind: "corrupt", error: "bad json" }) }),
  );

  expect(report.install).toEqual({ readable: false, error: "bad json" });
});

test("an absent install is readable but has no active version", async () => {
  const report = await collectComputerStatus(
    fakePorts({
      readActiveInstall: async () => ({ kind: "absent" }),
      locateBinaryOnPath: async () => null,
    }),
  );

  expect(report.install).toEqual({
    readable: true,
    active: null,
    binaryOnPath: null,
    resolvesToActive: null,
    releaseFeedUrl: "https://releases.coforge.cn/",
  });
});

test("Coordinator missing: not loaded, no PID, RPC unreachable", async () => {
  const report = await collectComputerStatus(
    fakePorts({
      probeCoordinator: async () => ({ loaded: false, pid: null }),
      probeDaemonSnapshot: async () => ({ reachable: false, error: "connect ENOENT daemon.sock" }),
    }),
  );

  expect(report.supervisor).toEqual({
    label: "cn.coforge.computer.daemon",
    loaded: false,
    pid: null,
    socketPath: "/home/user/.coforge/daemon/daemon.sock",
    rpc: { reachable: false, error: "connect ENOENT daemon.sock" },
  });
  // The Coordinator being down does not fail the report; other sections still read normally.
  expect(report.install.readable).toBe(true);
  // No live runtime snapshot and no OS-job fallback means the binding reports not running.
  expect(report.workspaces).toEqual({
    readable: true,
    workspaces: [
      {
        workspaceId: "ws-1",
        serverHttpUrl: "https://coforge.cn",
        enabled: true,
        running: false,
        pid: null,
        pidSource: null,
        pending: [],
        unsettledUpgrades: [],
        health: { status: "ok" },
      },
    ],
  });
});

test("a Workspace pid falls back to its OS job when the snapshot lost track of it, and says so", async () => {
  const report = await collectComputerStatus(
    fakePorts({
      // The Coordinator's snapshot reports processId 0 - a stale cached OS-instance identity -
      // even though the Workspace's own launchd job is genuinely running.
      probeDaemonSnapshot: async () => ({
        reachable: true,
        runtimes: [{ workspaceId: "ws-1", processId: 0 }],
      }),
      listWorkspaceAgents: {
        supported: true,
        list: async (bindings) =>
          bindings.map((binding) => ({
            workspaceId: binding.workspaceId,
            workspaceJobPid: 9001,
            jobs: [],
            count: 0,
          })),
      },
    }),
  );

  expect(report.workspaces).toMatchObject({
    readable: true,
    workspaces: [{ workspaceId: "ws-1", running: true, pid: 9001, pidSource: "os-job" }],
  });
});

test("a Workspace pid prefers the daemon snapshot over the OS job when both are known", async () => {
  const report = await collectComputerStatus(
    fakePorts({
      probeDaemonSnapshot: async () => ({
        reachable: true,
        runtimes: [{ workspaceId: "ws-1", processId: 111 }],
      }),
      listWorkspaceAgents: {
        supported: true,
        list: async (bindings) =>
          bindings.map((binding) => ({
            workspaceId: binding.workspaceId,
            workspaceJobPid: 9001,
            jobs: [],
            count: 0,
          })),
      },
    }),
  );

  expect(report.workspaces).toMatchObject({
    workspaces: [{ pid: 111, pidSource: "daemon-snapshot" }],
  });
});

test("a stale remote-upgrade job is listed with its PID and run count", async () => {
  const report = await collectComputerStatus(
    fakePorts({
      listLeftoverUpgradeJobs: {
        supported: true,
        list: async () => [
          { label: "cn.coforge.upgrade.5c6b1e0a-1111-4a2b-8c3d-abcdef123456", pid: null, runs: 3 },
        ],
      },
    }),
  );

  expect(report.leftoverJobs).toEqual({
    supported: true,
    jobs: [
      { label: "cn.coforge.upgrade.5c6b1e0a-1111-4a2b-8c3d-abcdef123456", pid: null, runs: 3 },
    ],
  });
});

test("the machine mutation lock reports held without failing the report", async () => {
  const report = await collectComputerStatus(fakePorts({ probeMachineMutationLock: () => "held" }));

  expect(report.locks.machineMutationLock).toBe("held");
});

test("the Supervisor lock with no owner file reports free", async () => {
  const report = await collectComputerStatus(
    fakePorts({ readSupervisorLockOwner: async () => null }),
  );

  expect(report.locks.supervisorLock).toEqual({ present: false, ownerPid: null });
});

test("bindings missing or corrupt degrades Workspaces and empties Agents, not the whole report", async () => {
  const report = await collectComputerStatus(
    fakePorts({ loadBindings: async () => ({ ok: false, error: "invalid binding registry" }) }),
  );

  expect(report.workspaces).toEqual({ readable: false, error: "invalid binding registry" });
  // The platform still supports listing Agent jobs; there are simply no bindings to list them for.
  expect(report.agents).toEqual({ supported: true, workspaces: [] });
  expect(report.install.readable).toBe(true);
});

test("Agents section reports unsupported (not just empty) when the platform has no listing helper", async () => {
  const report = await collectComputerStatus(
    fakePorts({
      listWorkspaceAgents: { supported: false, list: async () => [] },
      loadBindings: async () => ({ ok: false, error: "invalid binding registry" }),
    }),
  );

  expect(report.agents).toEqual({ supported: false, workspaces: [] });
});

test("pending restart and upgrade requests are surfaced without further interpretation", async () => {
  const report = await collectComputerStatus(
    fakePorts({
      loadBindings: async () => ({
        ok: true,
        bindings: [
          healthyBinding({
            restart: { requestId: "restart-1", phase: "starting" },
            upgradeRequests: [{ requestId: "upgrade-1", expectedVersion: "1.5.0" }],
          }),
        ],
      }),
    }),
  );

  expect(report.workspaces).toMatchObject({
    readable: true,
    workspaces: [
      {
        pending: [
          { kind: "restart", requestId: "restart-1", phase: "starting" },
          { kind: "upgrade", requestId: "upgrade-1", expectedVersion: "1.5.0" },
        ],
      },
    ],
  });
});

test("unsettled Computer upgrade operations are surfaced with their age, and acknowledged ones are not", async () => {
  const report = await collectComputerStatus(
    fakePorts({
      loadBindings: async () => ({
        ok: true,
        bindings: [
          healthyBinding({
            upgradeOperations: [
              {
                requestId: "old",
                expectedVersion: "1.3.0",
                state: "acknowledged",
                requestedAt: NOW.getTime() - 60_000,
              },
              {
                requestId: "req-1",
                expectedVersion: "1.5.0",
                state: "pending",
                requestedAt: NOW.getTime() - 5_000,
              },
              {
                requestId: "req-0",
                expectedVersion: "1.4.0",
                state: "failed",
                requestedAt: NOW.getTime() - 10_000,
              },
            ],
          }),
        ],
      }),
    }),
  );

  expect(report.workspaces).toMatchObject({
    readable: true,
    workspaces: [
      {
        unsettledUpgrades: [
          { requestId: "req-1", expectedVersion: "1.5.0", state: "pending", ageMs: 5_000 },
          { requestId: "req-0", expectedVersion: "1.4.0", state: "failed", ageMs: 10_000 },
        ],
      },
    ],
  });
});

test("Agents section reports unsupported on a platform without a listing helper", async () => {
  const report = await collectComputerStatus(
    fakePorts({ listWorkspaceAgents: { supported: false, list: async () => [] } }),
  );

  expect(report.agents).toEqual({ supported: false, workspaces: [] });
});

test("a degraded Workspace's health is surfaced with its reason, crash count, and since", async () => {
  const report = await collectComputerStatus(
    fakePorts({
      readWorkspaceHealth: async (workspaceId) => {
        expect(workspaceId).toBe("ws-1");
        return {
          status: "degraded",
          reason: "this Workspace exited unexpectedly 3 times within 60s",
          crashCount: 3,
          since: "2026-01-01T00:00:00.000Z",
        };
      },
    }),
  );

  expect(report.workspaces).toMatchObject({
    readable: true,
    workspaces: [
      {
        health: {
          status: "degraded",
          reason: "this Workspace exited unexpectedly 3 times within 60s",
          crashCount: 3,
          since: "2026-01-01T00:00:00.000Z",
        },
      },
    ],
  });
});
