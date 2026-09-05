import { expect, test } from "bun:test";
import { decodeDaemonRuntimeReadyRequest, encodeDaemonRuntimeReadyRequest } from "./codec";

const ready = {
  protocolMajor: 1,
  requestId: "ready-1",
  workspaceId: "workspace-1",
  computerId: "computer-1",
  workerInstanceId: "worker-1",
  startedAt: 123,
  runningAgentIds: ["agent-1", "agent-2"],
};

test("round-trips running Agent IDs in daemon ready", () => {
  expect(decodeDaemonRuntimeReadyRequest(encodeDaemonRuntimeReadyRequest(ready))).toEqual(ready);
});

test("rejects empty and duplicate running Agent IDs", () => {
  expect(() => encodeDaemonRuntimeReadyRequest({ ...ready, runningAgentIds: [""] })).toThrow(
    "non-empty and unique",
  );
  expect(() =>
    encodeDaemonRuntimeReadyRequest({ ...ready, runningAgentIds: ["agent-1", "agent-1"] }),
  ).toThrow("non-empty and unique");
});
