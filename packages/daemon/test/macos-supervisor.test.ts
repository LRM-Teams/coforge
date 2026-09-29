import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { DaemonCommandRejectedError, LocalDaemonLauncher } from "#src/daemon-host/launcher";
import {
  WorkspaceHealthJournal,
  workspaceHealthJournalPath,
} from "#src/supervisor/workspace-health-journal";
import { workspaceStateDirectory } from "#src/supervisor/workspace-instance";

/** What a Workspace writes to its `native-ready.json`. */
type NativeReady = { workspacePid: number; agentPid: number; predecessorAlive: boolean };

/** Reads one readiness file, or `undefined` while it is absent or half-written. The connection
 * fixture writes this file with a plain `Bun.write`, which is not atomic, so a read can land on a
 * partial document while it is being rewritten. "Not rewritten yet" is the normal state a poll sees,
 * not a failure — an unguarded `.json()` there turns a rewrite into a JSON parse error. */
async function readNativeReady(path: string): Promise<NativeReady | undefined> {
  try {
    return (await Bun.file(path).json()) as NativeReady;
  } catch {
    return undefined;
  }
}

/** Polls a readiness file until `accepts` holds, or the deadline passes with `message`. */
async function waitForNativeReady(
  path: string,
  accepts: (ready: NativeReady) => boolean,
  deadline: number,
  message: string,
): Promise<NativeReady> {
  while (true) {
    const ready = await readNativeReady(path);
    if (ready && accepts(ready)) return ready;
    if (Date.now() >= deadline) throw new Error(message);
    await Bun.sleep(25);
  }
}

