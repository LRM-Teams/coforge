import { expect, test } from "bun:test";
import { decodeDaemonRuntimeReadyRequest, encodeDaemonRuntimeReadyRequest } from "./codec";

const ready = {
  protocolMajor: 1,
  requestId: "ready-1",
  workspaceId: "workspace-1",
  computerId: "computer-1",
  workerInstanceId: "worker-1",
  daemonVersion: "1.2.3",
  startedAt: 123,
  runningAgentIds: ["agent-1", "agent-2"],
  recoveredRestartRequestIds: ["restart-1"],
};

test("round-trips running Agent IDs in daemon ready", () => {
  expect(decodeDaemonRuntimeReadyRequest(encodeDaemonRuntimeReadyRequest(ready))).toEqual(ready);
});

test("round-trips fresh process identity, version, and restart recovery evidence", () => {
  expect(decodeDaemonRuntimeReadyRequest(encodeDaemonRuntimeReadyRequest(ready))).toMatchObject({
    workerInstanceId: "worker-1",
    daemonVersion: "1.2.3",
    recoveredRestartRequestIds: ["restart-1"],
  });
});

test("additively round-trips daemon capabilities", () => {
  const capable = { ...ready, capabilities: ["reminder:v1"] };
  expect(decodeDaemonRuntimeReadyRequest(encodeDaemonRuntimeReadyRequest(capable))).toEqual(
    capable,
  );
});

test("round-trips a Workspace-scoped Computer restart intent", async () => {
  const { decodeComputerRestartIntent, encodeComputerRestartIntent } = await import("./codec");
  const intent = {
    protocolMajor: 1,
    requestId: "restart-1",
    workspaceId: "workspace-1",
    computerId: "computer-1",
    messageType: "coforge.rpc.v1.ComputerRestartIntent" as const,
  };
  expect(decodeComputerRestartIntent(encodeComputerRestartIntent(intent))).toEqual(intent);
});

test("rejects empty and duplicate running Agent IDs", () => {
  expect(() => encodeDaemonRuntimeReadyRequest({ ...ready, runningAgentIds: [""] })).toThrow(
    "non-empty and unique",
  );
  expect(() =>
    encodeDaemonRuntimeReadyRequest({ ...ready, runningAgentIds: ["agent-1", "agent-1"] }),
  ).toThrow("non-empty and unique");
});
