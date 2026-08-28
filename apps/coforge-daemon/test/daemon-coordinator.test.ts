import { expect, test } from "bun:test";
import { createDaemonCoordinator } from "../src/daemon-coordinator";
import { createDaemonWorkerFactory } from "../index";
import { WorkspaceWorkerImpl } from "../src/workspace-worker/worker";
import type { WorkspaceConnection, WorkspaceWorker } from "../src/workspace-worker/supervisor";
import { InMemoryWorkspaceWorkerCredentialStore } from "../src/workspace-worker/credential-store";

test("daemon coordinator owns workspace worker lifecycle", async () => {
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
    computerId: "computer-a",
    workspaceId: "workspace-a",
    workspaceRoot: "/workspaces/workspace-a",
  };
  const coordinator = createDaemonCoordinator({
    workerFactory: { create: () => worker },
  });

  await coordinator.startWorkspaceWorker(connection);
  await coordinator.startWorkspaceWorker(connection);
  expect(coordinator.getWorkspaceWorker("workspace-a", "computer-a")).toEqual({
    computerId: "computer-a",
    workspaceId: "workspace-a",
  });
  await coordinator.stopWorkspaceWorker("workspace-a", "computer-a");
  expect(coordinator.getWorkspaceWorker("workspace-a", "computer-a")).toBeUndefined();
  await coordinator.shutdown();
  expect(calls).toEqual(["start", "stop"]);
});

test("daemon entry factory creates a real worker with the shared capacity policy", async () => {
  const connection: WorkspaceConnection = {
    computerId: "computer-real",
    workspaceId: "workspace-real",
    workspaceRoot: "/workspaces/workspace-real",
  };
  const credentials = new InMemoryWorkspaceWorkerCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-real");
  // The factory uses the same process-local store as the configured connection.
  const configuredFactory = createDaemonWorkerFactory({
    configuredCapacity: 1,
    credentials,
    transportFactory: {
      create: () => ({ async start() {}, async ready() {}, async stop() {} }),
    },
  });
  const configuredCoordinator = createDaemonCoordinator({
    workerFactory: { create: configuredFactory },
  });

  await configuredCoordinator.configureWorkspaceWorker(connection);
  const worker = await configuredCoordinator.startWorkspaceWorker(connection);

  expect(worker).toBeInstanceOf(WorkspaceWorkerImpl);
  expect(await configuredCoordinator.startWorkspaceWorker(connection)).toBe(worker);
  await configuredCoordinator.shutdown();
});