test("a half-written readiness file reads as not-yet-ready rather than a parse error", async () => {
  const directory = await mkdtemp("/tmp/cf-ready-");
  const path = join(directory, "native-ready.json");
  try {
    // Mid-`Bun.write`, exactly what a poll can observe.
    await Bun.write(path, '{"workspacePid":12');
    expect(await readNativeReady(path)).toBeUndefined();
    // The wait gives up on its own message, not on the JSON parse error underneath it.
    await expect(
      waitForNativeReady(path, () => true, Date.now() + 60, "Workspace A did not report readiness"),
    ).rejects.toThrow("Workspace A did not report readiness");

    await Bun.write(
      path,
      JSON.stringify({ workspacePid: 4242, agentPid: 7, predecessorAlive: false }),
    );
    await expect(
      waitForNativeReady(
        path,
        (ready) => ready.workspacePid === 4242,
        Date.now() + 60,
        "unreachable",
      ),
    ).resolves.toEqual({ workspacePid: 4242, agentPid: 7, predecessorAlive: false });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "darwin")(
  "compiled macOS Coordinator configures two Workspaces and preserves scoped restart and stop across recovery",
  async () => {
    const root = await mkdtemp("/private/tmp/cf-mac-");
    // Real Daemon runtime and local RPC; only the cloud transport and inventory
    // are fixtures. No credentials, live cloud registrations or user jobs touched.
    const serverUrl = "http://127.0.0.1:1";
    const executable = join(root, "computer");
    const build = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "fixtures/build-macos-computer.ts"),
        executable,
        serverUrl,
      ],
      { stdout: "inherit", stderr: "inherit" },
    );
    expect(await build.exited).toBe(0);
    const socketPath = join(root, "daemon.sock");
    const spawn = () =>
      Bun.spawn([executable, "__daemon", "--socket", socketPath, "--state-directory", root], {
        stdout: "ignore",
        stderr: "inherit",
      });
    let coordinator = spawn();
    const client = new LocalDaemonLauncher({
      executablePath: executable,
      socketPath,
      stateDirectory: root,
      serverUrl,
    });
    try {
      await client.ensureRunning();
      const configure = (workspaceId: string) =>
        client.ensureStarted({
          workspaceId,
          computerId: "fixture-computer",
          workspaceRoot: join(root, "data"),
          daemonApiKey: "fixture-only",
          serverHttpUrl: serverUrl,
        });
      await configure("a");
      const [a] = await client.control("snapshot");
      expect(a?.processId).toBeGreaterThan(0);
      await configure("b");
      const both = await client.control("snapshot");
      expect(both[0]).toEqual(a!);
      const b = both[1]!;
      await client.control("restart", "a", "restart-a");
      const restarted = await client.control("snapshot");
      expect(restarted[0]?.processId).not.toBe(a?.processId);
      expect(restarted[0]?.instanceId).not.toBe(a?.instanceId);
      expect(restarted[1]).toEqual(b);
      await client.control("restart", "a", "restart-a");
      expect(await client.control("snapshot")).toEqual(restarted);
      await client.control("stop", "a");
      const stopped = await client.control("snapshot");
      expect(stopped[0]).toMatchObject({ enabled: false, processId: 0 });
      expect(stopped[1]).toEqual(b);
      coordinator.kill("SIGKILL");
      await coordinator.exited;
      coordinator = spawn();
      await client.ensureRunning();
      expect(await client.control("snapshot")).toEqual(stopped);
      const bReadyPath = join(root, "workspaces", "Yg", "native-ready.json");
      const oldB = await waitForNativeReady(
        bReadyPath,
        () => true,
        Date.now() + 30_000,
        "Workspace B never reported readiness",
      );
      // Restore A as a live peer, then crash only B. The replacement is owned
      // by launchd, not an explicit Coordinator restart operation.
      await client.control("start", "a");
      const peer = (await client.control("snapshot"))[0]!;
      // `start` returns once A's local RPC answers, which is before A rewrites native-ready.json
      // (see the B recovery loop below); until then the file still names the Agent `stop` ended.
      const aReadyPath = join(root, "workspaces", "YQ", "native-ready.json");
      const peerDeadline = Date.now() + 30_000;
      const peerAgent = await waitForNativeReady(
        aReadyPath,
        (ready) => ready.workspacePid === peer.processId,
        peerDeadline,
        "Workspace A did not report readiness",
      );
      process.kill(b.processId, "SIGKILL");
      const replacementClient = new LocalDaemonLauncher({
        executablePath: executable,
        socketPath: join(root, "workspaces", "Yg", "daemon.sock"),
        serverUrl,
        spawn: () => {},
      });
      const deadline = Date.now() + 30_000;
      let replacement: NativeReady | undefined;
      while (true) {
        const identity = await replacementClient.identity().catch(() => null);
        // The local RPC socket now opens before the Workspace finishes starting (readiness must
        // not wait on Code Agent discovery), so a fresh identity does not yet guarantee
        // native-ready.json has caught up; poll it too.
        if (identity && identity.processId !== b.processId) {
          const candidate = await readNativeReady(bReadyPath);
          if (candidate && candidate.workspacePid !== oldB.workspacePid) {
            replacement = candidate;
            break;
          }
        }
        if (Date.now() >= deadline) throw new Error("Workspace did not recover after crash");
        await Bun.sleep(25);
      }
      expect(replacement.workspacePid).not.toBe(oldB.workspacePid);
      expect(replacement.predecessorAlive).toBe(false);
      expect(() => process.kill(oldB.agentPid, 0)).toThrow();
      expect((await client.control("snapshot"))[0]).toEqual(peer);
      expect(() => process.kill(peerAgent.agentPid, 0)).not.toThrow();
    } finally {
      await client.control("stop").catch(() => {});
      coordinator.kill("SIGTERM");
      await coordinator.exited;
      await rm(root, { recursive: true, force: true });
    }
  },
  90_000,
);

