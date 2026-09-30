import { homedir } from "node:os";

import { resolveComputerBinaryDirectory, resolveComputerInstallDirectory } from "#src/paths";
import { currentComputerPlatform } from "#src/platform";
import { COFORGE_RELEASE_FEED_URL } from "#src/release-channel";
import {
  launchUpgradeCoordinator,
  type LaunchUpgradeCoordinatorPaths,
  type UpgradeResult,
} from "./upgrade-coordinator";
import type { UpgradeOperation } from "./upgrade-operation";
import { resolveSupervisorPaths } from "./supervisor-status";

/** This machine's installation, release feed, and Coordinator locations, all resolved from
 * `os.homedir()`: HOME on POSIX (else the account's passwd entry), USERPROFILE on Windows (else
 * the profile directory). The installer follows the same rule; see crates/installer/contract/paths.json. */
export function resolveUpgradeCoordinatorPaths(): LaunchUpgradeCoordinatorPaths {
  const homeDirectory = homedir();
  return {
    installRoot: resolveComputerInstallDirectory({
      platform: process.platform,
      homeDirectory,
      environment: process.env,
    }),
    binaryDirectory: resolveComputerBinaryDirectory({
      platform: process.platform,
      homeDirectory,
      environment: process.env,
    }),
    target: currentComputerPlatform().releaseTarget,
    baseUrl: COFORGE_RELEASE_FEED_URL,
    ...resolveSupervisorPaths(),
  };
}

/**
 * Runs one upgrade or rollback operation on this machine. Both the interactive commands and the
 * server-triggered `__remote-upgrade` entry point come through here, so they share one durable
 * request/result receipt pair and one operation identity.
 */
export function runUpgradeOperation(operation: UpgradeOperation): Promise<UpgradeResult> {
  return launchUpgradeCoordinator(operation, resolveUpgradeCoordinatorPaths());
}
