import { expect, test } from "bun:test";

import { renderStatusHuman, renderStatusJson } from "#src/status/render-status";
import type { ComputerStatusReport } from "#src/status/types";

const REPORT: ComputerStatusReport = {
  schemaVersion: 1,
  generatedAt: "2026-01-01T00:00:00.000Z",
  platform: "darwin",
  install: {
    readable: true,
    active: { current: "1.4.2", previous: "1.4.1" },
    binaryOnPath: "/home/user/.local/bin/coforge-computer",
    resolvesToActive: true,
    releaseFeedUrl: "https://releases.coforge.cn/",
  },
  supervisor: {
    label: "cn.coforge.computer.daemon",
    loaded: true,
    pid: 4821,
    socketPath: "/home/user/.coforge/daemon/daemon.sock",
    rpc: { reachable: true, runtimeCount: 1 },
  },
  workspaces: {
    readable: true,
    workspaces: [
      {
        workspaceId: "ws-1",
        workspaceSlug: "acme",
        serverHttpUrl: "https://coforge.cn",
        enabled: true,
        running: true,
        pid: 111,
        pidSource: "daemon-snapshot",
        pending: [{ kind: "upgrade", requestId: "req-1", expectedVersion: "1.5.0" }],
        unsettledUpgrades: [
          { requestId: "req-2", expectedVersion: "1.6.0", state: "failed", ageMs: 65_000 },
        ],
        health: { status: "ok" },
        cloudConnection: { state: "connected" },
      },
    ],
  },
  agents: {
    supported: true,
    workspaces: [
      {
        workspaceId: "ws-1",
        workspaceJobPid: 333,
        jobs: [{ label: "cn.coforge.agent.abc.1", pid: 222 }],
        count: 1,
      },
    ],
  },
  locks: {
    machineMutationLock: "free",
    supervisorLock: { present: true, ownerPid: 4821 },
  },
  leftoverJobs: { supported: true, jobs: [] },
};

test("renderStatusJson emits the whole report as one stable JSON object", () => {
  const output = renderStatusJson(REPORT);

  expect(output.includes("\n")).toBe(false);
  expect(JSON.parse(output)).toEqual(REPORT);
});

test("renderStatusHuman prints short aligned sections, one fact per line", () => {
  const lines = renderStatusHuman(REPORT);
  const text = lines.join("\n");

  expect(text).toContain("Install");
  expect(text).toContain("Active version:        1.4.2");
  expect(text).toContain("Previous version:      1.4.1");
  expect(text).toContain("Resolves to active:    yes");
  expect(text).toContain("Supervisor");
  expect(text).toContain("Coordinator job:       cn.coforge.computer.daemon");
  expect(text).toContain("PID:                   4821");
  expect(text).toContain("Local RPC:             reachable (1 workspace runtime(s))");
  expect(text).toContain("Workspaces (1)");
  expect(text).toContain("ws-1");
  expect(text).toContain("pid=111 (daemon-snapshot)  cloud=connected");
  expect(text).toContain("pending: upgrade req-1 -> 1.5.0");
  expect(text).toContain("unsettled upgrade: req-2 -> 1.6.0  state=failed  age=65s");
  expect(text).toContain("Agents");
  expect(text).toContain("1 job(s)  (workspace job pid=333)");
  expect(text).toContain("cn.coforge.agent.abc.1  pid=222");
  expect(text).toContain("Locks");
  expect(text).toContain("Machine mutation lock: free");
  expect(text).toContain("Supervisor lock:       held (owner pid 4821)");
  expect(text).toContain("Leftover upgrade jobs");
  expect(text).toContain("none");
});

test("renderStatusHuman reports an unreadable install without crashing", () => {
  const lines = renderStatusHuman({
    ...REPORT,
    install: { readable: false, error: "active.json is not valid JSON" },
  });

  expect(lines.join("\n")).toContain("active.json is not valid JSON");
});

test("renderStatusHuman reports unsupported Agents and leftover-job listings plainly", () => {
  const lines = renderStatusHuman({
    ...REPORT,
    agents: { supported: false, workspaces: [] },
    leftoverJobs: { supported: false, jobs: [] },
  });
  const text = lines.join("\n");

  expect(text).toContain("Not supported on this platform.");
});

test("renderStatusHuman shows which source a Workspace's pid came from", () => {
  const lines = renderStatusHuman({
    ...REPORT,
    workspaces: {
      readable: true,
      workspaces: [
        {
          workspaceId: "ws-1",
          workspaceSlug: "acme",
          serverHttpUrl: "https://coforge.cn",
          enabled: true,
          running: true,
          pid: 9001,
          pidSource: "os-job",
          pending: [],
          unsettledUpgrades: [],
          health: { status: "ok" },
          cloudConnection: null,
        },
      ],
    },
  });

  expect(lines.join("\n")).toContain("pid=9001 (os-job)");
});

test("renderStatusHuman shows a Workspace's cloud connection and why it is not up", () => {
  if (!REPORT.workspaces.readable) throw new Error("fixture has readable workspaces");
  const workspace = REPORT.workspaces.workspaces[0]!;
  const lines = renderStatusHuman({
    ...REPORT,
    workspaces: {
      readable: true,
      workspaces: [
        {
          ...workspace,
          workspaceId: "ws-1",
          cloudConnection: {
            state: "connecting",
            error: "connect error 100: internal server error",
          },
        },
        {
          ...workspace,
          workspaceId: "ws-2",
          cloudConnection: { state: "not_connected", error: "transport closed (2)" },
        },
        { ...workspace, workspaceId: "ws-3", running: false, cloudConnection: null },
      ],
    },
  });
  const text = lines.join("\n");

  expect(text).toContain("cloud=connecting");
  expect(text).toContain("    cloud: retrying after connect error 100: internal server error");
  expect(text).toContain("cloud=not_connected");
  expect(text).toContain("    cloud: not connected (transport closed (2))");
  expect(lines.find((line) => line.includes("ws-3"))).toContain("cloud=-");
});

