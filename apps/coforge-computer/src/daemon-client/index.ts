import type { DaemonCommandRunner, DaemonStopper } from "@coforge/daemon";
import type { Logger } from "@logtape/logtape";

export function createCommand(input: {
  daemon: DaemonCommandRunner & DaemonStopper;
  logger?: Logger;
}): {
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
} {
  return {
    async start() {
      input.logger?.info("Computer start requested", { event: "computer:starting" });
      await input.daemon.ensureRunning();
      await input.daemon.command("start");
      input.logger?.info("Computer start completed", { event: "computer:started" });
    },
    async stop() {
      input.logger?.info("Computer stop requested", { event: "computer:stopping" });
      await input.daemon.command("stop");
      await input.daemon.stop();
      input.logger?.info("Computer stop completed", { event: "computer:stopped" });
    },
    async restart() {
      input.logger?.info("Computer restart requested", { event: "computer:restarting" });
      await input.daemon.command("restart");
      input.logger?.info("Computer restart completed", { event: "computer:restarted" });
    },
  };
}
