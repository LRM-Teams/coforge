import type { DaemonConnectRejectionReason } from "@lrm/coforge-sdk/internal";

/** The cloud refused this Workspace's connection for good: `reason` is its stable code. */
export class DaemonConnectionRefusedError extends Error {
  constructor(readonly reason: DaemonConnectRejectionReason) {
    super(`The cloud refused the Workspace connection (${reason})`);
    this.name = "DaemonConnectionRefusedError";
  }
}
