import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getLogger } from "@logtape/logtape";
import {
  createDaemonHost,
  holdRunnersUntilQuiescent,
  LocalDaemonLauncher,
} from "@lrm/coforge-daemon";

const logger = getLogger(["coforge", "computer", "upgrade"]);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Windows only: true when supervisor.lock owner names a still-living process. Missing,
 * unreadable, or non-positive PIDs are treated as not alive so schtasks /End cannot wedge
 * upgrades. macOS/Linux keep waiting for the owner file to disappear on its own. */
async function windowsSupervisorLockOwnerAlive(ownerPath: string): Promise<boolean> {
  try {
    const text = (await Bun.file(ownerPath).text()).trim();
    const pid = Number(text);
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * What a person is told when the Computer supervisor could not be stopped for an upgrade.
 * `foregroundSupervised` is true only where CoForge has actually established that no user
 * service owns this Coordinator - launchd's `assertRestartable`. Everywhere else the platform
 * host already knows the real reason and says it in its own message, so repeating it is what
 * leaves a person something to act on; claiming foreground supervision instead is how a
 * `systemctl --user` refusal came to read as a problem it was not.
 */
export function coordinatorStopFailure(error: unknown, foregroundSupervised: boolean): Error {
  return new Error(
    foregroundSupervised
      ? `Cannot upgrade a foreground externally supervised Computer while it is running: ${errorMessage(error)} Stop it through its external supervisor before upgrading, or install the supported user service with \`coforge-computer start\`.`
      : `Cannot stop the Computer supervisor to upgrade it: ${errorMessage(error)}`,
    { cause: error },
  );
}

export type ManagedRuntimeBinding = {
  bindingId: string;
  running: boolean;
  processId: number | null;
};

export type ManagedRuntimeSnapshot = {
  bindings: readonly ManagedRuntimeBinding[];
  /** Whether the Computer supervisor was running when this snapshot was taken. When false,
   * `stop`/`start` are no-ops and there is no running process tree to restart or report on. */
  supervisorRunning: boolean;
};

export type UpgradeProbe = {
  version: string;
};

/** Machine lifecycle boundary implemented by the Computer supervisor integration. `stop` must
 * stop the old supervisor and daemon process tree; `probe` must reject a wrong Supervisor version
 * or reuse of the old Supervisor identity. Workspace children remain stopped under launch-hold
 * until the terminal receipt is committed and `resumeLaunches` reconciles them.
 *
 * When `restartsInPlace` is true (launchd), `stop` performs only the pre-switch
 * restartability check and `start` performs the in-place kickstart; neither one actually stops or
 * starts a process tree, so `switchStageText` (`upgrade-coordinator.ts`) must not describe them
 * as if they did. */
export interface UpgradeLifecycle {
  readonly restartsInPlace: boolean;
  snapshot(): Promise<ManagedRuntimeSnapshot>;
  pauseLaunches(requestId: string): Promise<void>;
  /** Stops every Agent admitting new turns and waits, bounded, for in-flight work to finish.
   * Always runs before `stop`; `resumeLaunches` lifts it if the upgrade aborts first. */
  holdRunners(): Promise<void>;
  stop(snapshot: ManagedRuntimeSnapshot): Promise<void>;
  start(snapshot: ManagedRuntimeSnapshot, version: string): Promise<void>;
  probe(snapshot: ManagedRuntimeSnapshot, expected: UpgradeProbe): Promise<void>;
  resumeLaunches(requestId: string): Promise<void>;
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
  // Diagnostic identity only, matching each host's own default label/unit/task name; never used
  // for control flow. The 2026-09-16 incident where the Coordinator was left unloaded after a
  // remote upgrade reported success had no record of what `stop`/`start` actually did.
  const coordinatorLabel =
    options.serviceName ??
    (process.platform === "linux"
      ? "coforge-daemon.service"
      : process.platform === "win32"
        ? "CoForge Daemon"
        : "cn.coforge.computer.daemon");
  let previousSupervisorId: string | undefined;
  let supervisorWasRunning = false;
  // Capability check, never an `instanceof`/platform branch: only `LaunchdDaemonHost`
  // declares this, so `host` narrows through the `in` checks below wherever it matters.
  const restartsInPlace = "restartsInPlace" in host && host.restartsInPlace === true;
  // Set once this upgrade has proven the label was loaded (the first, pre-activation `stop()`
  // call). A *second* `stop()` finding it not loaded is the rollback path re-entering after a
  // kickstart that never completed, not a foreground-supervised Computer that never had a
  // launchd job at all — `restart()`'s own bootstrap fallback recovers that, so it must not abort
  // the restore.
  let inPlaceRestartVerified = false;
  return {
    restartsInPlace,
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
          supervisorRunning: false,
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
        supervisorRunning: true,
      };
    },
    async pauseLaunches(requestId) {
      await mkdir(options.supervisorStatePath, { recursive: true, mode: 0o700 });
      await writeFile(holdPath, `${requestId}\n`, { mode: 0o600 });
      supervisorWasRunning = await local.identity().then(
        () => true,
        () => false,
      );
      if (supervisorWasRunning) await local.control("pause");
    },
    async holdRunners() {
      if (!supervisorWasRunning) return;
      const outcome = await holdRunnersUntilQuiescent({
        hold: async () => {
          const response = await local.hold("hold");
          if (!response.accepted) throw new Error("Coordinator did not accept the runner hold");
          return response;
        },
        // The wait itself now lives in the daemon package, shared with the Coordinator's restart
        // hold. Keep this path's own logger and `upgrade:` event names.
        logger,
        eventPrefix: "upgrade",
      });
      logger.info("Runner hold completed", {
        event: outcome.quiescent ? "upgrade:runner_hold_quiescent" : "upgrade:runner_hold_expired",
        label: coordinatorLabel,
        operation: "hold",
        quiescent: outcome.quiescent,
        elapsed_ms: outcome.elapsedMs,
        busy_agent_count: outcome.busyAgents.length,
        unreachable_workspace_ids: outcome.unreachableWorkspaceIds,
      });
    },
    async stop() {
      if (!supervisorWasRunning) return;
      if (restartsInPlace && "assertRestartable" in host) {
        logger.info("Checking the Computer coordinator can be restarted in place", {
          event: "upgrade:coordinator_stop_requested",
          label: coordinatorLabel,
          operation: "stop",
        });
        try {
          await host.assertRestartable();
          inPlaceRestartVerified = true;
        } catch (error) {
          if (inPlaceRestartVerified) {
            // Already proven loaded once this upgrade; a missing label now is the rollback
            // re-entering after a kickstart that never completed, which `restart()`'s own
            // bootstrap fallback recovers - not a foreground supervisor to refuse.
            logger.info(
              "Computer coordinator label is not currently loaded; restart will recreate it",
              {
                event: "upgrade:coordinator_stopped",
                label: coordinatorLabel,
                operation: "stop",
              },
            );
            return;
          }
          logger.error("Computer coordinator is not restartable in place", {
            event: "upgrade:coordinator_stop_failed",
            label: coordinatorLabel,
            operation: "stop",
            error_message: errorMessage(error),
          });
          throw coordinatorStopFailure(error, true);
        }
        logger.info("Computer coordinator is restartable in place", {
          event: "upgrade:coordinator_stopped",
          label: coordinatorLabel,
          operation: "stop",
        });
        return;
      }
      logger.info("Stopping Computer coordinator for upgrade", {
        event: "upgrade:coordinator_stop_requested",
        label: coordinatorLabel,
        operation: "stop",
      });
      await host.stop().catch((error) => {
        logger.error("Computer coordinator stop failed", {
          event: "upgrade:coordinator_stop_failed",
          label: coordinatorLabel,
          operation: "stop",
          error_message: errorMessage(error),
        });
        throw coordinatorStopFailure(error, false);
      });
      const ownerPath = join(options.supervisorStatePath, "supervisor.lock", "owner");
      const deadline = Date.now() + 35_000;
      while (await Bun.file(ownerPath).exists()) {
        // Windows: schtasks /End can kill the Coordinator without removing owner. Clear only a
        // dead PID there; other platforms wait for a clean owner removal as before.
        if (
          process.platform === "win32" &&
          !(await windowsSupervisorLockOwnerAlive(ownerPath))
        ) {
          await rm(ownerPath, { force: true });
          break;
        }
        if (Date.now() > deadline) {
          logger.error("Old Computer coordinator did not confirm shutdown", {
            event: "upgrade:coordinator_stop_failed",
            label: coordinatorLabel,
            operation: "stop",
            error_message: "old supervisor did not confirm process-tree shutdown",
          });
          throw new Error("old supervisor did not confirm process-tree shutdown");
        }
        await Bun.sleep(50);
      }
      logger.info("Computer coordinator stopped", {
        event: "upgrade:coordinator_stopped",
        label: coordinatorLabel,
        operation: "stop",
      });
    },
    async start() {
      if (!supervisorWasRunning) return;
      if (restartsInPlace && "restart" in host) {
        logger.info("Restarting Computer coordinator in place after upgrade", {
          event: "upgrade:coordinator_start_requested",
          label: coordinatorLabel,
          operation: "start",
        });
        try {
          await host.restart();
        } catch (error) {
          logger.error("Computer coordinator restart failed", {
            event: "upgrade:coordinator_start_failed",
            label: coordinatorLabel,
            operation: "start",
            error_message: errorMessage(error),
          });
          throw error;
        }
        logger.info("Computer coordinator restarted", {
          event: "upgrade:coordinator_started",
          label: coordinatorLabel,
          operation: "start",
        });
        return;
      }
      logger.info("Starting Computer coordinator after upgrade", {
        event: "upgrade:coordinator_start_requested",
        label: coordinatorLabel,
        operation: "start",
      });
      try {
        await host.ensureRunning();
      } catch (error) {
        logger.error("Computer coordinator start failed", {
          event: "upgrade:coordinator_start_failed",
          label: coordinatorLabel,
          operation: "start",
          error_message: errorMessage(error),
        });
        throw error;
      }
      logger.info("Computer coordinator started", {
        event: "upgrade:coordinator_started",
        label: coordinatorLabel,
        operation: "start",
      });
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
    },
    async resumeLaunches(requestId) {
      // Releasing first is what lifts a runner hold on an upgrade aborted before the stop. On the
      // success path the daemon answering here is a fresh process that was never held, and
      // `daemon:release` is idempotent, so the extra call is a no-op rather than a special case.
      if (supervisorWasRunning) {
        await local.hold("release").catch(() => {});
        await local.control("resume", undefined, requestId);
      }
      await rm(holdPath, { force: true });
    },
  };
}
