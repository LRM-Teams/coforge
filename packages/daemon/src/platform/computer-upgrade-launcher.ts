import { homedir } from "node:os";
import { join } from "node:path";
import { LaunchdJob, type LaunchdJobPlatform } from "./launchd-job";

const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function computerUpgradeCommand(
  platform: NodeJS.Platform,
  executablePath: string,
  requestId: string,
  expectedVersion: string,
): string[] {
  if (!REQUEST_ID.test(requestId)) throw new Error("invalid Computer upgrade request ID");
  if (!expectedVersion) throw new Error("missing expected Computer release version");
  const action = [
    executablePath,
    "__remote-upgrade",
    "--request-id",
    requestId,
    "--version",
    expectedVersion,
  ];
  if (platform === "linux")
    return [
      "systemd-run",
      "--user",
      "--collect",
      `--unit=coforge-upgrade-${requestId}.service`,
      "--property=Type=exec",
      ...action,
    ];
  // Darwin runs this action directly, inside the one-shot launchd job built by
  // launchComputerUpgrade below. `launchctl submit` must never be used here: launchd keeps a
  // submitted job alive indefinitely and there is no submit(1) flag to disable KeepAlive, so the
  // job respawns forever after the upgrade finishes, repeatedly retaking the install lock.
  if (platform === "darwin") return action;
  throw new Error("remote Computer upgrade has no safe external coordinator on this platform");
}

export function computerUpgradeJobLabel(requestId: string): string {
  if (!REQUEST_ID.test(requestId)) throw new Error("invalid Computer upgrade request ID");
  return `cn.coforge.upgrade.${requestId}`;
}

export type ComputerUpgradeJobPaths = {
  label: string;
  directory: string;
  logPath: string;
};

export type ComputerUpgradeJobPathOptions = {
  /** The daemon's own state directory; the job's plist is written under `<stateDirectory>/upgrade-jobs`. */
  stateDirectory?: string;
  homeDirectory?: string;
};

/**
 * Where the darwin upgrade job's plist and its stdout/stderr log live. Kept pure and exported so
 * tests can assert on the paths without touching launchd or the filesystem.
 */
export function computerUpgradeJobPaths(
  requestId: string,
  options: ComputerUpgradeJobPathOptions = {},
): ComputerUpgradeJobPaths {
  const home = options.homeDirectory ?? homedir();
  const stateDirectory = options.stateDirectory ?? join(home, ".coforge", "daemon");
  return {
    label: computerUpgradeJobLabel(requestId),
    directory: join(stateDirectory, "upgrade-jobs"),
    logPath: join(home, ".coforge", "computer", "logs", "computer", `upgrade-${requestId}.log`),
  };
}

export type LaunchComputerUpgradeOptions = ComputerUpgradeJobPathOptions & {
  /** Injectable native launchd access, for tests only. */
  jobPlatform?: LaunchdJobPlatform;
};

export async function launchComputerUpgrade(
  requestId: string,
  expectedVersion: string,
  options: LaunchComputerUpgradeOptions = {},
): Promise<void> {
  const command = computerUpgradeCommand(
    process.platform,
    process.execPath,
    requestId,
    expectedVersion,
  );
  if (process.platform === "darwin") {
    const paths = computerUpgradeJobPaths(requestId, options);
    // RunAtLoad with no KeepAlive: launchd runs the job once when bootstrapped and never
    // restarts it, whatever its exit status. That is the one-shot equivalent of the Linux
    // `systemd-run --property=Type=exec` path above.
    await new LaunchdJob({
      label: paths.label,
      directory: paths.directory,
      command,
      logPath: paths.logPath,
      platform: options.jobPlatform,
    }).ensureStarted();
    return;
  }
  const child = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  if ((await child.exited) !== 0)
    throw new Error("external Computer upgrade coordinator was rejected");
}

/**
 * Best-effort self-cleanup for the `__remote-upgrade` entry point, called once its upgrade result
 * file has been written. The job's plist already has no KeepAlive, so leaving this job in place
 * cannot make it respawn; this only removes the now-idle `launchctl list` entry and its plist so a
 * later retry does not collide with a stale label. `launchctl bootout` targeting your own
 * still-running job is unreliable on some macOS versions, so callers must tolerate this throwing
 * and rely on the Coordinator startup sweep (see computer-upgrade-sweep.ts) as the backstop.
 */
export async function cleanupComputerUpgradeJob(
  requestId: string,
  options: LaunchComputerUpgradeOptions = {},
): Promise<void> {
  if (process.platform !== "darwin") return;
  const paths = computerUpgradeJobPaths(requestId, options);
  await new LaunchdJob({
    label: paths.label,
    directory: paths.directory,
    command: [],
    platform: options.jobPlatform,
  }).stop();
}
