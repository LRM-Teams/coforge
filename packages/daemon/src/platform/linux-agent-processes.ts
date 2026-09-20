import { readFile, readdir } from "node:fs/promises";

/**
 * Reap this Workspace's detached Agent processes left behind by a previous daemon instance.
 *
 * macOS reaps its per-Agent launchd jobs on daemon boot (`stopLaunchdJobs`,
 * `platform/launchd-job.ts`). Linux has no per-Agent service: an Agent process is a
 * `Bun.spawn({ detached: true })` process group (`platform/process-tree.ts`), and the only thing
 * that kills them is the workspace systemd unit's `KillMode=mixed` — which does not apply when the
 * daemon was started any other way (a hand-run `bun run`, a `su`/SSH session without the user bus).
 * A leftover Agent process then double-runs on the same identity at the next dispatch, which
 * ADR 0033's `exitUnconfirmed` fence exists to prevent. The daemon therefore sweeps them itself on
 * boot.
 *
 * Scope is the Workspace, never another one: a process is only a candidate when its environment
 * carries this Workspace's id, which the daemon sets on every Agent process
 * (`COFORGE_CURRENT_WORKSPACE_ID`, `code-agent/environment.ts`) together with
 * `COFORGE_CURRENT_AGENT_ID`, and carries itself on neither.
 */

/** The `/proc` seam, injectable so the sweep is testable without real processes. */
export type LinuxProcessTable = {
  /** Every process id currently in the process table. */
  pids(): Promise<number[]>;
  /** A process's environment block (NUL-separated), or undefined when it is gone/unreadable. */
  environment(pid: number): Promise<string | undefined>;
  /** A process's process-group id, or undefined when it is gone/unreadable. */
  processGroup(pid: number): Promise<number | undefined>;
  /** SIGKILL an entire process group. */
  killGroup(processGroup: number): Promise<void>;
};

const WORKSPACE_MARKER = "COFORGE_CURRENT_WORKSPACE_ID=";
const AGENT_MARKER = "COFORGE_CURRENT_AGENT_ID=";

export type ReapOptions = {
  /** The daemon's own pid/process group, never swept. Defaults to this process. */
  selfPid?: number;
  selfProcessGroup?: number;
  table?: LinuxProcessTable;
};

/**
 * Kill every process group that holds an Agent process of `workspaceId`, and return how many groups
 * were killed. Best-effort and idempotent: a process that disappeared between the scan and the kill
 * is simply already gone, and an unreadable `/proc` entry is skipped rather than failing the sweep
 * (a sweep failure must never stop the daemon from starting).
 */
export async function stopWorkspaceAgentProcesses(
  workspaceId: string,
  options: ReapOptions = {},
): Promise<number> {
  if (!workspaceId.trim()) throw new Error("invalid Workspace scope");
  const table = options.table ?? procProcessTable;
  const selfPid = options.selfPid ?? process.pid;
  const selfGroup = options.selfProcessGroup ?? (await table.processGroup(selfPid));

  const groups = new Set<number>();
  for (const pid of await table.pids()) {
    if (pid === selfPid) continue;
    const environment = await table.environment(pid);
    if (!environment || !isAgentOfWorkspace(environment, workspaceId)) continue;
    const group = await table.processGroup(pid);
    if (group === undefined || group === selfGroup) continue;
    groups.add(group);
  }

  let killed = 0;
  for (const group of groups) {
    try {
      await table.killGroup(group);
      killed++;
    } catch {
      // The group exited on its own between the scan and the kill.
    }
  }
  return killed;
}

/** The environment block is NUL-separated; match whole entries, never a name prefix. */
function isAgentOfWorkspace(environment: string, workspaceId: string): boolean {
  const entries = environment.split("\0");
  return (
    entries.some((entry) => entry.startsWith(AGENT_MARKER)) &&
    entries.includes(`${WORKSPACE_MARKER}${workspaceId}`)
  );
}

const procProcessTable: LinuxProcessTable = {
  async pids() {
    const names = await readdir("/proc");
    return names.filter((name) => /^\d+$/.test(name)).map(Number);
  },
  async environment(pid) {
    try {
      return await readFile(`/proc/${pid}/environ`, "utf8");
    } catch {
      return undefined;
    }
  },
  async processGroup(pid) {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      // `stat`'s second field is the command, possibly containing spaces and parentheses, so read
      // the fields after its last `)`. There, index 2 is `pgrp` (fields 3 state, 4 ppid, 5 pgrp).
      const fields = stat
        .slice(stat.lastIndexOf(")") + 1)
        .trim()
        .split(/\s+/);
      const group = Number(fields[2]);
      return Number.isInteger(group) ? group : undefined;
    } catch {
      return undefined;
    }
  },
  async killGroup(group) {
    process.kill(-group, "SIGKILL");
  },
};
