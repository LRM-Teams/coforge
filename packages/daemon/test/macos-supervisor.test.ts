import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { LocalDaemonLauncher } from "../src/daemon-host/launcher";

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
