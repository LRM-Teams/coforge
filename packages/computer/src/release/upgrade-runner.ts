import { homedir } from "node:os";

import {
  resolveComputerBinaryDirectory,
  resolveComputerInstallDirectory,
  resolveComputerStateDirectory,
  resolveDaemonSocketPath,
} from "#src/paths";
import { currentComputerPlatform } from "#src/platform";
import { COFORGE_RELEASE_FEED_URL } from "#src/release-channel";
import {
  launchUpgradeCoordinator,
  type LaunchUpgradeCoordinatorPaths,
  type UpgradeResult,
} from "./upgrade-coordinator";
import type { UpgradeOperation } from "./upgrade-operation";

/** This machine's installation, release feed, and Coordinator locations. */
export function resolveUpgradeCoordinatorPaths(): LaunchUpgradeCoordinatorPaths {
  const homeDirectory = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const supervisorStatePath = resolveComputerStateDirectory({
    platform: process.platform,
    homeDirectory: homedir(),
    environment: Bun.env,
  });
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
    supervisorStatePath,
    supervisorSocketPath: resolveDaemonSocketPath({
      platform: process.platform,
      stateDirectory: supervisorStatePath,
    }),
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
