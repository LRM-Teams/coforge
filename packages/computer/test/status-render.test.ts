import { expect, test } from "bun:test";

import { renderStatusHuman, renderStatusJson } from "../src/status/render-status";
import type { ComputerStatusReport } from "../src/status/types";

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
        serverHttpUrl: "https://coforge.cn",
        enabled: true,
        running: true,
        pid: 111,
        pidSource: "daemon-snapshot",
        pending: [{ kind: "upgrade", requestId: "req-1", expectedVersion: "1.5.0" }],
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
  expect(text).toContain("pid=111 (daemon-snapshot)");
  expect(text).toContain("pending: upgrade req-1 -> 1.5.0");
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
          serverHttpUrl: "https://coforge.cn",
          enabled: true,
          running: true,
          pid: 9001,
          pidSource: "os-job",
          pending: [],
        },
      ],
    },
  });

  expect(lines.join("\n")).toContain("pid=9001 (os-job)");
});

test("renderStatusHuman never crashes on control characters embedded in untrusted strings", () => {
  const lines = renderStatusHuman({
    ...REPORT,
    workspaces: {
      readable: true,
      workspaces: [
        {
          workspaceId: "ws--evil",
          serverHttpUrl: null,
          enabled: false,
          running: false,
          pid: null,
          pidSource: null,
          pending: [],
        },
      ],
    },
  });

  expect(lines.join("\n")).not.toContain("");
});