test("renderStatusHuman shortens a long cloud connection reason", () => {
  if (!REPORT.workspaces.readable) throw new Error("fixture has readable workspaces");
  const workspace = REPORT.workspaces.workspaces[0]!;
  const lines = renderStatusHuman({
    ...REPORT,
    workspaces: {
      readable: true,
      workspaces: [
        {
          ...workspace,
          cloudConnection: { state: "connecting", error: `connect error 100: ${"x".repeat(500)}` },
        },
      ],
    },
  });

  const reason = lines.find((line) => line.startsWith("    cloud: "))!;
  expect(reason.length).toBeLessThanOrEqual("    cloud: retrying after ".length + 200);
  expect(reason.endsWith("…")).toBe(true);
});

test("renderStatusHuman states a degraded Workspace's real reason and the recovery command", () => {
  const lines = renderStatusHuman({
    ...REPORT,
    workspaces: {
      readable: true,
      workspaces: [
        {
          workspaceId: "ws-1",
          workspaceSlug: "acme",
          serverHttpUrl: "https://coforge.cn",
          enabled: true,
          running: false,
          pid: null,
          pidSource: null,
          pending: [],
          unsettledUpgrades: [],
          health: {
            status: "degraded",
            reason: "this Workspace exited unexpectedly 3 times within 60s",
            crashCount: 3,
            since: "2026-01-01T00:00:00.000Z",
          },
          cloudConnection: null,
        },
      ],
    },
  });
  const text = lines.join("\n");

  expect(text).toContain(
    "degraded: this Workspace exited unexpectedly 3 times within 60s  crashes=3  since=2026-01-01T00:00:00.000Z",
  );
  expect(text).toContain("recover: coforge-computer restart --workspace ws-1");
});

test("renderStatusHuman states why a Workspace is parked and the setup command that attaches it again", () => {
  const lines = renderStatusHuman({
    ...REPORT,
    workspaces: {
      readable: true,
      workspaces: [
        {
          workspaceId: "ws-1",
          workspaceSlug: "acme",
          serverHttpUrl: "https://coforge.cn",
          enabled: true,
          running: false,
          pid: null,
          pidSource: null,
          pending: [],
          unsettledUpgrades: [],
          health: {
            status: "parked",
            reason: "computer_unlinked",
            since: "2026-09-29T08:00:00.000Z",
          },
          cloudConnection: null,
        },
      ],
    },
  });
  const text = lines.join("\n");

  expect(text).toContain("    parked: computer_unlinked  since=2026-09-29T08:00:00.000Z");
  expect(text).toContain(
    "      This Computer was removed from Workspace acme in CoForge (computer_unlinked). This Computer stopped connecting to it and stopped its Agents; local files are kept. Run 'coforge-computer setup --workspace acme' to attach it again.",
  );
});

test("renderStatusHuman prints nothing extra for a healthy Workspace's health", () => {
  const lines = renderStatusHuman(REPORT);

  expect(lines.join("\n")).not.toContain("degraded:");
});

test("renderStatusHuman never crashes on control characters embedded in untrusted strings", () => {
  const lines = renderStatusHuman({
    ...REPORT,
    workspaces: {
      readable: true,
      workspaces: [
        {
          workspaceId: "ws--evil",
          workspaceSlug: null,
          serverHttpUrl: null,
          enabled: false,
          running: false,
          pid: null,
          pidSource: null,
          pending: [],
          unsettledUpgrades: [],
          health: { status: "ok" },
          cloudConnection: null,
        },
      ],
    },
  });

  expect(lines.join("\n")).not.toContain("");
});

test("renderStatusHuman shows a start or restart under way and the last failed command with its retry", () => {
  const lines = renderStatusHuman({
    ...REPORT,
    workspaces: {
      readable: true,
      workspaces: [
        {
          workspaceId: "ws-1",
          workspaceSlug: "acme",
          serverHttpUrl: "https://coforge.cn",
          enabled: true,
          running: false,
          pid: null,
          pidSource: null,
          pending: [],
          unsettledUpgrades: [],
          health: { status: "ok" },
          cloudConnection: null,
          underWay: true,
          lastFailure: {
            operation: "start",
            message: "Workspace ws-1 failed process readiness",
            at: "2026-01-01T00:00:00.000Z",
          },
        },
      ],
    },
  });
  const text = lines.join("\n");

  expect(text).toContain("under way: a start, restart, or setup is still running");
  expect(text).toContain(
    "last start failed: Workspace ws-1 failed process readiness  at=2026-01-01T00:00:00.000Z",
  );
  expect(text).toContain("retry: coforge-computer start --workspace ws-1");
});

test("a configure that failed after it answered is retried with start, since the Workspace is attached", () => {
  const lines = renderStatusHuman({
    ...REPORT,
    workspaces: {
      readable: true,
      workspaces: [
        {
          workspaceId: "ws-1",
          workspaceSlug: "acme",
          serverHttpUrl: "https://coforge.cn",
          enabled: true,
          running: false,
          pid: null,
          pidSource: null,
          pending: [],
          unsettledUpgrades: [],
          health: { status: "ok" },
          cloudConnection: null,
          underWay: true,
          lastFailure: {
            operation: "configure",
            message: "Workspace ws-1 failed process readiness",
            at: "2026-01-01T00:00:00.000Z",
          },
        },
      ],
    },
  });
  const text = lines.join("\n");

  expect(text).toContain("last setup failed: Workspace ws-1 failed process readiness");
  expect(text).toContain("retry: coforge-computer start --workspace ws-1");
});
