import { dirname, join } from "node:path";
import { LaunchdJob, stopLaunchdJobs } from "../platform/launchd-job";
import {
  validateWorkspaceEndpoint,
  type WorkspaceInstance,
  type WorkspaceInstanceConfig,
} from "./workspace-instance";

/** The single source of truth for a Workspace's launchd identity: every OS label derived from a
 * Workspace (its own `cn.coforge.workspace.<identity>` job and its Agents' `cn.coforge.agent.
 * <identity>.*` jobs) must go through this function rather than recomputing the hash elsewhere,
 * so a read-only observer (e.g. `coforge-computer status`) can reliably correlate OS jobs back to
 * a Workspace binding. */
export function workspaceLaunchdIdentity(stateRoot: string, workspaceId: string): string {
  return new Bun.CryptoHasher("sha256")
    .update(`${stateRoot}\0${workspaceId}`)
    .digest("hex")
    .slice(0, 24);
}

export class LaunchdWorkspaceInstance implements WorkspaceInstance {
  readonly #job: LaunchdJob;
  readonly #agentPrefix: string;
  readonly #agentDirectory: string;
  constructor(config: WorkspaceInstanceConfig) {
    validateWorkspaceEndpoint(config.daemonConnectionEndpoint);
    const identity = workspaceLaunchdIdentity(config.stateRoot, config.workspaceId);
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
          ? {
              COFORGE_SUPERVISOR_SOCKET: config.supervisorSocketPath,
              COFORGE_SUPERVISOR_STATE_PATH: join(
                dirname(config.supervisorSocketPath),
                "upgrade-request-ids.json",
              ),
            }
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