test.skipIf(process.platform !== "darwin")(
  "a degraded Workspace fails fast on Coordinator recovery instead of stalling the readiness budget",
  async () => {
    const root = await mkdtemp("/private/tmp/cf-mac-degraded-");
    const serverUrl = "http://127.0.0.1:1";
    const executable = join(root, "computer");
    const build = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "fixtures/build-macos-computer.ts"),
        executable,
        serverUrl,
      ],
      { stdout: "inherit", stderr: "inherit" },
    );
    expect(await build.exited).toBe(0);
    const socketPath = join(root, "daemon.sock");
    const spawn = () =>
      Bun.spawn([executable, "__daemon", "--socket", socketPath, "--state-directory", root], {
        stdout: "ignore",
        stderr: "inherit",
      });
    let coordinator = spawn();
    const client = new LocalDaemonLauncher({
      executablePath: executable,
      socketPath,
      stateDirectory: root,
      serverUrl,
    });
    try {
      await client.ensureRunning();
      await client.ensureStarted({
        workspaceId: "a",
        computerId: "fixture-computer",
        workspaceRoot: join(root, "data"),
        daemonApiKey: "fixture-only",
        serverHttpUrl: serverUrl,
      });
      const running = (await client.control("snapshot"))[0]!;
      expect(running.processId).toBeGreaterThan(0);

      // Latch degraded the same way a real terminal condition or a crash-budget breach would,
      // then force the live child to die so launchd's own KeepAlive respawns it - the replacement
      // observes the latch and self-exits 0 immediately (`guardWorkspaceRunnerStart`), leaving the
      // launchd job inactive, exactly like a real crash loop's final generation.
      const journal = new WorkspaceHealthJournal(
        workspaceHealthJournalPath(workspaceStateDirectory(root, "a")),
      );
      await journal.markTerminal("test: simulated unrecoverable condition");
      const degradedLogPath = join(
        workspaceStateDirectory(root, "a"),
        "logs",
        "daemon",
        "daemon.jsonl",
      );
      const degradedExits = async () =>
        (
          await Bun.file(degradedLogPath)
            .text()
            .catch(() => "")
        )
          .split("\n")
          .filter((line) => line.includes('"daemon:workspace_degraded"')).length;
      const exitsBeforeCrash = await degradedExits();
      process.kill(running.processId, "SIGKILL");
      // The replacement launchd spawns under KeepAlive logs this before exiting 0, so a new
      // entry is the observable proof that launchd noticed the death, respawned, and that
      // replacement actually reached the latch - none of which a fixed sleep would establish.
      const respawnDeadline = Date.now() + 20_000;
      while ((await degradedExits()) === exitsBeforeCrash) {
        if (Date.now() >= respawnDeadline)
          throw new Error("Replacement Workspace never refused to start on the degraded latch");
        await Bun.sleep(25);
      }
      // ...and it exited rather than staying up: the killed process is gone and the latch's
      // refusal left no live Workspace behind it.
      expect(() => process.kill(running.processId, 0)).toThrow();

      coordinator.kill("SIGKILL");
      await coordinator.exited;
      coordinator = spawn();

      // Before the fix, the Coordinator's own local RPC did not open until `recover()` finished
      // waiting out the full ~30s per-binding readiness budget for the degraded Workspace, so the
      // client's own handshake (a separate, shorter timeout) gave up first with a misleading
      // "did not accept the local handshake" message that never named the real reason. Recovery
      // must now complete - and the Coordinator's local RPC become reachable - well under that,
      // so this asserts on a generous but much tighter bound than the old failure mode.
      const start = Date.now();
      await client.ensureRunning();
      expect(Date.now() - start).toBeLessThan(10_000);

      const snapshot = await client.control("snapshot");
      expect(snapshot[0]).toMatchObject({ workspaceId: "a", processId: 0 });
      // The fast-fail refusal never touches the latch: only an explicit operator start/restart
      // clears it (`MachineSupervisor.command`).
      expect(await journal.state()).toMatchObject({
        status: "degraded",
        reason: "test: simulated unrecoverable condition",
      });

      // An explicit operator restart is still the way out: it clears the latch and the
      // replacement starts normally.
      await client.control("restart", "a", "recover-a");
      const recovered = await client.control("snapshot");
      expect(recovered[0]?.processId).toBeGreaterThan(0);
      expect(await journal.state()).toEqual({ status: "ok" });
    } finally {
      await client.control("stop").catch(() => {});
      coordinator.kill("SIGTERM");
      await coordinator.exited;
      await rm(root, { recursive: true, force: true });
    }
  },
  60_000,
);

