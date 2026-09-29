import {
  DaemonCommandRejectedError,
  workspaceParkedDescription,
  workspaceParkedRecovery,
  type DaemonCommandRunner,
} from "@lrm/coforge-daemon";
import type { Logger } from "@logtape/logtape";
import {
  isDaemonConnectRejectionReason,
  type ManagedRuntimeIdentity,
} from "@lrm/coforge-sdk/internal";
import { CliError } from "#src/errors";

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
   * report which ones an unscoped restart left stopped because they were disabled. */
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
      throw parkedWorkspaceError(error, local) ?? error;
    }
  };
  return {
    async start(workspace) {
      input.logger?.info("Computer start requested", { event: "computer:starting" });
      write("Starting CoForge...");
      await input.daemon.ensureRunning();
      await run("start", workspace);
      input.logger?.info("Computer start completed", { event: "computer:started" });
      write("CoForge Computer is online.");
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
      write(
        workspace
          ? `Workspace ${workspace} restarted and is back online.`
          : "CoForge Computer is back online.",
      );
      return runtimes;
    },
  };
}

/** The daemon refused because the cloud refused this Workspace for good. A scoped command knows
 * the Workspace's slug and so the exact setup command; an unscoped one keeps the daemon's
 * sentence, which names the Workspace id, and points at `status`. */
function parkedWorkspaceError(error: unknown, local: LocalWorkspace | undefined) {
  if (!(error instanceof DaemonCommandRejectedError)) return undefined;
  const reason = error.code;
  if (!isDaemonConnectRejectionReason(reason)) return undefined;
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
