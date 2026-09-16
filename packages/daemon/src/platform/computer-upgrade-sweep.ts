import { homedir } from "node:os";
import { join } from "node:path";
import { getLogger } from "@logtape/logtape";
import { LaunchdJob, launchdJobs, type LaunchdJobPlatform } from "./launchd-job";

const UPGRADE_JOB_LABEL =
  /^cn\.coforge\.upgrade\.([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

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
};

/**
 * A remote upgrade's one-shot launchd job never respawns (see computer-upgrade-launcher.ts), but
 * once it exits it stays loaded-but-idle: `launchctl list` keeps showing the label and its plist
 * stays on disk until something boots it out. The Coordinator runs this sweep at startup so those
 * leftovers do not accumulate and do not collide with a label a later retry wants to reuse. It
 * only touches jobs whose upgrade already wrote a durable result file - never one that might
 * still be running - and failures here must never block Coordinator startup.
 */
export async function sweepLeftoverComputerUpgradeJobs(
  options: SweepLeftoverComputerUpgradeJobsOptions,
): Promise<void> {
  if (options.platform !== "darwin") return;
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
