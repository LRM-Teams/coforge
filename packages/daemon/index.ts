import { homedir } from "node:os";
import { join } from "node:path";
import type { LocalInboxRequest } from "@lrm/coforge-sdk/internal";
import { dispose, getLogger, withContext } from "@logtape/logtape";
import { startDaemonLocalRpcServer } from "./src/local-rpc";
import { startAgentProxy } from "./src/agent-proxy";
import { createCodeAgentProvider } from "./src/code-agent/registry";
import { discoverCodeAgentInventory } from "./src/code-agent/runtime-inventory";
import {
  DaemonRuntime,
  type BusyAgentReport,
  type DaemonConfig,
  type RecoveredUpgradeResult,
} from "./src/daemon-runtime/runtime";
import { diagnosticErrorCode } from "./src/platform/diagnostic-error-code";
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
export { launchdJobs } from "./src/platform/launchd-job";
export { FileBindingStore } from "./src/supervisor/binding-store";
export { workspaceLaunchdIdentity } from "./src/supervisor/launchd-workspace-instance";
export { runMachineSupervisor } from "./src/supervisor/run-supervisor";
export { runLaunchdAgent } from "./src/platform/launchd-process";

export type { AgentRuntimeConfig, AgentSession, AgentSessionOptions } from "@coforge/agent";
export type {
  AgentRuntimeEvent,
  CodeAgentProvider,
  CodeAgentProviderFactory,
} from "./src/code-agent/contract";
export { createCodeAgentProvider } from "./src/code-agent/registry";
export { ClaudeCodeProvider } from "./src/code-agent/claude-code/driver";
export { CodexProvider } from "./src/code-agent/codex/driver";
export { readCodexUsage } from "./src/code-agent/codex/usage";
export { readClaudeCodeUsage } from "./src/code-agent/claude-code/usage";
export { CoforgeProvider, PiProvider } from "./src/code-agent/pi/driver";
export { KiroProvider } from "./src/code-agent/kiro/driver";
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
export { cleanupComputerUpgradeJob } from "./src/platform/computer-upgrade-launcher";
export { acquireProcessLock } from "./src/platform/process-lock";
export { readOperatingSystem } from "./src/platform/operating-system";
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
export type { AgentActivity, AgentActivityLevel } from "./src/agent-runtime/agent-activity";
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
export type {
  DaemonConfig,
  WorkspaceConfig,
  RecoveredUpgradeResult,
} from "./src/daemon-runtime/runtime";
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

