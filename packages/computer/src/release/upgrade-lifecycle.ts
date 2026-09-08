import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createDaemonHost, LocalDaemonLauncher } from "@coforge/daemon";

export type ManagedRuntimeBinding = {
  bindingId: string;
  running: boolean;
  processId: number | null;
};

export type ManagedRuntimeSnapshot = {
  bindings: readonly ManagedRuntimeBinding[];
};

export type UpgradeProbe = {
  version: string;
  previousProcessIds: readonly number[];
};

/** Machine lifecycle boundary implemented by the Computer supervisor integration. `stop` must
 * stop the old supervisor, daemon, and Agent process trees; `probe` must reject a wrong version,
 * a missing previously-running binding, or reuse of an old process ID. */
export interface UpgradeLifecycle {
  snapshot(): Promise<ManagedRuntimeSnapshot>;
  pauseLaunches(): Promise<void>;
  stop(snapshot: ManagedRuntimeSnapshot): Promise<void>;
  start(snapshot: ManagedRuntimeSnapshot, version: string): Promise<void>;
  probe(snapshot: ManagedRuntimeSnapshot, expected: UpgradeProbe): Promise<void>;
  resumeLaunches(): Promise<void>;
}

export type SupervisorUpgradeIntegrationOptions = {
  installRoot: string;
  supervisorSocketPath: string;
  supervisorStatePath: string;
  /** Internal host-adapter seam used by native integration tests. Production omits these values. */
  serviceName?: string;
  homeDirectory?: string;
  runtimeHomeDirectory?: string;
};

export function createSupervisorUpgradeLifecycle(
  options: SupervisorUpgradeIntegrationOptions,
): UpgradeLifecycle {
  const executablePath = join(
    options.installRoot,
    "active",
    process.platform === "win32" ? "coforge-computer.exe" : "coforge-computer",
  );
  const local = new LocalDaemonLauncher({
    executablePath,
    socketPath: options.supervisorSocketPath,
    stateDirectory: options.supervisorStatePath,
    spawn: () => {},
  });
  const host = createDaemonHost({
    platform: process.platform,
    executablePath,
    socketPath: options.supervisorSocketPath,
    stateDirectory: options.supervisorStatePath,
    homeDirectory: options.homeDirectory ?? homedir(),
    uid: process.getuid?.() ?? 0,
    serviceName: options.serviceName,
    runtimeHomeDirectory: options.runtimeHomeDirectory,
  });
  const holdPath = join(options.supervisorStatePath, "launch-hold");
  let previousSupervisorId: string | undefined;
  let supervisorWasRunning = false;
  return {
    async snapshot() {
      if (!supervisorWasRunning) {
        const file = Bun.file(join(options.supervisorStatePath, "bindings.json"));
        const bindings = (await file.exists())
          ? ((await file.json()) as { workspaceId: string; enabled: boolean }[])
          : [];
        if (bindings.some((binding) => binding.enabled))
          throw new Error(
            "configured running bindings have no healthy supervisor; recover them before upgrading",
          );
        return {
          bindings: bindings.map((binding) => ({
            bindingId: binding.workspaceId,
            running: false,
            processId: null,
          })),
        };
      }
      const identities = await local.control("snapshot");
      if (identities.some((runtime) => runtime.enabled !== runtime.processId > 0))
        throw new Error("Workspace runtime set is unhealthy; recover it before upgrading");
      previousSupervisorId = (await local.identity()).daemonId;
      return {
        bindings: identities.map((runtime) => ({
          bindingId: runtime.workspaceId,
          running: runtime.processId > 0,
          processId: runtime.processId || null,
        })),
      };
    },
    async pauseLaunches() {
      await mkdir(options.supervisorStatePath, { recursive: true, mode: 0o700 });
      await writeFile(holdPath, "upgrade\n", { mode: 0o600 });
      supervisorWasRunning = await local.identity().then(
        () => true,
        () => false,
      );
      if (supervisorWasRunning) await local.control("pause");
    },
    async stop() {
      if (!supervisorWasRunning) return;
      await host.stop().catch((error) => {
        throw new Error(
          "Cannot upgrade a foreground externally supervised Computer while it is running. Stop it through its external supervisor before upgrading, or install the supported user service.",
          { cause: error },
        );
      });
      const deadline = Date.now() + 35_000;
      while (
        await Bun.file(join(options.supervisorStatePath, "supervisor.lock", "owner")).exists()
      ) {
        if (Date.now() > deadline)
          throw new Error("old supervisor did not confirm process-tree shutdown");
        await Bun.sleep(50);
      }
    },
    async start() {
      if (!supervisorWasRunning) return;
      await host.ensureRunning();
    },
    async probe(snapshot, expected) {
      if (!supervisorWasRunning) {
        const probe = Bun.spawn([executablePath, "--cli-version"], {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "ignore",
          timeout: 10_000,
        });
        const version = (await new Response(probe.stdout).text()).trim();
        if ((await probe.exited) !== 0 || version !== expected.version)
          throw new Error("activated executable version probe failed");
        return;
      }
      const identity = await local.identity();
      if (identity.daemonId === previousSupervisorId || identity.version !== expected.version)
        throw new Error("supervisor replacement identity/version mismatch");
      const actual = await local.control("snapshot");
      if (
        actual.length !== snapshot.bindings.length ||
        snapshot.bindings.some((binding) => {
          const runtime = actual.find((value) => value.workspaceId === binding.bindingId);
          return (
            !runtime ||
            runtime.processId > 0 !== binding.running ||
            (binding.running &&
              (!runtime.instanceId ||
                runtime.version !== expected.version ||
                expected.previousProcessIds.includes(runtime.processId)))
          );
        })
      )
        throw new Error("Workspace replacement set/identity/version mismatch");
    },
    async resumeLaunches() {
      if (supervisorWasRunning) await local.control("resume");
      await rm(holdPath, { force: true });
    },
  };
}
