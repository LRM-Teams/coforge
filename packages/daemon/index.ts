import { homedir } from "node:os";
import { join } from "node:path";
import type { LocalInboxRequest } from "@lrm/coforge-sdk/internal";
import { dispose, getLogger, withContext } from "@logtape/logtape";
import { startDaemonLocalRpcServer } from "./src/local-rpc";
import { startAgentProxy, type AgentProxyRuntime } from "./src/agent-proxy";
import { createCodeAgentProvider } from "./src/code-agent/registry";
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
import { stopWorkspaceAgentProcesses } from "./src/platform/linux-agent-processes";
import {
  WorkspaceHealthJournal,
  workspaceDegradedMessage,
  workspaceHealthJournalPath,
} from "./src/supervisor/workspace-health-journal";
import { guardWorkspaceRunnerStart } from "./src/supervisor/workspace-runner-guard";
export { launchdJobs } from "./src/platform/launchd-job";
export { stopWorkspaceAgentProcesses } from "./src/platform/linux-agent-processes";
export { FileBindingStore } from "./src/supervisor/binding-store";
export { workspaceLaunchdIdentity } from "./src/supervisor/launchd-workspace-instance";
export { workspaceStateDirectory } from "./src/supervisor/workspace-instance";
export {
  WORKSPACE_HEALTH_CRASH_WINDOW_MS,
  WORKSPACE_HEALTH_DEGRADED_THRESHOLD,
  WorkspaceHealthJournal,
  workspaceDegradedMessage,
  workspaceHealthJournalPath,
  workspaceHealthRecoveryCommand,
} from "./src/supervisor/workspace-health-journal";
export type { WorkspaceHealthState } from "./src/supervisor/workspace-health-journal";
export { runMachineSupervisor } from "./src/supervisor/run-supervisor";
export {
  holdRunnersUntilQuiescent,
  RUNNER_HOLD_MS,
  RUNNER_HOLD_POLL_MS,
} from "./src/supervisor/runner-hold";
export type {
  RunnerHoldOptions,
  RunnerHoldOutcome,
  RunnerHoldSnapshot,
} from "./src/supervisor/runner-hold";
export { runLaunchdAgent } from "./src/platform/launchd-process";

export type { AgentRuntimeConfig, AgentSession, AgentSessionOptions } from "@coforge/agent";
export type {
  AgentRuntimeEvent,
  CodeAgentProvider,
  CodeAgentProviderFactory,
} from "./src/code-agent/contract";
export { createCodeAgentProvider } from "./src/code-agent/registry";
export { ClaudeCodeProvider } from "./src/code-agent/claude-code/provider";
export { CodexProvider } from "./src/code-agent/codex/provider";
export { readCodexUsage } from "./src/code-agent/codex/usage";
export { readClaudeCodeUsage } from "./src/code-agent/claude-code/usage";
export { CoforgeProvider, PiProvider } from "./src/code-agent/pi/provider";
export { KiroProvider } from "./src/code-agent/kiro/provider";
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
export { acquireProcessLock, isLockContention } from "./src/platform/process-lock";
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
/** `--socket` is required for every launch this build understands; a launch missing it is a
 * precondition no restart can fix. */
const MISSING_SOCKET_REASON = "Daemon requires --socket";