export async function runDaemon(args: string[], computerVersion?: string): Promise<void> {
  const argument = (flag: string) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const socketPath = argument("--socket");
  const daemonStateDirectory =
    argument("--state-directory") ?? join(homedir(), ".coforge", "daemon");
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
      const requireRuntime = (): DaemonRuntime => {
        if (!runtime) throw new Error("daemon runtime is not running");
        return runtime;
      };
      // Every caller awaits inside a try, so a missing runtime surfaces as a rejected call.
      const agentProxy = startAgentProxy({
        runtime: {
          agentMessage: async (...input) => requireRuntime().agentMessage(...input),
          agentAttachment: async (...input) => requireRuntime().agentAttachment(...input),
          inbox: async (...input) => requireRuntime().inbox(...input),
          agentTask: async (...input) => requireRuntime().agentTask(...input),
          agentWeeklyReport: async (...input) => requireRuntime().agentWeeklyReport(...input),
          workspaceInfo: async (...input) => requireRuntime().workspaceInfo(...input),
          issueAgentContext: (agentId) => requireRuntime().issueAgentContext(agentId),
        },
      });
      process.env.COFORGE_AGENT_PROXY_URL = agentProxy.url;
      let config = await configStore.load();
      const supervisorSocket = Bun.env.COFORGE_SUPERVISOR_SOCKET;
      const supervisorControl = (...request: Parameters<LocalDaemonLauncher["control"]>) =>
        new LocalDaemonLauncher({
          executablePath: process.execPath,
          socketPath: supervisorSocket!,
          spawn: () => {},
        }).control(...request);
      const createRuntime = (connection: DaemonConfig) =>
        new DaemonRuntime(
          connection,
          createCodeAgentProvider,
          credentials,
          {
            create: () =>
              new DaemonConnection(
                daemonConnectionEndpoint(COFORGE_DAEMON_SERVER_URL),
                defaultCentrifugeWorkspaceClientFactory,
              ),
          },
          agentProxy,
          discoverCodeAgentInventory,
          daemonStateDirectory,
          {
            recoveredRestartRequestIds:
              (config as { restartRequestIds?: string[] } | null)?.restartRequestIds ?? [],
            recoveredUpgradeRequestIds:
              (config as { upgradeRequestIds?: string[] } | null)?.upgradeRequestIds ?? [],
            recoveredUpgradeResults: terminalUpgradeResults(config),
            acknowledgeUpgradeResult: supervisorSocket
              ? async (requestId: string) => {
                  if (!config) throw new Error("Workspace is not configured");
                  await supervisorControl("upgrade_ack", config.workspaceId, requestId);
                }
              : undefined,
            requestRestart: supervisorSocket
              ? async (requestId: string) => {
                  if (!config) throw new Error("Workspace is not configured");
                  await supervisorControl("restart", config.workspaceId, requestId);
                }
              : undefined,
            requestUpgrade: async (requestId: string, expectedVersion?: string) => {
              if (!config) throw new Error("Workspace is not configured");
              if (!expectedVersion) throw new Error("upgrade expected version is unavailable");
              await supervisorControl("upgrade", config.workspaceId, requestId, expectedVersion);
            },
          },
          computerVersion,
        );
      const daemon = {
        async configure(connection: DaemonConfig) {
          const nextConfig = configStore.bindToServer(connection);
          // A configure request is the Workspace-page replacement operation. Stop
          // the old connection and all children before adopting the new identity.
          await runtime?.stop();
          config = nextConfig;
          runtime = createRuntime(config);
          await runtime.start(config);
        },
        async start() {
          if (!config) return;
          runtime ??= createRuntime(config);
          await runtime.start(config);
        },
        async stopAll() {
          await runtime?.stop();
          runtime = undefined;
        },
        async restart() {
          await this.stopAll();
          await this.start();
        },
        inbox: async (context: string, request: LocalInboxRequest) =>
          requireRuntime().inbox(context, request),
        // Runner hold (ADR 0020). A Workspace with no configured runtime has nothing to drain and
        // reports itself quiescent, so it never holds an upgrade up.
        async hold(reason: string) {
          return { held: true, busyAgents: stampWorkspace(runtime?.holdRunners(reason)) };
        },
        async release() {
          return { held: false, busyAgents: stampWorkspace(runtime?.releaseRunners()) };
        },
      };
      function stampWorkspace(agents: BusyAgentReport[] = []) {
        return agents.map((agent) => ({ ...agent, workspaceId: config?.workspaceId ?? "" }));
      }
      if (supervisorSocket) await daemon.start();
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

/**
 * The Coordinator hands each Workspace daemon the upgrade operations it must still settle with
 * the server. Only terminal ones carry a receipt worth reporting; pending ones stay cloud ready
 * hints until their job leaves a receipt.
 */
function terminalUpgradeResults(config: unknown): RecoveredUpgradeResult[] {
  const operations = (
    config as {
      upgradeOperations?: {
        requestId?: unknown;
        state?: unknown;
        terminal?: { version?: unknown; error?: unknown; at?: unknown };
      }[];
    } | null
  )?.upgradeOperations;
  if (!Array.isArray(operations)) return [];
  return operations.flatMap((operation) => {
    if (operation.state !== "succeeded" && operation.state !== "failed") return [];
    if (typeof operation.requestId !== "string" || !operation.requestId) return [];
    const at = operation.terminal?.at;
    return [
      {
        requestId: operation.requestId,
        status: operation.state,
        completedAtMs: Number.isSafeInteger(at) ? (at as number) : Date.now(),
        ...(typeof operation.terminal?.version === "string" && operation.terminal.version
          ? { version: operation.terminal.version }
          : {}),
        ...(typeof operation.terminal?.error === "string" && operation.terminal.error
          ? { error: operation.terminal.error }
          : {}),
      },
    ];
  });
}

// Standalone source/development harness; releases enter through Computer.
if (import.meta.main) await runDaemon(Bun.argv.slice(2));
