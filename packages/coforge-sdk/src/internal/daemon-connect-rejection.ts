/**
 * What a Daemon sends as Centrifugo connect data. The Web connect proxy authenticates the key;
 * the Workspace id lets it tell a key whose Workspace was deleted (the key went with it) from a
 * key it simply does not know.
 */
export type DaemonConnectData = {
  daemonApiKey: string;
  workspaceId: string;
};

/**
 * Why the cloud refused a Daemon's Workspace connection for good. Restarting or reconnecting
 * cannot change either answer; only attaching the Computer again (setup) can.
 */
export const DAEMON_CONNECT_REJECTION_REASONS = ["workspace_deleted", "computer_unlinked"] as const;
export type DaemonConnectRejectionReason = (typeof DAEMON_CONNECT_REJECTION_REASONS)[number];

/**
 * The Centrifugo custom disconnect code for each refusal. Centrifugo reserves 4500-4999 for
 * terminal custom disconnects, which its client SDKs do not reconnect after.
 */
export const DAEMON_CONNECT_REJECTION_CODES = {
  workspace_deleted: 4501,
  computer_unlinked: 4502,
} as const satisfies Record<DaemonConnectRejectionReason, number>;

export function isDaemonConnectRejectionReason(
  value: unknown,
): value is DaemonConnectRejectionReason {
  return DAEMON_CONNECT_REJECTION_REASONS.some((reason) => reason === value);
}

/** The refusal a Centrifugo disconnect carries, when its code and reason both name one. */
export function daemonConnectRejectionReason(disconnect: {
  code?: number;
  reason?: string;
}): DaemonConnectRejectionReason | undefined {
  const { reason } = disconnect;
  return isDaemonConnectRejectionReason(reason) &&
    DAEMON_CONNECT_REJECTION_CODES[reason] === disconnect.code
    ? reason
    : undefined;
}
