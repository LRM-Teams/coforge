import { terminalText } from "../terminal-output";
import type { ComputerStatusReport, PendingRequest } from "./types";

/** One stable JSON object with the full report, matching `--json` conventions used by
 * `setup`/`login`: a single line on stdout, nothing else. */
export function renderStatusJson(report: ComputerStatusReport): string {
  return JSON.stringify(report);
}

/** Short aligned sections, one fact per line. Every user-controlled string (server URLs,
 * workspace IDs, paths) goes through `terminalText` before being written. */
export function renderStatusHuman(report: ComputerStatusReport): string[] {
  const lines: string[] = [];
  lines.push(`CoForge Computer status (${report.platform}) - ${report.generatedAt}`);
  lines.push("");
  lines.push(...renderInstall(report));
  lines.push("");
  lines.push(...renderSupervisor(report));
  lines.push("");
  lines.push(...renderWorkspaces(report));
  lines.push("");
  lines.push(...renderAgents(report));
  lines.push("");
  lines.push(...renderLocks(report));
  lines.push("");
  lines.push(...renderLeftoverJobs(report));
  return lines;
}

function renderInstall(report: ComputerStatusReport): string[] {
  const { install } = report;
  const lines = ["Install"];
  if (!install.readable) {
    lines.push(`  Error:                 ${terminalText(install.error)}`);
    return lines;
  }
  lines.push(
    `  Active version:        ${install.active ? terminalText(install.active.current) : "none"}`,
  );
  lines.push(
    `  Previous version:      ${install.active?.previous ? terminalText(install.active.previous) : "none"}`,
  );
  lines.push(
    `  Binary on PATH:        ${install.binaryOnPath ? terminalText(install.binaryOnPath) : "not found"}`,
  );
  lines.push(`  Resolves to active:    ${yesNo(install.resolvesToActive)}`);
  lines.push(`  Release feed:          ${terminalText(install.releaseFeedUrl)}`);
  return lines;
}

function renderSupervisor(report: ComputerStatusReport): string[] {
  const { supervisor } = report;
  return [
    "Supervisor",
    `  Coordinator job:       ${terminalText(supervisor.label)}`,
    `  Loaded:                ${supervisor.loaded ? "yes" : "no"}`,
    `  PID:                   ${supervisor.pid ?? "-"}`,
    `  Socket:                ${terminalText(supervisor.socketPath)}`,
    `  Local RPC:             ${
      supervisor.rpc.reachable
        ? `reachable (${supervisor.rpc.runtimeCount} workspace runtime(s))`
        : `unreachable (${terminalText(supervisor.rpc.error)})`
    }`,
  ];
}

function renderWorkspaces(report: ComputerStatusReport): string[] {
  const { workspaces } = report;
  if (!workspaces.readable)
    return ["Workspaces", `  Error:                 ${terminalText(workspaces.error)}`];
  if (workspaces.workspaces.length === 0)
    return ["Workspaces", "  No workspace bindings configured."];
  const lines = [`Workspaces (${workspaces.workspaces.length})`];
  for (const workspace of workspaces.workspaces) {
    const pid = workspace.pid === null ? "-" : `${workspace.pid} (${workspace.pidSource})`;
    lines.push(
      `  ${terminalText(workspace.workspaceId)}  server=${workspace.serverHttpUrl ? terminalText(workspace.serverHttpUrl) : "-"}  enabled=${workspace.enabled ? "yes" : "no"}  running=${workspace.running ? "yes" : "no"}  pid=${pid}`,
    );
    for (const pending of workspace.pending) lines.push(`    pending: ${renderPending(pending)}`);
  }
  return lines;
}

function renderPending(pending: PendingRequest): string {
  return pending.kind === "restart"
    ? `restart ${terminalText(pending.requestId)} (${terminalText(pending.phase)})`
    : `upgrade ${terminalText(pending.requestId)} -> ${terminalText(pending.expectedVersion)}`;
}

function renderAgents(report: ComputerStatusReport): string[] {
  const { agents } = report;
  if (!agents.supported) return ["Agents", "  Not supported on this platform."];
  if (agents.workspaces.length === 0) return ["Agents", "  No workspace bindings configured."];
  const lines = ["Agents"];
  for (const workspace of agents.workspaces) {
    lines.push(
      `  ${terminalText(workspace.workspaceId)}: ${workspace.count} job(s)  (workspace job pid=${workspace.workspaceJobPid ?? "-"})`,
    );
    for (const job of workspace.jobs) {
      lines.push(`    ${terminalText(job.label)}  pid=${job.pid ?? "-"}`);
    }
  }
  return lines;
}

function renderLocks(report: ComputerStatusReport): string[] {
  const { locks } = report;
  return [
    "Locks",
    `  Machine mutation lock: ${locks.machineMutationLock}`,
    `  Supervisor lock:       ${
      locks.supervisorLock.present
        ? `held (owner pid ${locks.supervisorLock.ownerPid ?? "unknown"})`
        : "free"
    }`,
  ];
}

function renderLeftoverJobs(report: ComputerStatusReport): string[] {
  const { leftoverJobs } = report;
  if (!leftoverJobs.supported)
    return ["Leftover upgrade jobs", "  Not supported on this platform."];
  if (leftoverJobs.jobs.length === 0) return ["Leftover upgrade jobs", "  none"];
  return [
    "Leftover upgrade jobs",
    ...leftoverJobs.jobs.map(
      (job) =>
        `  ${terminalText(job.label)}  pid=${job.pid ?? "-"}${job.runs !== null ? `  runs=${job.runs}` : ""}`,
    ),
  ];
}

function yesNo(value: boolean | null): string {
  return value === null ? "unknown" : value ? "yes" : "no";
}
