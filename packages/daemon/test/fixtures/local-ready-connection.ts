import type { DaemonConnectionClient } from "../../src/connection/daemon-connection";
import { join } from "node:path";
import { LaunchdJob } from "../../src/platform/launchd-job";

/** Cloud acceptance is covered separately; native lifecycle tests stay offline. */
export class DaemonConnection implements DaemonConnectionClient {
  #job: LaunchdJob | undefined;
  async start() {
    const path = join(Bun.env.COFORGE_DAEMON_HOME!, "native-ready.json");
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
  }
  async ready() {}
  async stop() {
    await this.#job?.stop();
  }
}
export const defaultCentrifugeWorkspaceClientFactory = undefined;