export async function runDaemon(args: string[], computerVersion?: string): Promise<void> {
  const argument = (flag: string) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const socketPath = argument("--socket");
  const stateDirectoryArg = argument("--state-directory");
  const daemonStateDirectory = stateDirectoryArg ?? join(homedir(), ".coforge", "daemon");
  await configureDaemonLogging(daemonStateDirectory);
  const healthJournal = new WorkspaceHealthJournal(
    workspaceHealthJournalPath(daemonStateDirectory),
  );
  if (!socketPath) {
    // Terminal, not a crash to retry: restarting this exact invocation can never supply the
    // missing argument. Latching degraded and exiting 0 (see the degraded branch below for why
    // exit 0 is what stops both supervisors' restart loop) keeps a broken launch from spinning
    // forever instead of surfacing once with the fix. Only latch when `--state-directory` was
    // itself explicit: under every OS-supervised launch (the only shipped path) the Coordinator
    // always supplies both flags together, so a launch missing `--socket` but not
    // `--state-directory` never happens there. Without an explicit `--state-directory` this
    // falls back to the shared default `~/.coforge/daemon` - not a real per-Workspace directory
    // the Coordinator's `clearHealth` seam ever reaches - so writing a latch there could
    // permanently poison a later, unrelated standalone run with no way to clear it short of
    // deleting the file by hand. A hand-run invocation missing both flags gets today's plain
    // failure instead, exactly as before this change.
    if (stateDirectoryArg) await healthJournal.markTerminal(MISSING_SOCKET_REASON);
    const brokenConfig = stateDirectoryArg
      ? await new DaemonConfigStore(daemonStateDirectory, {
          serverHttpUrl: COFORGE_DAEMON_SERVER_URL,
        })
          .load()
          .catch(() => null)
      : null;
    getLogger(DAEMON_CATEGORY).error(
      workspaceDegradedMessage(MISSING_SOCKET_REASON, brokenConfig?.workspaceId),
      { event: "daemon:invalid_arguments" },
    );
    await dispose();
    process.exitCode = 0;
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
      let config = await configStore.load();
      // Before any real work (Agent proxy, Workspace connection): let the health journal say
      // whether the previous run(s) died unexpectedly often enough to stop this restart loop.
      const guard = await guardWorkspaceRunnerStart(healthJournal);
      if (guard.action === "exit") {
        logger.error(workspaceDegradedMessage(guard.reason, config?.workspaceId), {
          event: "daemon:workspace_degraded",
          reason: guard.reason,
          crash_count: guard.crashCount,
          degraded_since: guard.since,
        });
        await dispose();
        process.exitCode = 0;
        return;
      }
      // Linux has no per-Agent service to reap on boot the way macOS reaps its launchd jobs, so
      // sweep this Workspace's detached Agent processes that a previous daemon instance left
      // behind. Best-effort: a sweep failure must never keep the daemon from starting.
      if (process.platform === "linux" && config?.workspaceId) {
        try {
          const reaped = await stopWorkspaceAgentProcesses(config.workspaceId);
          if (reaped > 0)
            logger.info("Reaped Agent process groups left by a previous daemon instance", {
              event: "daemon:agent_processes_reaped",
              count: reaped,
            });
        } catch (error) {
          logger.warning("Could not reap leftover Agent processes", {
            event: "daemon:agent_process_reap_failed",
            error_code: diagnosticErrorCode(error),
          });
        }
      }
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
          agentAttachmentUpload: async (...input) =>
            requireRuntime().agentAttachmentUpload(...input),
          agentAttachmentUploadSessionCreate: async (...input) =>
            requireRuntime().agentAttachmentUploadSessionCreate(...input),
          agentAttachmentUploadSessionComplete: async (...input) =>
            requireRuntime().agentAttachmentUploadSessionComplete(...input),
          agentAttachmentUploadSessionCancel: async (...input) =>
            requireRuntime().agentAttachmentUploadSessionCancel(...input),
          agentAttachmentUploadSessionGet: async (...input) =>
            requireRuntime().agentAttachmentUploadSessionGet(...input),
          inbox: async (...input) => requireRuntime().inbox(...input),
          reminder: async (...input) => requireRuntime().reminder(...input),
          agentTask: async (...input) => requireRuntime().agentTask(...input),
          agentChannel: async (...input) => requireRuntime().agentChannel(...input),
          agentActionPrepare: async (...input) => requireRuntime().agentActionPrepare(...input),
          agentWeeklyReport: async (...input) => requireRuntime().agentWeeklyReport(...input),
          agentWeeklyReportCollect: async (...input) =>
            requireRuntime().agentWeeklyReportCollect(...input),
          agentWeeklyReportKeyPoints: async (...input) =>
            requireRuntime().agentWeeklyReportKeyPoints(...input),
          workspaceInfo: async (...input) => requireRuntime().workspaceInfo(...input),
          githubCredential: async (...input) => requireRuntime().githubCredential(...input),
          githubCommitTrailers: async (...input) => requireRuntime().githubCommitTrailers(...input),
          manualGet: async (...input) => requireRuntime().manualGet(...input),
          manualSearch: async (...input) => requireRuntime().manualSearch(...input),
          version: async (...input) => requireRuntime().version(...input),
          userInfo: async (...input) => requireRuntime().userInfo(...input),
          profileShow: async (...input) => requireRuntime().profileShow(...input),
          profileUpdate: async (...input) => requireRuntime().profileUpdate(...input),
          issueAgentContext: (agentId) => requireRuntime().issueAgentContext(agentId),
          // Every proxy route must reach the runtime here: an unwired handler is a 404 for the
          // Agent's CLI, so a new `AgentProxyRuntime` member fails to compile until it is added.
        } satisfies Required<AgentProxyRuntime>,
      });
      process.env.COFORGE_AGENT_PROXY_URL = agentProxy.url;
      // `config` was already loaded above, ahead of the health-journal guard.
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
          undefined,
          daemonStateDirectory,
          {
            recoveredRestartRequestIds:
              (config as { restartRequestIds?: string[] } | null)?.restartRequestIds ?? [],
            recoveredUpgradeRequestIds:
              (config as { upgradeRequestIds?: string[] } | null)?.upgradeRequestIds ?? [],
            recoveredUpgradeResults: terminalUpgradeResults(config),
            // Re-reads the same per-Workspace config file the Coordinator wrote before starting
            // this process - and may rewrite again while this process keeps running, once its
            // continuous upgrade-receipt watch settles an operation (ADR 0037) - so a result
            // settled after this process started is still reported on the next reconnect.
            refreshUpgradeResults: async () => terminalUpgradeResults(await configStore.load()),
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
      // The Coordinator polls this socket for readiness within a 30s budget after spawning the
      // Workspace, so it must open before anything that can block on the network (Code Agent
      // discovery, in particular). The handshake it answers only needs pid/version/serverUrl, so
      // starting it ahead of `daemon.start()` is safe for both the supervised and standalone paths.
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
        // A SIGTERM/SIGINT shutdown is deliberate - an operator stop, a restart, or an upgrade
        // (`machine-supervisor.ts`'s `#stop`) - never an unexpected death; clearing the live
        // marker here is what keeps the next start from counting it as a crash.
        await healthJournal.recordGracefulStop();
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
