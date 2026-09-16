import type { DaemonCommandRunner } from "@lrm/coforge-daemon";
import type { Logger } from "@logtape/logtape";
import type { ManagedRuntimeIdentity } from "@lrm/coforge-sdk/internal";

export function createCommand(input: {
  daemon: DaemonCommandRunner;
  logger?: Logger;
  resolveWorkspace?: (selector: string) => Promise<string>;
}): {
  start(workspace?: string): Promise<void>;
  stop(workspace?: string): Promise<void>;
  /** Resolves with the post-restart snapshot of every locally registered binding, so a caller can
   * report which ones an unscoped restart left stopped because they were disabled. */
  restart(workspace?: string): Promise<ManagedRuntimeIdentity[]>;
} {
  const scope = (workspace?: string) =>
    workspace && input.resolveWorkspace ? input.resolveWorkspace(workspace) : workspace;
  return {
    async start(workspace) {
      input.logger?.info("Computer start requested", { event: "computer:starting" });
      await input.daemon.ensureRunning();
      await input.daemon.command("start", await scope(workspace));
      input.logger?.info("Computer start completed", { event: "computer:started" });
    },
    async stop(workspace) {
      input.logger?.info("Computer stop requested", { event: "computer:stopping" });
      await input.daemon.ensureRunning();
      await input.daemon.command("stop", await scope(workspace));
      input.logger?.info("Computer stop completed", { event: "computer:stopped" });
    },
    async restart(workspace) {
      input.logger?.info("Computer restart requested", { event: "computer:restarting" });
      await input.daemon.ensureRunning();
      const runtimes = await input.daemon.command("restart", await scope(workspace));
      input.logger?.info("Computer restart completed", { event: "computer:restarted" });
      return runtimes;
    },
  };
}
