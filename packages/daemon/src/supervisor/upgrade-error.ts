import { UPGRADE_ERROR_CODE, type UpgradeErrorCode } from "@lrm/coforge-sdk/internal";

/**
 * A Computer upgrade refusal or failure the Coordinator can name a stable reason for. Every
 * throw site in this package that refuses or fails an upgrade request throws one of these
 * instead of a bare `Error`, so the code travels with the message instead of a caller having to
 * parse free text (ADR 0041). `code` is always one of
 * `UPGRADE_ERROR_CODE`'s values.
 */
export class UpgradeError extends Error {
  constructor(
    readonly code: UpgradeErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "UpgradeError";
  }
}

/** A previous upgrade operation on this Workspace has not left a receipt yet, and the
 * Coordinator cannot tell whether its job is still genuinely running. Thrown by
 * `MachineSupervisor.recordUpgrade`. */
export class UpgradeOperationPendingError extends UpgradeError {
  constructor(message: string) {
    super(UPGRADE_ERROR_CODE.OPERATION_PENDING, message);
    this.name = "UpgradeOperationPendingError";
  }
}

/** This machine is mid-upgrade (`MachineSupervisor#assertMutable`); the launch-hold file is
 * still on disk. */
export class UpgradeLaunchesPausedError extends UpgradeError {
  constructor(message: string) {
    super(UPGRADE_ERROR_CODE.LAUNCHES_PAUSED, message);
    this.name = "UpgradeLaunchesPausedError";
  }
}

/** `recordUpgrade` accepted the request, but the external upgrade job itself could not be
 * started (`launchComputerUpgrade` rejected). */
export class UpgradeLaunchFailedError extends UpgradeError {
  constructor(message: string, options?: ErrorOptions) {
    super(UPGRADE_ERROR_CODE.LAUNCH_FAILED, message, options);
    this.name = "UpgradeLaunchFailedError";
  }
}
