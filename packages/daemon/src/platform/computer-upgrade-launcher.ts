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
  // Darwin and Windows run this action inside an OS one-shot outside the Coordinator kill
  // scope (launchd job / schtasks). `launchctl submit` must never be used on darwin: launchd
  // keeps a submitted job alive indefinitely and there is no submit(1) flag to disable
  // KeepAlive, so the job respawns forever after the upgrade finishes.
  if (platform === "darwin" || platform === "win32") return action;
  throw new Error("remote Computer upgrade has no safe external coordinator on this platform");
}

export function computerUpgradeJobLabel(requestId: string): string {
  if (!REQUEST_ID.test(requestId)) throw new Error("invalid Computer upgrade request ID");
  return `cn.coforge.upgrade.${requestId}`;
}

/** User-level Scheduled Task name for a Windows one-shot remote upgrade. */
export function computerUpgradeTaskName(requestId: string): string {
  if (!REQUEST_ID.test(requestId)) throw new Error("invalid Computer upgrade request ID");
  return `CoForge Upgrade ${requestId}`;
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

export type WindowsUpgradeTaskRunner = (command: string[]) => Promise<number>;

export type LaunchComputerUpgradeOptions = ComputerUpgradeJobPathOptions & {
  /** Injectable native launchd access, for tests only. */
  jobPlatform?: LaunchdJobPlatform;
  /** Injectable Windows `schtasks` runner, for tests only. */
  windowsTaskRunner?: WindowsUpgradeTaskRunner;
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
  if (process.platform === "win32") {
    await launchWindowsComputerUpgrade(requestId, command, options.windowsTaskRunner);
    return;
  }
  const child = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  if ((await child.exited) !== 0)
    throw new Error("external Computer upgrade coordinator was rejected");
}

/**
 * Registers a one-shot user Scheduled Task and runs it immediately. The task is outside the
 * Coordinator process tree (and any Agent Job Object), matching systemd-run / launchd one-shot
 * kill-scope isolation. `/SC ONCE` with a far-future start is only a registration placeholder;
 * `/Run` starts the upgrade now.
 */
export async function launchWindowsComputerUpgrade(
  requestId: string,
  action: string[],
  run: WindowsUpgradeTaskRunner = runSchtasks,
): Promise<void> {
  const taskName = computerUpgradeTaskName(requestId);
  const tr = quoteWindowsTaskAction(action);
  const created = await run([
    "schtasks.exe",
    "/Create",
    "/TN",
    taskName,
    "/TR",
    tr,
    "/SC",
    "ONCE",
    "/ST",
    "00:00",
    "/SD",
    "01/01/2099",
    "/F",
    "/RL",
    "LIMITED",
  ]);
  if (created !== 0) throw new Error("external Computer upgrade coordinator was rejected");
  const started = await run(["schtasks.exe", "/Run", "/TN", taskName]);
  if (started !== 0) throw new Error("external Computer upgrade coordinator was rejected");
}

/** Builds the `/TR` string for schtasks: quoted executable, then unquoted argv words. */
export function quoteWindowsTaskAction(action: string[]): string {
  if (action.length === 0) throw new Error("Windows upgrade task action is empty");
  const [executable, ...args] = action;
  const quotedExe = `"${executable!.replaceAll('"', '""')}"`;
  if (args.length === 0) return quotedExe;
  return `${quotedExe} ${args.map((arg) => arg.replaceAll('"', '""')).join(" ")}`;
}

/**
 * Best-effort self-cleanup for the `__remote-upgrade` entry point, called once its upgrade result
 * file has been written. The job's plist already has no KeepAlive, so leaving this job in place
 * cannot make it respawn; this only removes the now-idle `launchctl list` entry and its plist so a
 * later retry does not collide with a stale label. `launchctl bootout` targeting your own
 * still-running job is unreliable on some macOS versions, so callers must tolerate this throwing
 * and rely on the Coordinator startup sweep (see computer-upgrade-sweep.ts) as the backstop.
 * On Windows, deletes the one-shot Scheduled Task of the same request id.
 */
export async function cleanupComputerUpgradeJob(
  requestId: string,
  options: LaunchComputerUpgradeOptions = {},
): Promise<void> {
  if (process.platform === "darwin") {
    const paths = computerUpgradeJobPaths(requestId, options);
    await new LaunchdJob({
      label: paths.label,
      directory: paths.directory,
      command: [],
      platform: options.jobPlatform,
    }).stop();
    return;
  }
  if (process.platform === "win32") {
    await deleteWindowsComputerUpgradeTask(requestId, options.windowsTaskRunner);
  }
}

/** Removes the one-shot Scheduled Task for a completed Windows remote upgrade. */
export async function deleteWindowsComputerUpgradeTask(
  requestId: string,
  run: WindowsUpgradeTaskRunner = runSchtasks,
): Promise<void> {
  const code = await run([
    "schtasks.exe",
    "/Delete",
    "/TN",
    computerUpgradeTaskName(requestId),
    "/F",
  ]);
  if (code !== 0) throw new Error("could not remove the Computer upgrade Scheduled Task");
}

async function runSchtasks(command: string[]): Promise<number> {
  const child = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  return await child.exited;
}
