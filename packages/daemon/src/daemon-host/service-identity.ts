/**
 * The per-user service each platform registers for the Coordinator. The installer stops and
 * starts the same services, so these names are part of installer/contract/service-identities.json.
 */
export const COORDINATOR_SERVICE = {
  launchdLabel: "cn.coforge.computer.daemon",
  systemdUserUnit: "coforge-daemon.service",
  windowsTask: "CoForge Daemon",
} as const;

/** The Coordinator service name on `platform`: a launchd label, systemd unit, or task name. */
export function coordinatorServiceName(platform: NodeJS.Platform): string {
  if (platform === "linux") return COORDINATOR_SERVICE.systemdUserUnit;
  if (platform === "win32") return COORDINATOR_SERVICE.windowsTask;
  return COORDINATOR_SERVICE.launchdLabel;
}
