import { join } from "node:path";
import { LaunchdJob, stopLaunchdJobs } from "../platform/launchd-job";
import {
  validateWorkspaceEndpoint,
  type WorkspaceInstance,
  type WorkspaceInstanceConfig,
} from "./workspace-instance";

export class LaunchdWorkspaceInstance implements WorkspaceInstance {
  readonly #job: LaunchdJob;
  readonly #agentPrefix: string;
  readonly #agentDirectory: string;
  constructor(config: WorkspaceInstanceConfig) {
    validateWorkspaceEndpoint(config.daemonConnectionEndpoint);
    const identity = new Bun.CryptoHasher("sha256")
      .update(`${config.stateRoot}\0${config.workspaceId}`)
      .digest("hex")
      .slice(0, 24);
    this.#agentPrefix = `cn.coforge.agent.${identity}.`;
    this.#agentDirectory = join(config.stateDirectory, "launchd-agents");
    this.#job = new LaunchdJob({
      label: `cn.coforge.workspace.${identity}`,
      directory: config.unitDirectory,
      command: [
        config.executablePath,
        "__workspace-daemon",
        "--socket",
        config.socketPath,
        "--state-directory",
        config.stateDirectory,
      ],
      restartOnFailure: true,
      environment: {
        COFORGE_DAEMON_HOME: config.stateDirectory,
        COFORGE_WORKSPACE_AGENT_PREFIX: this.#agentPrefix,
        COFORGE_WORKSPACE_JOB_DIRECTORY: this.#agentDirectory,
        ...(config.supervisorSocketPath
          ? { COFORGE_SUPERVISOR_SOCKET: config.supervisorSocketPath }
          : {}),
        ...(config.daemonConnectionEndpoint
          ? { COFORGE_DAEMON_CONNECTION_ENDPOINT: config.daemonConnectionEndpoint }
          : {}),
      },
    });
  }
  async ensureStarted(): Promise<number> {
    if (!(await this.#job.identity()))
      await stopLaunchdJobs(this.#agentPrefix, this.#agentDirectory);
    return (await this.#job.ensureStarted()).mainPid;
  }
  async stop(): Promise<void> {
    await this.#job.stop();
    await stopLaunchdJobs(this.#agentPrefix, this.#agentDirectory);
  }
  identity() {
    return this.#job.identity();
  }
}
