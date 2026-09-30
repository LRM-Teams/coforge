import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getLogger } from "@logtape/logtape";
import { coordinatorServiceName, createDaemonHost } from "@lrm/coforge-daemon";

import { createSupervisorControl, type SupervisorControlOptions } from "./supervisor-control";

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

/** Windows only: after schtasks /End, force the owner PID down and remove the lock marker.
 * `/End` often returns success while the Coordinator keeps running, which otherwise burns the
 * full 35s wait and fails the upgrade with "old supervisor did not confirm process-tree shutdown". */
async function windowsForceClearSupervisorLockOwner(ownerPath: string): Promise<void> {
  try {
    const text = (await Bun.file(ownerPath).text()).trim();
    const pid = Number(text);
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  } catch {
    // unreadable owner — still remove the marker below
  }
  await rm(ownerPath, { force: true });
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

export type SupervisorUpgradeIntegrationOptions = SupervisorControlOptions & {
  installRoot: string;
  /** Internal host-adapter seam used by native integration tests. Production omits these values. */
  serviceName?: string;
  homeDirectory?: string;
  runtimeHomeDirectory?: string;
};

/** `<state>/launch-hold`: the owning request ID and a newline. The Coordinator refuses to launch
 * Workspaces while it exists and reads the trimmed ID back; see installer/contract/launch-hold.txt. */
export function launchHoldContents(requestId: string): string {
  return `${requestId}\n`;
}

export function createSupervisorUpgradeLifecycle(
  options: SupervisorUpgradeIntegrationOptions,
): UpgradeLifecycle {
  const executablePath = join(
    options.installRoot,
    "active",
    process.platform === "win32" ? "coforge-computer.exe" : "coforge-computer",
  );
  const supervisorControl = createSupervisorControl(options);
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
  const coordinatorLabel = options.serviceName ?? coordinatorServiceName(process.platform);
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
      const status = supervisorWasRunning
        ? await supervisorControl.runningStatus()
        : await supervisorControl.persistedStatus();
      if (status.problems.length) {
        const messages = status.problems.map((problem) => problem.message).join(" ");
        throw new Error(
          supervisorWasRunning ? `Workspace runtime set is unhealthy: ${messages}` : messages,
        );
      }
      if (status.supervisor.running) previousSupervisorId = status.supervisor.id;
      return {
        bindings: status.bindings.map(({ bindingId, running, processId }) => ({
          bindingId,
          running,
          processId,
        })),
        supervisorRunning: supervisorWasRunning,
      };
    },
    async pauseLaunches(requestId) {
      await mkdir(options.supervisorStatePath, { recursive: true, mode: 0o700 });
      await writeFile(holdPath, launchHoldContents(requestId), { mode: 0o600 });
      supervisorWasRunning = await supervisorControl.isRunning();
      if (!supervisorWasRunning) return;
      try {
        await supervisorControl.pause(requestId);
      } catch (error) {
        // This transaction owns the pause: undo it, hold file included, before reporting.
        await this.resumeLaunches(requestId).catch(() => {});
        throw error;
      }
    },
    async holdRunners() {
      if (!supervisorWasRunning) return;
      await supervisorControl.hold();
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
      // Windows: give schtasks /End a short grace, then SIGKILL the lock owner. Other platforms
      // keep waiting for a clean owner removal as before.
      const windowsForceAfter = process.platform === "win32" ? Date.now() + 3_000 : null;
      while (await Bun.file(ownerPath).exists()) {
        if (process.platform === "win32" && !(await windowsSupervisorLockOwnerAlive(ownerPath))) {
          await rm(ownerPath, { force: true });
          break;
        }
        if (windowsForceAfter !== null && Date.now() >= windowsForceAfter) {
          logger.warn(
            "Windows Coordinator still held supervisor.lock after schtasks /End; forcing",
            {
              event: "upgrade:coordinator_stop_forced",
              label: coordinatorLabel,
              operation: "stop",
            },
          );
          await windowsForceClearSupervisorLockOwner(ownerPath);
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
      const supervisor = await supervisorControl.identity();
      if (supervisor.id === previousSupervisorId || supervisor.version !== expected.version)
        throw new Error("supervisor replacement identity/version mismatch");
    },
    async resumeLaunches(requestId) {
      if (supervisorWasRunning) await supervisorControl.resume(requestId);
      await rm(holdPath, { force: true });
    },
  };
}