test.skipIf(process.platform !== "darwin")(
  "a parked Workspace stays down through a crash and a Coordinator restart while the other Workspace runs, until setup configures it again",
  async () => {
    const root = await mkdtemp("/private/tmp/cf-mac-parked-");
    const serverUrl = "http://127.0.0.1:1";
    const executable = join(root, "computer");
    const build = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "fixtures/build-macos-computer.ts"),
        executable,
        serverUrl,
      ],
      { stdout: "inherit", stderr: "inherit" },
    );
    expect(await build.exited).toBe(0);
    const socketPath = join(root, "daemon.sock");
    const spawn = () =>
      Bun.spawn([executable, "__daemon", "--socket", socketPath, "--state-directory", root], {
        stdout: "ignore",
        stderr: "inherit",
      });
    let coordinator = spawn();
    const client = new LocalDaemonLauncher({
      executablePath: executable,
      socketPath,
      stateDirectory: root,
      serverUrl,
    });
    const configure = (workspaceId: string) =>
      client.ensureStarted({
        workspaceId,
        computerId: "fixture-computer",
        workspaceRoot: join(root, `data-${workspaceId}`),
        daemonApiKey: "fixture-only",
        serverHttpUrl: serverUrl,
      });
    const processIds = async () =>
      Object.fromEntries(
        (await client.control("snapshot")).map((runtime) => [
          runtime.workspaceId,
          runtime.processId,
        ]),
      );
    try {
      await client.ensureRunning();
      await configure("gone");
      await configure("live");
      const before = await processIds();

      // The cloud refused "gone" for good: park it the way the Workspace process does, then kill
      // the running child so launchd respawns it. The replacement reads the park, logs it, and
      // exits 0, which ends launchd's KeepAlive for that job.
      const journal = new WorkspaceHealthJournal(
        workspaceHealthJournalPath(workspaceStateDirectory(root, "gone")),
      );
      await journal.markParked("workspace_deleted");
      const logPath = join(workspaceStateDirectory(root, "gone"), "logs", "daemon", "daemon.jsonl");
      const parkedExits = async () =>
        (
          await Bun.file(logPath)
            .text()
            .catch(() => "")
        )
          .split("\n")
          .filter((line) => line.includes('"daemon:workspace_parked"')).length;
      process.kill(before.gone!, "SIGKILL");
      const deadline = Date.now() + 20_000;
      while ((await parkedExits()) === 0) {
        if (Date.now() >= deadline) throw new Error("Replacement Workspace never parked");
        await Bun.sleep(25);
      }

      coordinator.kill("SIGKILL");
      await coordinator.exited;
      coordinator = spawn();
      await client.ensureRunning();
      expect(await processIds()).toMatchObject({ gone: 0, live: before.live });

      // start and restart refuse the parked Workspace with its stable reason on the wire and never
      // lift the park; the unscoped start still reaches the other Workspace.
      for (const operation of ["start", "restart"] as const) {
        const refusal = await client.control(operation, "gone").then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(refusal).toBeInstanceOf(DaemonCommandRejectedError);
        expect(refusal).toMatchObject({ code: "workspace_deleted" });
        expect((refusal as Error).message).toContain("Workspace gone was deleted in CoForge");
      }
      await expect(client.control("start")).rejects.toMatchObject({ code: "workspace_deleted" });
      expect(await processIds()).toMatchObject({ gone: 0, live: before.live });
      expect(await journal.state()).toMatchObject({
        status: "parked",
        reason: "workspace_deleted",
      });

      // Setup attaching the Workspace again is what lifts the park.
      await configure("gone");
      expect((await processIds()).gone).toBeGreaterThan(0);
      expect(await journal.state()).toEqual({ status: "ok" });
    } finally {
      await client.control("stop").catch(() => {});
      coordinator.kill("SIGTERM");
      await coordinator.exited;
      await rm(root, { recursive: true, force: true });
    }
  },
  90_000,
);
