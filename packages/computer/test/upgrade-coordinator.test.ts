import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  coordinateUpgrade,
  launchUpgradeCoordinator,
  UpgradeCoordinatorError,
  type UpgradeCoordinatorOptions,
} from "../src/release/upgrade-coordinator";
import { ComputerUpdater, type LockedComputerUpdater } from "../src/updater";
import type { ManagedRuntimeSnapshot, UpgradeLifecycle } from "../src/release/upgrade-lifecycle";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const snapshot: ManagedRuntimeSnapshot = {
  bindings: [
    { bindingId: "running-a", running: true, processId: 101 },
    { bindingId: "stopped-b", running: false, processId: null },
  ],
};

async function harness(failCandidateProbe = false, failRestore = false) {
  const installRoot = await mkdtemp(join(tmpdir(), "coforge-coordinator-"));
  directories.push(installRoot);
  const calls: string[] = [];
  const lifecycle: UpgradeLifecycle = {
    async snapshot() {
      calls.push("snapshot");
      return snapshot;
    },
    async pauseLaunches() {
      calls.push("pause");
    },
    async stop(value) {
      expect(value).toBe(snapshot);
      calls.push("stop");
    },
    async start(value, version) {
      expect(value).toBe(snapshot);
      calls.push(`start:${version}`);
    },
    async probe(value, expected) {
      expect(value).toBe(snapshot);
      expect(expected.previousProcessIds).toEqual([101]);
      calls.push(`probe:${expected.version}`);
      if (failCandidateProbe && expected.version === "2.0.0") throw new Error("wrong pid");
    },
    async resumeLaunches() {
      calls.push("resume");
    },
  };
  const updater = {
    async prepare() {
      calls.push("prepare");
      return { version: "2.0.0", previous: "1.0.0" };
    },
    async prepareRollback() {
      throw new Error("not called");
    },
    async activatePrepared() {
      calls.push("activate:2.0.0");
    },
    async restoreVerified(version: string) {
      calls.push(`restore:${version}`);
      if (failRestore) throw new Error("old bytes corrupt");
    },
  };
  const lockOwner = new ComputerUpdater({
    installRoot,
    target: "linux-x64",
    baseUrl: "https://releases.example/",
  });
  const options: UpgradeCoordinatorOptions = {
    installRoot,
    binaryDirectory: join(installRoot, "bin"),
    target: "linux-x64",
    baseUrl: "https://releases.example/",
    selection: "2.0.0",
    operation: "upgrade",
    supervisorSocketPath: join(installRoot, "supervisor.sock"),
    supervisorStatePath: join(installRoot, "supervisor.json"),
    lifecycle,
    updater: {
      withExclusiveOperation: (operation) =>
        lockOwner.withExclusiveOperation(() => operation(updater as LockedComputerUpdater)),
    },
  };
  return { calls, options };
}

test("direct install contends with the coordinator's lock through resume", async () => {
  const { options } = await harness();
  const enteredResume = Promise.withResolvers<void>();
  const allowResume = Promise.withResolvers<void>();
  const lifecycle = options.lifecycle!;
  options.lifecycle = {
    ...lifecycle,
    async resumeLaunches() {
      enteredResume.resolve();
      await allowResume.promise;
      await lifecycle.resumeLaunches();
    },
  };
  const coordinate = coordinateUpgrade(options);
  await enteredResume.promise;
  const contender = new ComputerUpdater({
    installRoot: options.installRoot,
    target: options.target,
    baseUrl: options.baseUrl,
  });
  await expect(contender.install("2.0.0")).rejects.toMatchObject({ code: "UPDATE_BUSY" });
  allowResume.resolve();
  await expect(coordinate).resolves.toMatchObject({ status: "succeeded" });
});

test("coordinator prepares while running then restores the exact running snapshot on candidate", async () => {
  const { calls, options } = await harness();

  await expect(coordinateUpgrade(options)).resolves.toMatchObject({
    status: "succeeded",
    version: "2.0.0",
  });
  expect(calls).toEqual([
    "prepare",
    "pause",
    "snapshot",
    "stop",
    "activate:2.0.0",
    "start:2.0.0",
    "probe:2.0.0",
    "resume",
  ]);
});

test("candidate health failure verifies and restores old bytes and exact running snapshot", async () => {
  const { calls, options } = await harness(true);

  await expect(coordinateUpgrade(options)).rejects.toMatchObject({
    result: { status: "failed", restoredVersion: "1.0.0", error: "wrong pid" },
  });
  expect(calls.slice(-5)).toEqual([
    "stop",
    "restore:1.0.0",
    "start:1.0.0",
    "probe:1.0.0",
    "resume",
  ]);
});

test("rollback verification failure is reported and launches remain paused", async () => {
  const { calls, options } = await harness(true, true);

  try {
    await coordinateUpgrade(options);
    throw new Error("expected failure");
  } catch (error) {
    expect(error).toBeInstanceOf(UpgradeCoordinatorError);
    expect((error as UpgradeCoordinatorError).result.error).toContain(
      "rollback failed: old bytes corrupt",
    );
  }
  expect(calls).not.toContain("resume");
});

test("a coordinator that exits without evidence does not strand the caller", async () => {
  const { options } = await harness();
  const { lifecycle: _lifecycle, updater: _updater, ...request } = options;
  // The Bun interpreter is not a release executable: __upgrade exits without a result.
  await expect(
    launchUpgradeCoordinator({ ...request, executablePath: process.execPath }),
  ).rejects.toThrow("upgrade coordinator exited without a result");
});
