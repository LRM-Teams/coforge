import { homedir } from "node:os";
import { join } from "node:path";
import type { LocalInboxRequest } from "@coforge/protocol";
import { dispose, getLogger, withContext } from "@logtape/logtape";
import { startDaemonLocalRpcServer } from "./src/local-rpc";
import { startAgentProxy } from "./src/agent-proxy";
import { createAgentDriver } from "./src/code-agent/registry";
import { discoverCodeAgentInventory } from "./src/code-agent/runtime-inventory";
import { DaemonRuntime } from "./src/daemon-runtime/runtime";
import { FileDaemonCredentialStore } from "./src/credentials/credential-store";
import { DaemonConfigStore } from "./src/persistence/daemon-config";
import {
  DaemonConnection,
  defaultCentrifugeWorkspaceClientFactory,
} from "./src/connection/daemon-connection";
import { COFORGE_DAEMON_SERVER_URL, daemonConnectionEndpoint } from "./src/connection/built-server";
import { COFORGE_DAEMON_VERSION } from "./src/version";
import { LocalDaemonLauncher } from "./src/daemon-host/launcher";
import { configureDaemonLogging } from "./src/platform/daemon-logging";
import { stopLaunchdJobs } from "./src/platform/launchd-job";
export { runMachineSupervisor } from "./src/supervisor/run-supervisor";
export { runLaunchdAgent } from "./src/platform/launchd-process";

export type {
  AgentRuntimeConfig,
  AgentDriver,
  AgentDriverFactory,
  AgentSession,
  AgentSessionOptions,
} from "@coforge/agent";
export type { AgentRuntimeEvent, CodeAgentProvider } from "./src/code-agent/contract";
export { createAgentDriver } from "./src/code-agent/registry";
export { ClaudeCodeDriver } from "./src/code-agent/claude-code/driver";
export { CodexDriver } from "./src/code-agent/codex/driver";
export { readCodexUsage } from "./src/code-agent/codex/usage";
export { readClaudeCodeUsage } from "./src/code-agent/claude-code/usage";
export { PiDriver } from "./src/code-agent/pi/driver";
export { createDaemonHost } from "./src/daemon-host";
export { startDaemonLocalRpcServer } from "./src/local-rpc";
export { startAgentProxy } from "./src/agent-proxy";
export {
  LaunchdDaemonHost,
  launchdPlist,
  SystemdUserDaemonHost,
  systemdUserUnit,
  WindowsUserDaemonHost,
} from "./src/daemon-host";
export { LocalDaemonLauncher, resolveDaemonExecutablePath } from "./src/daemon-host/launcher";
export { acquireProcessLock } from "./src/platform/process-lock";
export type { ProcessLock } from "./src/platform/process-lock";
export type {
  DaemonLauncher,
  DaemonCommandRunner,
  DaemonWorkspaceConfig,
} from "./src/daemon-host/launcher";
export { DaemonConfigStore } from "./src/persistence/daemon-config";
export { AgentProcessManager } from "./src/agent-runtime/agent-process-manager";
export { agentWorkspaceDirectory } from "./src/agent-runtime/agent-workspace-path";
export { AgentStateMachine } from "./src/agent-runtime/agent-state-machine";
export { createAgentActivity } from "./src/agent-runtime/agent-activity";
export type { AgentRuntime, AgentStatus } from "./src/agent-runtime/agent-process-manager";
export type {
  AgentActivity,
  AgentActivityLevel,
  AgentActivityType,
} from "./src/agent-runtime/agent-activity";
export type {
  AgentStateEvent,
  AgentStateTransition,
  AgentStatus as AgentStateStatus,
} from "./src/agent-runtime/agent-state-machine";
export { DaemonRuntime } from "./src/daemon-runtime/runtime";
export {
  SystemdWorkspaceInstance,
  workspaceUnit,
} from "./src/supervisor/systemd-workspace-instance";
export { AgentMessageAttentionIndex } from "./src/daemon-runtime/agent-message-attention-index";
export { AgentAppInbox } from "./src/agent-app-inbox/agent-app-inbox";
export type { AgentAppItem, MintAppItem } from "./src/agent-app-inbox/agent-app-inbox";
export type { DaemonConfig, WorkspaceConfig } from "./src/daemon-runtime/runtime";
export {
  InMemoryDaemonCredentialStore,
  FileDaemonCredentialStore,
} from "./src/credentials/credential-store";
export type { DaemonCredentialStore } from "./src/credentials/credential-store";
export type {
  DaemonConnectionClient,
  DaemonConnectionConfig,
  DaemonConnectionClientFactory,
  AgentMessageHttpClient,
} from "./src/connection/daemon-connection";
export {
  DaemonConnection,
  defaultCentrifugeWorkspaceClientFactory,
} from "./src/connection/daemon-connection";
export { COFORGE_DAEMON_SERVER_URL, daemonConnectionEndpoint } from "./src/connection/built-server";

const DAEMON_CATEGORY = ["coforge", "daemon"];

