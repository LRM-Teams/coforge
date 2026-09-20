import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { LocalDaemonLauncher } from "../src/daemon-host/launcher";
import {
  WorkspaceHealthJournal,
  workspaceHealthJournalPath,
} from "../src/supervisor/workspace-health-journal";
import { workspaceStateDirectory } from "../src/supervisor/workspace-instance";

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
      const oldB = await Bun.file(bReadyPath).json();
      // Restore A as a live peer, then crash only B. The replacement is owned
      // by launchd, not an explicit Coordinator restart operation.
      await client.control("start", "a");
      const peer = (await client.control("snapshot"))[0]!;
      const peerAgent = await Bun.file(join(root, "workspaces", "YQ", "native-ready.json")).json();
      process.kill(b.processId, "SIGKILL");
      const replacementClient = new LocalDaemonLauncher({
        executablePath: executable,
        socketPath: join(root, "workspaces", "Yg", "daemon.sock"),
        serverUrl,
        spawn: () => {},
      });
      const deadline = Date.now() + 30_000;
      let replacement: typeof oldB | undefined;
      while (true) {
        const identity = await replacementClient.identity().catch(() => null);
        // The local RPC socket now opens before the Workspace finishes starting (readiness must
        // not wait on Code Agent discovery), so a fresh identity does not yet guarantee
        // native-ready.json has caught up; poll it too.
        if (identity && identity.processId !== b.processId) {
          const candidate = await Bun.file(bReadyPath).json();
          if (candidate.workspacePid !== oldB.workspacePid) {
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
      process.kill(running.processId, "SIGKILL");
      // Give launchd a moment to notice the death, respawn under KeepAlive, and let that
      // replacement run its guard check and exit 0 on its own.
      await Bun.sleep(3_000);

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
