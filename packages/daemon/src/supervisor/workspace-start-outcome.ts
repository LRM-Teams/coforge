import type {
  DaemonConnectRejectionReason,
  WorkspaceCloudConnection,
} from "@lrm/coforge-sdk/internal";
import { join } from "node:path";
import { LocalDaemonLauncher } from "#src/daemon-host/launcher";
import { WorkspaceParkedError } from "./workspace-health-journal";
import { workspaceStateDirectory } from "./workspace-instance";

/**
 * One operator start or restart's whole budget: process readiness plus the first cloud connect,
 * for every Workspace it starts. Kept well below the local lifecycle client's 35 s request
 * timeout (`daemon-host/launcher.ts`), so the command always answers with where each Workspace
 * stands instead of the client giving up.
 */
export const OPERATOR_COMMAND_BUDGET_MS = 25_000;
const POLL_MS = 50;
/** How long one Workspace handshake read may take before it counts as not answering. */
const CLOUD_CONNECTION_PROBE_MS = 2_000;

/** What a Workspace process's own handshake says about its cloud connection. */
export type WorkspaceCloudConnectionReport = { state: WorkspaceCloudConnection; error?: string };

/** The socket a Workspace process answers on, under the machine's state root. */
export function workspaceSocketPath(stateRoot: string, workspaceId: string): string {
  return join(workspaceStateDirectory(stateRoot, workspaceId), "daemon.sock");
}

/**
 * Asks one Workspace process's handshake where its cloud connection stands, bounded so a socket
 * that accepts and then stalls cannot hold its caller. Null when it does not answer in time.
 */
export function readWorkspaceCloudConnection(
  stateRoot: string,
  workspaceId: string,
): Promise<WorkspaceCloudConnectionReport | null> {
  // Bounded by the handshake itself, which closes its socket at the deadline.
  return new LocalDaemonLauncher({
    executablePath: process.execPath,
    socketPath: workspaceSocketPath(stateRoot, workspaceId),
    spawn: () => {},
  }).cloudConnection(CLOUD_CONNECTION_PROBE_MS);
}

function connectionReport(
  state: WorkspaceCloudConnection,
  error: string | undefined,
): WorkspaceCloudConnectionReport {
  return { state, ...(error ? { error } : {}) };
}

/** Where one started Workspace's first cloud connect stood when the command answered. */
export type WorkspaceStartOutcome = {
  workspaceId: string;
  cloudConnection: WorkspaceCloudConnection;
  error?: string;
};

export type WorkspaceStartPorts = {
  /** Why the cloud refused this Workspace for good, when it is parked. */
  parkReason(workspaceId: string): Promise<DaemonConnectRejectionReason | undefined>;
  /** What the Workspace process's handshake reports, or null while it does not answer. */
  cloudConnection(workspaceId: string): Promise<WorkspaceCloudConnectionReport | null>;
  now?(): number;
  sleep?(milliseconds: number): Promise<void>;
};

function startOutcome(
  workspaceId: string,
  { state, error }: WorkspaceCloudConnectionReport,
): WorkspaceStartOutcome {
  return { workspaceId, cloudConnection: state, ...(error ? { error } : {}) };
}

/** Throws the Workspace's park, if it has one: a Workspace the cloud refuses at once parks and
 * exits, possibly before its process ever answers. */
export async function throwIfParked(
  ports: Pick<WorkspaceStartPorts, "parkReason">,
  workspaceId: string,
): Promise<void> {
  const reason = await ports.parkReason(workspaceId);
  if (reason) throw new WorkspaceParkedError(workspaceId, reason);
}

/**
 * Waits, under one deadline shared by the whole command, for each started Workspace's first cloud
 * connect. The Workspaces are watched side by side and each is checked at least once, even after
 * the deadline passed, so the answer covers all of them. A Workspace that parked refuses the
 * command once all are checked.
 */
export async function awaitCloudConnections(
  ports: WorkspaceStartPorts,
  workspaceIds: readonly string[],
  deadline: number,
): Promise<WorkspaceStartOutcome[]> {
  const now = ports.now ?? Date.now;
  const sleep = ports.sleep ?? Bun.sleep;
  const watch = async (
    workspaceId: string,
  ): Promise<WorkspaceStartOutcome | WorkspaceParkedError> => {
    while (true) {
      // A parked Workspace never reports a final state, so the journal is read only while the
      // process has not answered or is still connecting.
      const connection = await ports.cloudConnection(workspaceId);
      if (connection && connection.state !== "connecting")
        return startOutcome(workspaceId, connection);
      const reason = await ports.parkReason(workspaceId);
      if (reason) return new WorkspaceParkedError(workspaceId, reason);
      // Still connecting: with why its latest attempt failed, when it is retrying.
      if (now() >= deadline)
        return startOutcome(workspaceId, connectionReport("connecting", connection?.error));
      await sleep(POLL_MS);
    }
  };
  const answers = await Promise.all(workspaceIds.map(watch));
  const refusal = answers.find((answer) => answer instanceof WorkspaceParkedError);
  if (refusal) throw refusal;
  return answers as WorkspaceStartOutcome[];
}
