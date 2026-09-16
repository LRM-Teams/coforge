import { launchdJobs } from "@lrm/coforge-daemon";
import type { AgentJob, LeftoverJob, StatusBinding, WorkspaceAgents } from "./types";

/** Mirrors `LaunchdWorkspaceInstance`'s identity derivation in
 * packages/daemon/src/supervisor/launchd-workspace-instance.ts (`sha256(stateRoot + "\0" +
 * workspaceId).slice(0, 24)`). Duplicated here, rather than imported, so this read-only status
 * feature never depends on that OS-containment module's internals while it may still change. If
 * the two ever drift, Agent jobs simply fall back to the "unknown" bucket below - never a crash. */
function workspaceLaunchdIdentity(stateRoot: string, workspaceId: string): string {
  return new Bun.CryptoHasher("sha256")
    .update(`${stateRoot}\0${workspaceId}`)
    .digest("hex")
    .slice(0, 24);
}

export async function probeDarwinCoordinator(label: string): Promise<{
  loaded: boolean;
  pid: number | null;
}> {
  const jobs = await launchdJobs();
  if (!jobs.has(label)) return { loaded: false, pid: null };
  const pid = jobs.get(label)!;
  return { loaded: true, pid: pid > 0 ? pid : null };
}

/** Groups every loaded `cn.coforge.agent.*` job by the Workspace whose identity hash it carries.
 * A single `launchctl list` call backs the whole machine, so this stays cheap regardless of how
 * many Workspaces or Agents are running. */
export async function listDarwinWorkspaceAgents(
  stateDirectory: string,
  bindings: StatusBinding[],
): Promise<WorkspaceAgents[]> {
  const jobs = await launchdJobs();
  const byIdentity = new Map<string, AgentJob[]>();
  for (const [label, pid] of jobs) {
    const match = /^cn\.coforge\.agent\.([a-f0-9]{24})\./.exec(label);
    if (!match) continue;
    const identity = match[1]!;
    const list = byIdentity.get(identity) ?? [];
    list.push({ label, pid: pid > 0 ? pid : null });
    byIdentity.set(identity, list);
  }
  return bindings.map((binding) => {
    const identity = workspaceLaunchdIdentity(stateDirectory, binding.workspaceId);
    const jobs = byIdentity.get(identity) ?? [];
    return { workspaceId: binding.workspaceId, jobs, count: jobs.length };
  });
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
