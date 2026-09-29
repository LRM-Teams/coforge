import type {
  DaemonConnectRejectionReason,
  WorkspaceCloudConnection,
} from "@lrm/coforge-sdk/internal";
import { WorkspaceParkedError } from "./workspace-health-journal";

/**
 * One operator start or restart's whole budget: process readiness plus the first cloud connect,
 * for every Workspace it starts. Kept well below the local lifecycle client's 35 s request
 * timeout (`daemon-host/launcher.ts`), so the command always answers with where each Workspace
 * stands instead of the client giving up.
 */
export const OPERATOR_COMMAND_BUDGET_MS = 25_000;
const POLL_MS = 50;

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
  cloudConnection(
    workspaceId: string,
  ): Promise<{ state: WorkspaceCloudConnection; error?: string } | null>;
  now?(): number;
  sleep?(milliseconds: number): Promise<void>;
};

/** A Workspace the command's budget ran out on before its process answered. */
export class WorkspaceStillStartingError extends Error {
  constructor(readonly workspaceId: string) {
    super(`Workspace ${workspaceId} is still starting`);
    this.name = "WorkspaceStillStartingError";
  }
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
 * connect. Every Workspace is checked at least once, even after the deadline passed, so the
 * answer covers all of them. A Workspace that parked refuses the command once all are checked.
 */
export async function awaitCloudConnections(
  ports: WorkspaceStartPorts,
  workspaceIds: readonly string[],
  deadline: number,
): Promise<WorkspaceStartOutcome[]> {
  const now = ports.now ?? Date.now;
  const sleep = ports.sleep ?? Bun.sleep;
  const outcomes: WorkspaceStartOutcome[] = [];
  let refusal: WorkspaceParkedError | undefined;
  for (const workspaceId of workspaceIds) {
    while (true) {
      // A parked Workspace never reports a final state, so the journal is read only while the
      // process has not answered or is still connecting.
      const connection = await ports.cloudConnection(workspaceId);
      if (connection && connection.state !== "connecting") {
        outcomes.push({
          workspaceId,
          cloudConnection: connection.state,
          ...(connection.error ? { error: connection.error } : {}),
        });
        break;
      }
      const reason = await ports.parkReason(workspaceId);
      if (reason) {
        refusal ??= new WorkspaceParkedError(workspaceId, reason);
        break;
      }
      if (now() >= deadline) {
        outcomes.push({ workspaceId, cloudConnection: "connecting" });
        break;
      }
      await sleep(POLL_MS);
    }
  }
  if (refusal) throw refusal;
  return outcomes;
}
