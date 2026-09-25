import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getLogger } from "@logtape/logtape";
import { RFC_UUID_SOURCE } from "@lrm/coforge-sdk/internal";
import { LaunchdJob, launchdJobs, type LaunchdJobPlatform } from "./launchd-job";
import {
  computerUpgradeTaskName,
  type WindowsUpgradeTaskRunner,
} from "./computer-upgrade-launcher";

const UPGRADE_JOB_LABEL = new RegExp(`^cn\\.coforge\\.upgrade\\.(${RFC_UUID_SOURCE})$`, "i");
const UPGRADE_RESULT_FILE = new RegExp(`^(${RFC_UUID_SOURCE})\\.result\\.json$`, "i");

export type SweepLeftoverComputerUpgradeJobsOptions = {
  platform: NodeJS.Platform;
  /** The daemon's own state directory; matches the directory launchComputerUpgrade wrote the
   * plist into (`<stateDirectory>/upgrade-jobs`). */
  stateDirectory: string;
  homeDirectory?: string;
  /** Injectable native launchd access, for tests only. */
  jobPlatform?: LaunchdJobPlatform;
  /** Injectable result-file check, for tests only. */
  resultExists?: (requestId: string) => Promise<boolean>;
  /** Injectable Windows `schtasks` runner, for tests only. */
  windowsTaskRunner?: WindowsUpgradeTaskRunner;
  /** Injectable listing of completed upgrade request IDs (Windows), for tests only. */
  listCompletedRequestIds?: () => Promise<string[]>;
};

/**
 * A remote upgrade's one-shot OS job never respawns, but once it exits it may stay registered
 * (launchd list entry / Scheduled Task) until something removes it. The Coordinator runs this
 * sweep at startup so leftovers do not accumulate and do not collide with a later retry. It only
 * touches jobs whose upgrade already wrote a durable result file - never one that might still be
 * running - and failures here must never block Coordinator startup.
 */
export async function sweepLeftoverComputerUpgradeJobs(
  options: SweepLeftoverComputerUpgradeJobsOptions,
): Promise<void> {
  if (options.platform === "darwin") {
    await sweepDarwin(options);
    return;
  }
  if (options.platform === "win32") {
    await sweepWindows(options);
  }
}

async function sweepDarwin(options: SweepLeftoverComputerUpgradeJobsOptions): Promise<void> {
  const home = options.homeDirectory ?? homedir();
  const directory = join(options.stateDirectory, "upgrade-jobs");
  const resultExists =
    options.resultExists ??
    ((requestId: string) =>
      Bun.file(
        join(
          home,
          ".coforge",
          "computer",
          "install",
          "upgrade-results",
          `${requestId}.result.json`,
        ),
      ).exists());
  const logger = getLogger(["coforge", "daemon", "supervisor"]);
  const jobs = await (options.jobPlatform ? options.jobPlatform.jobs() : launchdJobs());
  for (const label of jobs.keys()) {
    const match = UPGRADE_JOB_LABEL.exec(label);
    if (!match) continue;
    const requestId = match[1]!;
    if (!(await resultExists(requestId))) continue;
    try {
      await new LaunchdJob({ label, directory, command: [], platform: options.jobPlatform }).stop();
      logger.info("Removed a leftover Computer upgrade job", {
        event: "upgrade:leftover_job_removed",
        label,
      });
    } catch (error) {
      logger.error("Could not remove a leftover Computer upgrade job", {
        event: "upgrade:leftover_job_removal_failed",
        label,
        error_message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function sweepWindows(options: SweepLeftoverComputerUpgradeJobsOptions): Promise<void> {
  const home = options.homeDirectory ?? homedir();
  const logger = getLogger(["coforge", "daemon", "supervisor"]);
  const run = options.windowsTaskRunner ?? defaultSchtasks;
  const requestIds =
    (await options.listCompletedRequestIds?.()) ??
    (await listCompletedUpgradeRequestIds(home, options.resultExists));
  for (const requestId of requestIds) {
    const taskName = computerUpgradeTaskName(requestId);
    try {
      const code = await run(["schtasks.exe", "/Delete", "/TN", taskName, "/F"]);
      if (code !== 0) throw new Error(`schtasks /Delete exited ${code}`);
      logger.info("Removed a leftover Computer upgrade Scheduled Task", {
        event: "upgrade:leftover_job_removed",
        label: taskName,
      });
    } catch (error) {
      logger.error("Could not remove a leftover Computer upgrade Scheduled Task", {
        event: "upgrade:leftover_job_removal_failed",
        label: taskName,
        error_message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function listCompletedUpgradeRequestIds(
  home: string,
  resultExists?: (requestId: string) => Promise<boolean>,
): Promise<string[]> {
  const directory = join(home, ".coforge", "computer", "install", "upgrade-results");
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const ids: string[] = [];
  for (const name of names) {
    const match = UPGRADE_RESULT_FILE.exec(name);
    if (!match) continue;
    const requestId = match[1]!;
    if (resultExists && !(await resultExists(requestId))) continue;
    ids.push(requestId);
  }
  return ids;
}

async function defaultSchtasks(command: string[]): Promise<number> {
  const child = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  return await child.exited;
}
