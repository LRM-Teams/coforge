import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  coordinateUpgrade,
  launchUpgradeCoordinator,
  UpgradeCoordinatorError,
  upgradeReceiptPaths,
  type UpgradeCoordinatorOptions,
} from "../src/release/upgrade-coordinator";
import type { UpgradeOperation } from "../src/release/upgrade-operation";
import { ComputerUpdater, type LockedComputerUpdater } from "../src/updater";
import {
  createSupervisorUpgradeLifecycle,
  type ManagedRuntimeSnapshot,
  type UpgradeLifecycle,
} from "../src/release/upgrade-lifecycle";

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
  supervisorRunning: true,
};

async function harness(failCandidateProbe = false, failRestore = false) {
  const installRoot = await mkdtemp(join(tmpdir(), "coforge-coordinator-"));
  directories.push(installRoot);
  const calls: string[] = [];
  const lifecycle: UpgradeLifecycle = {
    restartsInPlace: false,
    async snapshot() {
      calls.push("snapshot");
      return snapshot;
    },
    async pauseLaunches() {
      calls.push("pause");
    },
    async holdRunners() {
      calls.push("hold");
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
      calls.push(`probe:${expected.version}`);
      if (failCandidateProbe && expected.version === "2.0.0") throw new Error("wrong pid");
    },
    async resumeLaunches(resumeRequestId) {
      expect(resumeRequestId).toBe(requestId);
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
  const requestId = crypto.randomUUID();
  const options: UpgradeCoordinatorOptions = {
    requestId,
    origin: "cli",
    quiet: false,
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
  return { calls, options, requestId };
}

test("launch-hold durably names the exact upgrade request that owns it", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-upgrade-hold-"));
  directories.push(root);
  const stateDirectory = join(root, "state");
  const requestId = crypto.randomUUID();
  const lifecycle = createSupervisorUpgradeLifecycle({
    installRoot: root,
    supervisorSocketPath: join(root, "missing.sock"),
    supervisorStatePath: stateDirectory,
  });

  await lifecycle.pauseLaunches(requestId);
  expect((await Bun.file(join(stateDirectory, "launch-hold")).text()).trim()).toBe(requestId);

  await lifecycle.resumeLaunches(requestId);
  expect(await Bun.file(join(stateDirectory, "launch-hold")).exists()).toBe(false);
});

test("direct install contends with the coordinator's lock through resume", async () => {
  const { options } = await harness();
  const enteredResume = Promise.withResolvers<void>();
  const allowResume = Promise.withResolvers<void>();
  const lifecycle = options.lifecycle!;
  options.lifecycle = {
    ...lifecycle,
    async resumeLaunches(requestId) {
      enteredResume.resolve();
      await allowResume.promise;
      await lifecycle.resumeLaunches(requestId);
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

test("coordinator commits candidate success before resuming Workspace launches", async () => {
  const { calls, options } = await harness();
  const stages: string[] = [];

  await expect(
    coordinateUpgrade(
      options,
      (stage) => stages.push(stage),
      async (result) => {
        calls.push(`commit:${result.status}`);
      },
    ),
  ).resolves.toMatchObject({
    status: "succeeded",
    version: "2.0.0",
    supervisorRunning: true,
    runtimes: [
      { bindingId: "running-a", running: true },
      { bindingId: "stopped-b", running: false },
    ],
  });
  expect(calls).toEqual([
    "prepare",
    "pause",
    "snapshot",
    "hold",
    "stop",
    "activate:2.0.0",
    "start:2.0.0",
    "probe:2.0.0",
    "commit:succeeded",
    "resume",
  ]);
  expect(stages).toEqual([
    "Pausing new Workspace launches",
    "Holding Agent runners until they are idle",
    "Stopping Computer supervisor and 1 Workspace runtime",
    "Switching the active executable to 2.0.0",
    "Starting Computer supervisor 2.0.0; Workspace launches remain held (1 to resume, 1 stay stopped)",
    "Waiting for the Computer supervisor to report 2.0.0",
    "Computer supervisor 2.0.0 healthy; Workspace launches remain held",
    "Recording the terminal upgrade result before Workspace launch",
    "Resuming Workspace launches",
  ]);
});

test("Workspace recovery failure after commit does not roll the Computer version back", async () => {
  const { calls, options } = await harness();
  const lifecycle = options.lifecycle!;
  options.lifecycle = {
    ...lifecycle,
    async resumeLaunches() {
      calls.push("resume");
      throw new Error("Workspace child failed to start");
    },
  };

  await expect(
    coordinateUpgrade(options, undefined, async (result) => {
      calls.push(`commit:${result.status}`);
    }),
  ).rejects.toMatchObject({
    result: { status: "succeeded", version: "2.0.0" },
    message: "candidate committed; Workspace recovery failed",
  });
  expect(calls).toContain("commit:succeeded");
  expect(calls).toContain("resume");
  expect(calls.some((call) => call.startsWith("restore:"))).toBe(false);
});

test("candidate Supervisor health failure commits rollback before resuming Workspace launches", async () => {
  const { calls, options } = await harness(true);
  const stages: string[] = [];

  await expect(
    coordinateUpgrade(
      options,
      (stage) => stages.push(stage),
      async (result) => {
        calls.push(`commit:${result.status}`);
      },
    ),
  ).rejects.toMatchObject({
    result: {
      status: "failed",
      restoredVersion: "1.0.0",
      error: "wrong pid",
      errorCode: "UPGRADE_ROLLED_BACK",
    },
  });
  expect(calls.slice(-6)).toEqual([
    "stop",
    "restore:1.0.0",
    "start:1.0.0",
    "probe:1.0.0",
    "commit:failed",
    "resume",
  ]);
  expect(stages).toEqual([
    "Pausing new Workspace launches",
    "Holding Agent runners until they are idle",
    "Stopping Computer supervisor and 1 Workspace runtime",
    "Switching the active executable to 2.0.0",
    "Starting Computer supervisor 2.0.0; Workspace launches remain held (1 to resume, 1 stay stopped)",
    "Waiting for the Computer supervisor to report 2.0.0",
    "Upgrade failed: wrong pid; restoring 1.0.0",
    "Stopping Computer supervisor and 1 Workspace runtime",
    "Switching the active executable to 1.0.0",
    "Starting Computer supervisor 1.0.0; Workspace launches remain held (1 to resume, 1 stay stopped)",
    "Waiting for the Computer supervisor to report 1.0.0",
    "Computer supervisor 1.0.0 healthy; Workspace launches remain held",
    "Recording the rollback result before Workspace launch",
    "Resuming Workspace launches",
    "Previous version 1.0.0 restored and healthy",
  ]);
});

test("stages describe an executable-only switch when no supervisor is running", async () => {
  const { options } = await harness();
  const notRunningSnapshot: ManagedRuntimeSnapshot = {
    bindings: [{ bindingId: "disabled-a", running: false, processId: null }],
    supervisorRunning: false,
  };
  const calls: string[] = [];
  options.lifecycle = {
    restartsInPlace: false,
    async snapshot() {
      calls.push("snapshot");
      return notRunningSnapshot;
    },
    async pauseLaunches() {
      calls.push("pause");
    },
    async holdRunners() {
      calls.push("hold");
    },
    async stop(value) {
      expect(value).toBe(notRunningSnapshot);
      calls.push("stop");
    },
    async start(value, version) {
      expect(value).toBe(notRunningSnapshot);
      calls.push(`start:${version}`);
    },
    async probe(value, expected) {
      expect(value).toBe(notRunningSnapshot);
      calls.push(`probe:${expected.version}`);
    },
    async resumeLaunches() {
      calls.push("resume");
    },
  };
  const stages: string[] = [];

  await expect(coordinateUpgrade(options, (stage) => stages.push(stage))).resolves.toMatchObject({
    status: "succeeded",
    version: "2.0.0",
    supervisorRunning: false,
    runtimes: [{ bindingId: "disabled-a", running: false }],
  });
  expect(stages).toEqual([
    "Pausing new Workspace launches",
    "Computer supervisor is not running; no processes to restart",
    "Switching the active executable to 2.0.0",
    "Checking the activated executable reports 2.0.0",
    "Activated executable 2.0.0 confirmed",
    "Recording the terminal upgrade result before Workspace launch",
    "Resuming Workspace launches",
  ]);
});

test("an in-place lifecycle switches by check, activate, restart, probe with no stop/start stage text (ADR 0032)", async () => {
  const { calls, options } = await harness();
  const stages: string[] = [];
  options.lifecycle = {
    restartsInPlace: true,
    async snapshot() {
      calls.push("snapshot");
      return snapshot;
    },
    async pauseLaunches() {
      calls.push("pause");
    },
    async holdRunners() {
      calls.push("hold");
    },
    async stop(value) {
      expect(value).toBe(snapshot);
      calls.push("check");
    },
    async start(value, version) {
      expect(value).toBe(snapshot);
      calls.push(`restart:${version}`);
    },
    async probe(value, expected) {
      expect(value).toBe(snapshot);
      calls.push(`probe:${expected.version}`);
    },
    async resumeLaunches() {
      calls.push("resume");
    },
  };

  await expect(coordinateUpgrade(options, (stage) => stages.push(stage))).resolves.toMatchObject({
    status: "succeeded",
    version: "2.0.0",
  });
  expect(calls).toEqual([
    "prepare",
    "pause",
    "snapshot",
    "hold",
    "check",
    "activate:2.0.0",
    "restart:2.0.0",
    "probe:2.0.0",
    "resume",
  ]);
  expect(stages).toEqual([
    "Pausing new Workspace launches",
    "Holding Agent runners until they are idle",
    "Switching the active executable to 2.0.0",
    "Restarting Computer supervisor as 2.0.0; Workspace launches remain held (1 to resume, 1 stay stopped)",
    "Waiting for the Computer supervisor to report 2.0.0",
    "Computer supervisor 2.0.0 healthy; Workspace launches remain held",
    "Recording the terminal upgrade result before Workspace launch",
    "Resuming Workspace launches",
  ]);
});

test("an in-place rollback re-checks, restores, and restarts when the candidate restart fails (ADR 0032)", async () => {
  const { calls, options } = await harness();
  let starts = 0;
  options.lifecycle = {
    restartsInPlace: true,
    async snapshot() {
      calls.push("snapshot");
      return snapshot;
    },
    async pauseLaunches() {
      calls.push("pause");
    },
    async holdRunners() {
      calls.push("hold");
    },
    async stop(value) {
      expect(value).toBe(snapshot);
      calls.push("check");
    },
    async start(value, version) {
      expect(value).toBe(snapshot);
      starts += 1;
      calls.push(`restart:${version}`);
      if (starts === 1) throw new Error("kickstart never spawned the new process");
    },
    async probe(value, expected) {
      calls.push(`probe:${expected.version}`);
    },
    async resumeLaunches() {
      calls.push("resume");
    },
  };

  await expect(coordinateUpgrade(options)).rejects.toMatchObject({
    result: { status: "failed", restoredVersion: "1.0.0" },
  });
  expect(calls).toEqual([
    "prepare",
    "pause",
    "snapshot",
    "hold",
    "check",
    "activate:2.0.0",
    "restart:2.0.0",
    "check",
    "restore:1.0.0",
    "restart:1.0.0",
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
    expect((error as UpgradeCoordinatorError).result.errorCode).toBe("UPGRADE_ROLLBACK_FAILED");
  }
  expect(calls).not.toContain("resume");
});

test("a coordinator that exits without evidence does not strand the caller", async () => {
  const { options } = await harness();
  const { operation, paths } = split(options);
  // The Bun interpreter is not a release executable: __upgrade exits without a result.
  await expect(launchUpgradeCoordinator(operation, paths)).rejects.toThrow(
    "upgrade coordinator exited without a result",
  );
});

test("post-commit Workspace recovery failure exits non-zero and is not reported as clean success", async () => {
  // After the durable succeeded receipt is written, a stranded resume (or other Workspace
  // recovery fault) must not look like a clean CLI success: the coordinator exits 1 and
  // launchUpgradeCoordinator must surface that even though result.status is succeeded.
  const installRoot = await mkdtemp(join(tmpdir(), "coforge-recovery-exit-"));
  directories.push(installRoot);
  const requestId = crypto.randomUUID();
  const { resultPath } = upgradeReceiptPaths(installRoot, requestId);
  const stub = join(installRoot, "fake-upgrade-coordinator");
  await Bun.write(
    stub,
    `#!/usr/bin/env bun
import { mkdir, writeFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
const request = JSON.parse(await Bun.file(Bun.argv[Bun.argv.indexOf("--request") + 1]).text());
const result = {
  schema_version: 1,
  request_id: request.requestId,
  operation: request.operation,
  status: "succeeded",
  version: "2.0.0",
};
const temporary = request.resultPath + ".tmp";
await mkdir(dirname(request.resultPath), { recursive: true });
await writeFile(temporary, JSON.stringify(result) + "\\n");
await rename(temporary, request.resultPath);
process.exitCode = 1;
`,
  );
  await Bun.spawn(["chmod", "+x", stub]).exited;

  const operation: UpgradeOperation = {
    requestId,
    operation: "upgrade",
    selection: "2.0.0",
    origin: "cli",
  };
  await expect(
    launchUpgradeCoordinator(operation, {
      installRoot,
      binaryDirectory: join(installRoot, "bin"),
      target: "linux-x86_64",
      baseUrl: "https://example.invalid",
      supervisorSocketPath: join(installRoot, "supervisor.sock"),
      supervisorStatePath: join(installRoot, "state"),
      executablePath: stub,
    }),
  ).rejects.toMatchObject({
    name: "UpgradeCoordinatorError",
    message: "candidate committed; Workspace recovery failed",
    result: { status: "succeeded", version: "2.0.0" },
  });
  expect(await Bun.file(resultPath).exists()).toBe(true);
});

test("the durable request file carries the operation identity to the coordinator process", async () => {
  const { options, requestId } = await harness();
  const { operation, paths } = split(options);
  await launchUpgradeCoordinator(operation, paths).catch(() => {});
  const { requestPath } = upgradeReceiptPaths(options.installRoot, requestId);
  const written = (await Bun.file(requestPath).json()) as Record<string, unknown>;
  expect(written.requestId).toBe(requestId);
  expect(written.operation).toBe("upgrade");
  expect(written.origin).toBe("cli");
  expect(written.resultPath).toBe(upgradeReceiptPaths(options.installRoot, requestId).resultPath);
});

test("the coordinator never takes its operation identity from the environment", async () => {
  const { options, requestId } = await harness();
  const stale = "11111111-2222-4333-8444-555555555555";
  const previous = Bun.env.COFORGE_UPGRADE_REQUEST_ID;
  Bun.env.COFORGE_UPGRADE_REQUEST_ID = stale;
  try {
    const result = await coordinateUpgrade(options);
    expect(result.request_id).toBe(requestId);
    expect(result.request_id).not.toBe(stale);
    const { options: missing } = await harness();
    // @ts-expect-error the operation identity is mandatory; the environment cannot supply it.
    delete missing.requestId;
    await expect(coordinateUpgrade(missing)).rejects.toThrow("valid UUID request ID");
  } finally {
    if (previous === undefined) delete Bun.env.COFORGE_UPGRADE_REQUEST_ID;
    else Bun.env.COFORGE_UPGRADE_REQUEST_ID = previous;
  }
});

function split(options: UpgradeCoordinatorOptions) {
  const {
    lifecycle: _lifecycle,
    updater: _updater,
    requestId,
    operation: kind,
    selection,
    origin,
    quiet,
    localDirectory,
    ...paths
  } = options;
  const operation: UpgradeOperation = {
    requestId,
    operation: kind,
    selection,
    origin,
    quiet,
    ...(localDirectory ? { localDirectory } : {}),
  };
  return { operation, paths: { ...paths, executablePath: process.execPath } };
}

test("the runner hold completes before the supervisor is stopped", async () => {
  const { calls, options } = await harness();
  let holdFinished = false;
  let stoppedBeforeHold = false;
  const lifecycle = options.lifecycle!;
  options.lifecycle = {
    ...lifecycle,
    async holdRunners() {
      await lifecycle.holdRunners();
      // A real hold parks here for up to UPGRADE_RUNNER_HOLD_MS while Agents drain.
      await Bun.sleep(20);
      holdFinished = true;
    },
    async stop(value) {
      if (!holdFinished) stoppedBeforeHold = true;
      await lifecycle.stop(value);
    },
  };

  await expect(coordinateUpgrade(options)).resolves.toMatchObject({ status: "succeeded" });
  expect(stoppedBeforeHold).toBe(false);
  expect(calls.indexOf("hold")).toBeLessThan(calls.indexOf("stop"));
});
