import { launchdJobs, workspaceLaunchdIdentity } from "@lrm/coforge-daemon";
import type { AgentJob, LeftoverJob, StatusBinding, WorkspaceAgents } from "./types";

export async function probeDarwinCoordinator(label: string): Promise<{
  loaded: boolean;
  pid: number | null;
}> {
  const jobs = await launchdJobs();
  if (!jobs.has(label)) return { loaded: false, pid: null };
  const pid = jobs.get(label)!;
  return { loaded: true, pid: pid > 0 ? pid : null };
}

/** For each binding, reads the Workspace's own OS-containment job (`cn.coforge.workspace.
 * <identity>`) and every Agent job under it (`cn.coforge.agent.<identity>.*`) from one
 * `launchctl list` call. The identity comes from the daemon's own `workspaceLaunchdIdentity`
 * (imported, never recomputed independently), so this always agrees with the labels the running
 * system actually created - even if that derivation ever changes. */
export async function listDarwinWorkspaceAgents(
  stateDirectory: string,
  bindings: StatusBinding[],
): Promise<WorkspaceAgents[]> {
  const jobs = await launchdJobs();
  return bindings.map((binding) => {
    const identity = workspaceLaunchdIdentity(stateDirectory, binding.workspaceId);
    const workspaceJobPid = pidOrNull(jobs.get(`cn.coforge.workspace.${identity}`));
    const agentPrefix = `cn.coforge.agent.${identity}.`;
    const agentJobs: AgentJob[] = [];
    for (const [label, pid] of jobs) {
      if (label.startsWith(agentPrefix)) agentJobs.push({ label, pid: pidOrNull(pid) });
    }
    return {
      workspaceId: binding.workspaceId,
      workspaceJobPid,
      jobs: agentJobs,
      count: agentJobs.length,
    };
  });
}

function pidOrNull(pid: number | undefined): number | null {
  return pid !== undefined && pid > 0 ? pid : null;
}

/** Any `cn.coforge.upgrade.*` job still loaded is a one-shot remote upgrade coordinator
 * (`launchctl submit -l cn.coforge.upgrade.<requestId>`, see
 * packages/daemon/src/platform/computer-upgrade-launcher.ts) that never got removed - typically
 * because it crashed or is still holding the machine mutation lock. `launchctl list` already
 * gives every label and PID in one call; `launchctl print` is queried per leftover label only,
 * and only to report a run count, never to change anything. */
export async function listDarwinLeftoverUpgradeJobs(): Promise<LeftoverJob[]> {
  const jobs = await launchdJobs();
  const leftovers: LeftoverJob[] = [];
  for (const [label, pid] of jobs) {
    if (!label.startsWith("cn.coforge.upgrade.")) continue;
    leftovers.push({ label, pid: pid > 0 ? pid : null, runs: await probeRunCount(label) });
  }
  return leftovers;
}

async function probeRunCount(label: string): Promise<number | null> {
  try {
    const uid = process.getuid?.();
    if (uid === undefined) return null;
    const child = Bun.spawn(["/bin/launchctl", "print", `gui/${uid}/${label}`], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      timeout: 5_000,
    });
    const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    if (code !== 0) return null;
    const match = /^\s*runs = (\d+)/m.exec(stdout);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}