export async function runDaemon(args: string[]): Promise<void> {
  const socketIndex = args.indexOf("--socket");
  const socketPath = socketIndex >= 0 ? args[socketIndex + 1] : undefined;
  const stateIndex = args.indexOf("--state-directory");
  const stateDirectory = stateIndex >= 0 ? args[stateIndex + 1] : undefined;
  const daemonStateDirectory = stateDirectory ?? join(homedir(), ".coforge", "daemon");
  await configureDaemonLogging(daemonStateDirectory);
  if (!socketPath) {
    getLogger(DAEMON_CATEGORY).error("Daemon requires --socket", {
      event: "daemon:invalid_arguments",
    });
    await dispose();
    process.exitCode = 2;
    return;
  }
  return withContext(
    {
      service: "coforge-daemon",
      version: COFORGE_DAEMON_VERSION,
      process_role: "daemon",
      pid: process.pid,
    },
    async () => {
      const logger = getLogger(DAEMON_CATEGORY);
      logger.info("Daemon process started", { event: "daemon:started", outcome: "ok" });
      if (process.platform === "darwin" && Bun.env.COFORGE_WORKSPACE_AGENT_PREFIX) {
        const directory = Bun.env.COFORGE_WORKSPACE_JOB_DIRECTORY;
        if (!directory) throw new Error("Workspace Agent job directory is missing");
        await stopLaunchdJobs(Bun.env.COFORGE_WORKSPACE_AGENT_PREFIX, directory);
      }
      const credentials = new FileDaemonCredentialStore();
      const configStore = new DaemonConfigStore(daemonStateDirectory, {
        serverHttpUrl: COFORGE_DAEMON_SERVER_URL,
      });
      let runtime: DaemonRuntime | undefined;
      const agentProxy = startAgentProxy({
        runtime: {
          agentMessage: (...args) =>
            runtime?.agentMessage(...args) ??
            Promise.reject(new Error("daemon runtime is not running")),
          agentAttachment: (...args) =>
            runtime?.agentAttachment(...args) ??
            Promise.reject(new Error("daemon runtime is not running")),
          inbox: (...args) =>
            runtime?.inbox(...args) ?? Promise.reject(new Error("daemon runtime is not running")),
          issueAgentContext: (agentId) => {
            if (!runtime) throw new Error("daemon runtime is not running");
            return runtime.issueAgentContext(agentId);
          },
        },
      });
      process.env.COFORGE_AGENT_PROXY_URL = agentProxy.url;
      let config = await configStore.load();
      const endpoint = () => {
        return daemonConnectionEndpoint(COFORGE_DAEMON_SERVER_URL);
      };
      const lifecycle = () => ({
        recoveredRestartRequestIds:
          (config as { restartRequestIds?: string[] } | null)?.restartRequestIds ?? [],
        requestRestart: Bun.env.COFORGE_SUPERVISOR_SOCKET
          ? async (requestId: string) => {
              if (!config) throw new Error("Workspace is not configured");
              await new LocalDaemonLauncher({
                executablePath: process.execPath,
                socketPath: Bun.env.COFORGE_SUPERVISOR_SOCKET!,
                spawn: () => {},
              }).control("restart", config.workspaceId, requestId);
            }
          : undefined,
      });
      const daemon = {
        async configure(connection: Parameters<DaemonRuntime["start"]>[0]) {
          const nextConfig = configStore.bindToServer(connection);
          // A configure request is the Workspace-page replacement operation. Stop
          // the old connection and all children before adopting the new identity.
          await runtime?.stop();
          config = nextConfig;
          runtime = new DaemonRuntime(
            config,
            createAgentDriver,
            credentials,
            {
              create: () =>
                new DaemonConnection(endpoint(), defaultCentrifugeWorkspaceClientFactory),
            },
            agentProxy,
            discoverCodeAgentInventory,
            daemonStateDirectory,
            lifecycle(),
          );
          await runtime.start(config);
        },
        async start() {
          if (config) {
            runtime ??= new DaemonRuntime(
              config,
              createAgentDriver,
              credentials,
              {
                create: () =>
                  new DaemonConnection(endpoint(), defaultCentrifugeWorkspaceClientFactory),
              },
              agentProxy,
              discoverCodeAgentInventory,
              daemonStateDirectory,
              lifecycle(),
            );
            await runtime.start(config);
          }
        },
        async stopAll() {
          await runtime?.stop();
          runtime = undefined;
        },
        async restart() {
          await this.stopAll();
          await this.start();
        },
        inbox(context: string, request: LocalInboxRequest) {
          return (
            runtime?.inbox(context, request) ??
            Promise.reject(new Error("daemon runtime is not running"))
          );
        },
      };
      if (Bun.env.COFORGE_SUPERVISOR_SOCKET) await daemon.start();
      const localRpc = await startDaemonLocalRpcServer({
        socketPath,
        version: COFORGE_DAEMON_VERSION,
        validateCredential: (credential) => credential.length > 0,
        runtime: daemon,
        credentials,
        configStore,
      });
      try {
        await daemon.start();
      } catch (error) {
        logger.error("Daemon failed to recover configured Workspace", {
          event: "daemon:workspace_recovery_failed",
          error_code: diagnosticErrorCode(error),
          outcome: "failed",
        });
      }
      let shuttingDown = false;
      const shutdown = async () => {
        if (shuttingDown) return;
        shuttingDown = true;
        await daemon.stopAll();
        agentProxy.close();
        await localRpc.close();
        logger.info("Daemon process stopped", { event: "daemon:stopped", outcome: "ok" });
        await dispose();
        resolveShutdown();
      };
      let resolveShutdown!: () => void;
      const shutdownRequested = new Promise<void>((resolve) => {
        resolveShutdown = resolve;
      });
      process.once("SIGINT", () => void shutdown());
      process.once("SIGTERM", () => void shutdown());
      await shutdownRequested;
    },
  );
}

// Standalone source/development harness; releases enter through Computer.
if (import.meta.main) await runDaemon(Bun.argv.slice(2));

function diagnosticErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) return String(error.code);
  return error instanceof Error ? error.name : "UnknownError";
}
