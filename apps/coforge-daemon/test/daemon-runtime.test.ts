import { expect, test } from "bun:test";
import { createDaemonRuntime } from "../src/daemon-runtime";
import type { WorkspaceConnection, WorkspaceWorker } from "../src/workspace-worker/supervisor";

test("daemon runtime owns workspace connection lifecycle", async () => {
  const calls: string[] = [];
  const worker: WorkspaceWorker = {
    async start() {
      calls.push("start");
    },
    async stop() {
      calls.push("stop");
    },
  };
  const connection: WorkspaceConnection = {
    connectionId: "connection-a",
    workspaceId: "workspace-a",
    workspaceRoot: "/workspaces/workspace-a",
  };
  const runtime = createDaemonRuntime({
    workerFactory: { create: () => worker },
  });

  await runtime.ensureConnection(connection);
  expect(runtime.queryConnection("connection-a")).toEqual({
    connectionId: "connection-a",
    workspaceId: "workspace-a",
  });
  await runtime.stopConnection("connection-a");
  expect(runtime.queryConnection("connection-a")).toBeUndefined();
  await runtime.shutdown();
  expect(calls).toEqual(["start", "stop"]);
});
