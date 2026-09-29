import type { DaemonConnectionClient } from "#src/connection/daemon-connection";
import { DaemonConnectionRefusedError } from "#src/connection/daemon-connection-refused-error";
import type { DaemonConnectRejectionReason } from "@lrm/coforge-sdk/internal";
import { join } from "node:path";
import { LaunchdJob } from "#src/platform/launchd-job";

/** Files a test writes into the Workspace state directory to make the cloud refuse this
 * Workspace for good: on the next connect, or while it is connected. */
export const REFUSE_ON_START_FILE = "refuse-on-start";
export const REFUSE_NOW_FILE = "refuse-now";

/** Cloud acceptance is covered separately; native lifecycle tests stay offline. */
export class DaemonConnection implements DaemonConnectionClient {
  #job: LaunchdJob | undefined;
  #refused: ((reason: DaemonConnectRejectionReason) => void) | undefined;
  #watch: ReturnType<typeof setInterval> | undefined;
  onConnectionRefused(callback: (reason: DaemonConnectRejectionReason) => void) {
    this.#refused = callback;
    return () => {
      if (this.#refused === callback) this.#refused = undefined;
    };
  }
  async start() {
    const home = Bun.env.COFORGE_DAEMON_HOME!;
    if (await Bun.file(join(home, REFUSE_ON_START_FILE)).exists())
      throw new DaemonConnectionRefusedError("workspace_deleted");
    const path = join(home, "native-ready.json");
    const previous = (await Bun.file(path).exists()) ? await Bun.file(path).json() : undefined;
    let predecessorAlive = false;
    if (previous) {
      try {
        process.kill(previous.agentPid, 0);
        predecessorAlive = true;
      } catch {}
    }
    // Models an OS-owned residual root whose relay never reached connection.
    // Unlike the connected-owner fixture this cannot clean itself on socket loss.
    this.#job = new LaunchdJob({
      label: `${Bun.env.COFORGE_WORKSPACE_AGENT_PREFIX}${crypto.randomUUID()}`,
      directory: Bun.env.COFORGE_WORKSPACE_JOB_DIRECTORY!,
      command: ["/bin/sleep", "300"],
    });
    const identity = await this.#job.ensureStarted();
    await Bun.write(
      path,
      JSON.stringify({ workspacePid: process.pid, agentPid: identity.mainPid, predecessorAlive }),
    );
    this.#watch = setInterval(async () => {
      if (!(await Bun.file(join(home, REFUSE_NOW_FILE)).exists())) return;
      clearInterval(this.#watch);
      this.#refused?.("workspace_deleted");
    }, 25);
  }
  async ready() {}
  async stop() {
    clearInterval(this.#watch);
    await this.#job?.stop();
  }
}
export const defaultCentrifugeWorkspaceClientFactory = undefined;
