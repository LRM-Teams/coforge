import { expect, test } from "bun:test";
import { create, toBinary } from "@bufbuild/protobuf";
import { DaemonRuntimeShutdownSchema } from "#src/internal/gen/coforge/rpc/v1/daemon_runtime_pb";
import { DaemonHoldRequestSchema } from "#src/internal/gen/coforge/rpc/v1/local_rpc_pb";
import {
  RUNNER_HOLD_REASONS,
  decodeDaemonHoldRequest,
  encodeDaemonHoldRequest,
  DAEMON_RUNTIME_SHUTDOWN_METHOD,
  DAEMON_SHUTDOWN_REASONS,
  decodeDaemonRuntimeShutdown,
  encodeDaemonRuntimeShutdown,
  type DaemonRuntimeShutdown,
} from "./index";

const notice = (): DaemonRuntimeShutdown => ({
  protocolMajor: 1,
  requestId: "shutdown-1",
  workspaceId: "workspace-1",
  computerId: "computer-1",
  workerInstanceId: "worker-1",
  reason: "computer_upgrade",
});

test("the shutdown notice travels on the daemon runtime namespace", () => {
  expect(DAEMON_RUNTIME_SHUTDOWN_METHOD).toBe("daemon:v1:runtime:shutdown");
});

test("round-trips every shutdown reason", () => {
  expect(DAEMON_SHUTDOWN_REASONS).toEqual([
    "computer_upgrade",
    "computer_restart",
    "computer_stop",
  ]);
  for (const reason of DAEMON_SHUTDOWN_REASONS) {
    const value = { ...notice(), reason };
    expect(decodeDaemonRuntimeShutdown(encodeDaemonRuntimeShutdown(value))).toEqual(value);
  }
});

test("refuses an unknown reason, another protocol, or a missing scope field", () => {
  expect(() =>
    encodeDaemonRuntimeShutdown({
      ...notice(),
      reason: "crash" as DaemonRuntimeShutdown["reason"],
    }),
  ).toThrow("invalid daemon shutdown notice");
  expect(() => encodeDaemonRuntimeShutdown({ ...notice(), protocolMajor: 2 })).toThrow(
    "invalid daemon shutdown notice",
  );
  for (const field of ["requestId", "workspaceId", "computerId", "workerInstanceId"] as const)
    expect(() => encodeDaemonRuntimeShutdown({ ...notice(), [field]: "" }), field).toThrow(
      "invalid daemon shutdown notice",
    );
});

test("refuses an oversized payload before decoding it", () => {
  expect(() => decodeDaemonRuntimeShutdown(new Uint8Array(4_097))).toThrow("too large");
});

test("keeps wire tags stable", () => {
  const fields = Object.fromEntries(
    DaemonRuntimeShutdownSchema.fields.map((field) => [field.localName, field.number]),
  );
  expect(fields).toEqual({
    protocolMajor: 1,
    requestId: 2,
    workspaceId: 3,
    computerId: 4,
    workerInstanceId: 5,
    reason: 6,
  });
});

test("a hold request carries only a known hold reason", () => {
  const request = { protocolMajor: 1, requestId: "hold-1", expectedServerUrl: "https://cloud" };
  for (const reason of Object.values(RUNNER_HOLD_REASONS))
    expect(decodeDaemonHoldRequest(encodeDaemonHoldRequest({ ...request, reason })).reason).toBe(
      reason,
    );
  const unknown = create(DaemonHoldRequestSchema, { ...request, reason: "maintenance" });
  expect(
    decodeDaemonHoldRequest(toBinary(DaemonHoldRequestSchema, unknown)).reason,
  ).toBeUndefined();
});
