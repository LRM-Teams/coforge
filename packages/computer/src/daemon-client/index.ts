import {
  DaemonCommandRejectedError,
  workspaceParkedDescription,
  workspaceParkedRecovery,
  type DaemonCommandRunner,
} from "@lrm/coforge-daemon";
import type { Logger } from "@logtape/logtape";
import {
  isDaemonConnectRejectionReason,
  type DaemonConnectRejectionReason,
  type ManagedRuntimeIdentity,
} from "@lrm/coforge-sdk/internal";
import { CliError } from "#src/errors";
import { terminalText } from "#src/terminal-output";

/** A locally registered Workspace a `--workspace <slug-or-id>` selector names. */
export type LocalWorkspace = { id: string; slug: string };

export function createCommand(input: {
  daemon: DaemonCommandRunner;
  logger?: Logger;
  resolveWorkspace?: (selector: string) => Promise<LocalWorkspace>;
  /** Progress lines for the user's terminal, mirroring what `upgrade` already prints. Omit to
   * run silently (tests, internal callers); structured logging below is unaffected. */
  write?: (line: string) => void;
}): {
  start(workspace?: string): Promise<void>;
  stop(workspace?: string): Promise<void>;
  /** Resolves with the post-restart snapshot of every locally registered binding, so a caller can
   * report which ones an unscoped restart left stopped because they were disabled. Start and
   * restart reject with `WORKSPACE_NOT_CONNECTED` when a Workspace they started did not connect. */
  restart(workspace?: string): Promise<ManagedRuntimeIdentity[]>;
} {
  const resolve = async (workspace?: string) =>
    workspace && input.resolveWorkspace ? input.resolveWorkspace(workspace) : undefined;
  const write = input.write ?? (() => {});
  /** Runs one lifecycle command; a refusal for a parked Workspace becomes its stable CLI error. */
  const run = async (
    operation: "start" | "stop" | "restart",
    workspace: string | undefined,
  ): Promise<ManagedRuntimeIdentity[]> => {
    const local = await resolve(workspace);
    try {
      return await input.daemon.command(operation, local?.id ?? workspace);
    } catch (error) {
      if (
        !(error instanceof DaemonCommandRejectedError) ||
        !isDaemonConnectRejectionReason(error.code)
      )
        throw error;
      // The refusal names the parked Workspace, which an unscoped command did not.
      const id = error.workspaceId;
      const refused = !id || id === local?.id ? local : await resolve(id).catch(() => undefined);
      throw parkedWorkspaceError(error, error.code, refused);
    }
  };
  /**
   * "Online" only when every started Workspace connected. Otherwise the header, then one line per
   * Workspace still under way (with `status` to follow it) or that did not connect (with why), and
   * a failure naming the restart to run for each one that did not connect.
   */
  const report = async (
    operation: "start" | "restart",
    runtimes: readonly ManagedRuntimeIdentity[],
    online: string,
    pendingHeader: string,
  ) => {
    const unsettled = runtimes.filter(
      (runtime) => runtime.cloudConnection && runtime.cloudConnection !== "connected",
    );
    if (!unsettled.length) return write(online);
    write(pendingHeader);
    const failed: string[] = [];
    for (const runtime of unsettled) {
      const name = terminalText(
        (await resolve(runtime.workspaceId).catch(() => undefined))?.slug ?? runtime.workspaceId,
      );
      if (runtime.cloudConnection === "connecting") {
        const under = operation === "start" ? "still starting" : "still restarting";
        write(`  ${name}: ${under}. Run 'coforge-computer status' to follow it.`);
        continue;
      }
      failed.push(name);
      write(
        `  ${name}: not connected (${terminalText(runtime.cloudConnectionError ?? "unknown error")}).`,
      );
    }
    if (!failed.length) return;
    const restarts = failed.map((name) => `'coforge-computer restart --workspace ${name}'`);
    throw new CliError(
      "WORKSPACE_NOT_CONNECTED",
      failed.length === 1
        ? `Workspace ${failed[0]} did not connect to CoForge.`
        : `Workspaces ${failed.join(", ")} did not connect to CoForge.`,
      `Run ${restarts.join(" and ")} to try again, or 'coforge-computer status' to check ${failed.length === 1 ? "it" : "them"}.`,
    );
  };
  return {
    async start(workspace) {
      input.logger?.info("Computer start requested", { event: "computer:starting" });
      write("Starting CoForge...");
      await input.daemon.ensureRunning();
      const runtimes = await run("start", workspace);
      input.logger?.info("Computer start completed", { event: "computer:started" });
      await report(
        "start",
        runtimes,
        "CoForge Computer is online.",
        "CoForge Computer started, but not every Workspace is connected yet:",
      );
    },
    async stop(workspace) {
      input.logger?.info("Computer stop requested", { event: "computer:stopping" });
      await input.daemon.ensureRunning();
      await run("stop", workspace);
      input.logger?.info("Computer stop completed", { event: "computer:stopped" });
    },
    async restart(workspace) {
      input.logger?.info("Computer restart requested", { event: "computer:restarting" });
      write(workspace ? `Restarting Workspace ${workspace}...` : "Restarting CoForge...");
      await input.daemon.ensureRunning();
      const runtimes = await run("restart", workspace);
      input.logger?.info("Computer restart completed", { event: "computer:restarted" });
      await report(
        "restart",
        runtimes,
        workspace
          ? `Workspace ${workspace} restarted and is back online.`
          : "CoForge Computer is back online.",
        workspace
          ? `Workspace ${workspace} restarted, but is not connected yet:`
          : "CoForge Computer restarted, but not every Workspace is connected yet:",
      );
      return runtimes;
    },
  };
}

/** The daemon refused because the cloud refused this Workspace for good. With the Workspace's
 * local registration the error carries its slug and the exact commands; without one (no local
 * registration found) it keeps the daemon's sentence and points at `status`. */
function parkedWorkspaceError(
  error: DaemonCommandRejectedError,
  reason: DaemonConnectRejectionReason,
  local: LocalWorkspace | undefined,
): CliError {
  const code = reason.toUpperCase();
  if (!local)
    return new CliError(
      code,
      error.message,
      "Run 'coforge-computer status' to see which Workspace binding is parked and the command that moves on.",
      { cause: error },
    );
  const workspace = { workspaceId: local.id, workspaceSlug: local.slug };
  return new CliError(
    code,
    workspaceParkedDescription(reason, workspace),
    workspaceParkedRecovery(reason, workspace),
    { cause: error },
  );
}
