import { describe, expect, test } from "bun:test";
import {
  stopWorkspaceAgentProcesses,
  type LinuxProcessTable,
} from "#src/platform/linux-agent-processes";

const environment = (entries: Record<string, string>) =>
  Object.entries(entries)
    .map(([name, value]) => `${name}=${value}`)
    .join("\0");

function tableFor(processes: Record<number, { environment?: string; group?: number }>): {
  table: LinuxProcessTable;
  killed: number[];
} {
  const killed: number[] = [];
  const table: LinuxProcessTable = {
    pids: async () => Object.keys(processes).map(Number),
    environment: async (pid) => processes[pid]?.environment,
    processGroup: async (pid) => processes[pid]?.group,
    killGroup: async (group) => {
      killed.push(group);
    },
  };
  return { table, killed };
}

const agentEnv = (workspaceId: string, agentId: string) =>
  environment({
    COFORGE_CURRENT_WORKSPACE_ID: workspaceId,
    COFORGE_CURRENT_AGENT_ID: agentId,
    PATH: "/usr/bin",
  });

describe("stopWorkspaceAgentProcesses", () => {
  test("kills each group holding an Agent of this Workspace, once", async () => {
    const { table, killed } = tableFor({
      10: { environment: agentEnv("workspace-1", "agent-a"), group: 10 },
      11: { environment: agentEnv("workspace-1", "agent-b"), group: 10 },
      12: { environment: agentEnv("workspace-1", "agent-c"), group: 12 },
    });

    expect(await stopWorkspaceAgentProcesses("workspace-1", { table, selfPid: 99 })).toBe(2);
    expect(killed.sort((left, right) => left - right)).toEqual([10, 12]);
  });

  test("never touches another Workspace's Agent", async () => {
    const { table, killed } = tableFor({
      10: { environment: agentEnv("workspace-2", "agent-a"), group: 10 },
    });

    expect(await stopWorkspaceAgentProcesses("workspace-1", { table, selfPid: 99 })).toBe(0);
    expect(killed).toEqual([]);
  });

  test("ignores a process that shares the Workspace id but is not an Agent", async () => {
    // The daemon and its shell carry the Workspace id, but never an Agent id.
    const { table, killed } = tableFor({
      10: { environment: environment({ COFORGE_CURRENT_WORKSPACE_ID: "workspace-1" }), group: 10 },
      11: { environment: environment({ PATH: "/usr/bin" }), group: 11 },
    });

    expect(await stopWorkspaceAgentProcesses("workspace-1", { table, selfPid: 99 })).toBe(0);
    expect(killed).toEqual([]);
  });

  test("never kills the daemon's own process or process group", async () => {
    const { table, killed } = tableFor({
      99: { environment: agentEnv("workspace-1", "self"), group: 42 },
      10: { environment: agentEnv("workspace-1", "agent-a"), group: 42 },
    });

    // pid 99 is `selfPid`, and group 42 is the daemon's own group.
    expect(
      await stopWorkspaceAgentProcesses("workspace-1", {
        table,
        selfPid: 99,
        selfProcessGroup: 42,
      }),
    ).toBe(0);
    expect(killed).toEqual([]);
  });

  test("skips a process that disappeared between the scan and the read", async () => {
    const { table, killed } = tableFor({
      10: { environment: agentEnv("workspace-1", "agent-a"), group: undefined },
      11: {},
      12: { environment: agentEnv("workspace-1", "agent-c"), group: 12 },
    });

    expect(await stopWorkspaceAgentProcesses("workspace-1", { table, selfPid: 99 })).toBe(1);
    expect(killed).toEqual([12]);
  });

  test("does not fail when the group is already gone at kill time", async () => {
    const killed: number[] = [];
    const table: LinuxProcessTable = {
      pids: async () => [10],
      environment: async () => agentEnv("workspace-1", "agent-a"),
      processGroup: async (pid) => (pid === 99 ? 99 : 10),
      killGroup: async (group) => {
        killed.push(group);
        throw new Error("ESRCH");
      },
    };

    expect(await stopWorkspaceAgentProcesses("workspace-1", { table, selfPid: 99 })).toBe(0);
    expect(killed).toEqual([10]);
  });

  test("rejects an empty Workspace scope", async () => {
    const { table } = tableFor({});
    await expect(stopWorkspaceAgentProcesses("   ", { table, selfPid: 99 })).rejects.toThrow(
      "invalid Workspace scope",
    );
  });
});
