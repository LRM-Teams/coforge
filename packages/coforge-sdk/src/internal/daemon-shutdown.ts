import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { DaemonRuntimeShutdownSchema } from "#src/internal/gen/coforge/rpc/v1/daemon_runtime_pb";
import { RPC_METHODS } from "./rpc-methods";
import { boundedPayload } from "./bounded-payload";

/** Daemon -> server notice, sent just before a deliberate shutdown closes the connection. */
export const DAEMON_RUNTIME_SHUTDOWN_METHOD = RPC_METHODS.daemonRuntimeShutdown;

/**
 * Why a Workspace daemon is going down on purpose: the Computer is upgrading, restarting (the
 * whole Computer or only this Workspace's daemon), or being stopped. A crash sends no notice.
 */
export const DAEMON_SHUTDOWN_REASONS = [
  "computer_upgrade",
  "computer_restart",
  "computer_stop",
] as const;
export type DaemonShutdownReason = (typeof DAEMON_SHUTDOWN_REASONS)[number];

export type DaemonRuntimeShutdown = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  workerInstanceId: string;
  reason: DaemonShutdownReason;
};

const MAX_SHUTDOWN_BYTES = 4_096;
const LABEL = "daemon shutdown notice";

export function encodeDaemonRuntimeShutdown(value: DaemonRuntimeShutdown): Uint8Array {
  check(value);
  return boundedPayload(
    toBinary(DaemonRuntimeShutdownSchema, create(DaemonRuntimeShutdownSchema, value)),
    MAX_SHUTDOWN_BYTES,
    LABEL,
  );
}

export function decodeDaemonRuntimeShutdown(bytes: Uint8Array): DaemonRuntimeShutdown {
  const { $typeName: _, ...value } = fromBinary(
    DaemonRuntimeShutdownSchema,
    boundedPayload(bytes, MAX_SHUTDOWN_BYTES, LABEL),
  );
  check(value);
  return value;
}

function check(value: {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  workerInstanceId: string;
  reason: string;
}): asserts value is DaemonRuntimeShutdown {
  if (
    value.protocolMajor !== 1 ||
    !DAEMON_SHUTDOWN_REASONS.some((reason) => reason === value.reason) ||
    [value.requestId, value.workspaceId, value.computerId, value.workerInstanceId].some(
      (field) => !field.trim() || field.length > 512,
    )
  )
    throw new Error(`invalid ${LABEL}`);
}
