import { homedir } from "node:os";
import { join } from "node:path";
import { startDaemonLocalRpcServer } from "./src/local-rpc";
import { startAgentProxy } from "./src/agent-proxy";
import { createCodeAgentAdapter } from "./src/code-agent/registry";
import { DaemonRuntime } from "./src/daemon-runtime/runtime";
import { NativeDaemonCredentialStore } from "./src/credentials/credential-store";
import { DaemonConfigStore } from "./src/persistence/daemon-config";
import {
  CentrifugoWorkspaceTransport,
  defaultCentrifugeWorkspaceClientFactory,
} from "./src/cloud-transport/workspace-cloud-transport";

export type {
  AgentRuntimeConfig,
  CodeAgentAdapter,
  AgentRuntimeEvent,
  CodeAgentProvider,
  CodeAgentSession,
  CodeAgentStartOptions,
} from "./src/code-agent/contract";
export { createCodeAgentAdapter } from "./src/code-agent/registry";
export { ClaudeCodeAgentAdapter } from "./src/code-agent/claude-code/adapter";
export { CodexAgentAdapter } from "./src/code-agent/codex/adapter";
export { PiAgentAdapter } from "./src/code-agent/pi/adapter";
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
export type {
  DaemonLauncher,
  DaemonCommandRunner,
  DaemonStopper,
  DaemonWorkspaceConfig,
} from "./src/daemon-host/launcher";
export { DaemonConfigStore } from "./src/persistence/daemon-config";
export { AgentProcessManager } from "./src/agent-runtime/agent-process-manager";
export { agentWorkspaceDirectory } from "./src/agent-runtime/agent-workspace-path";
export { AgentStateMachine } from "./src/agent-runtime/agent-state-machine";
export { createAgentActivity } from "./src/agent-runtime/agent-activity";
export type {
  AgentAdapterFactory,
  AgentRuntime,
  AgentStatus,
} from "./src/agent-runtime/agent-process-manager";
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
export { AgentMessageAttentionIndex } from "./src/daemon-runtime/agent-message-attention-index";
export type { DaemonConfig, WorkspaceConfig } from "./src/daemon-runtime/runtime";
export {
  InMemoryDaemonCredentialStore,
  NativeDaemonCredentialStore,
} from "./src/credentials/credential-store";
export type { DaemonCredentialStore } from "./src/credentials/credential-store";
export type {
  WorkspaceCloudTransport,
  WorkspaceCloudTransportConfig,
  WorkspaceCloudTransportFactory,
  AgentMessageHttpClient,
} from "./src/cloud-transport/workspace-cloud-transport";
export {
  CentrifugoWorkspaceTransport,
  defaultCentrifugeWorkspaceClientFactory,
} from "./src/cloud-transport/workspace-cloud-transport";

if (import.meta.main) {
  const socketIndex = Bun.argv.indexOf("--socket");
  const socketPath = socketIndex >= 0 ? Bun.argv[socketIndex + 1] : undefined;
  const stateIndex = Bun.argv.indexOf("--state-directory");
  const stateDirectory = stateIndex >= 0 ? Bun.argv[stateIndex + 1] : undefined;
  if (!socketPath) {
    console.error("coforge-daemon requires --socket");
    process.exit(2);
  }
  const credentials = new NativeDaemonCredentialStore();
  const configStore = new DaemonConfigStore(
    stateDirectory ?? join(homedir(), ".coforge", "daemon"),
  );
  let runtime: DaemonRuntime | undefined;
  const agentProxy = startAgentProxy({
    runtime: {
      agentMessage: (...args) =>
        runtime?.agentMessage(...args) ??
        Promise.reject(new Error("daemon runtime is not running")),
      issueAgentContext: (agentId) => {
        if (!runtime) throw new Error("daemon runtime is not running");
        return runtime.issueAgentContext(agentId);
      },
    },
  });
  process.env.COFORGE_AGENT_PROXY_URL = agentProxy.url;
  let config = await configStore.load();
  const daemon = {
    async configure(connection: Parameters<DaemonRuntime["start"]>[0]) {
      // A configure request is the Workspace-page replacement operation. Stop
      // the old connection and all children before adopting the new identity.
      await runtime?.stop();
      config = {
        ...connection,
        serverHttpUrl: connection.serverHttpUrl ?? Bun.env.COFORGE_SERVER_HTTP_URL,
      };
      runtime = new DaemonRuntime(
        config,
        createCodeAgentAdapter,
        credentials,
        {
          create: () =>
            new CentrifugoWorkspaceTransport(
              Bun.env.COFORGE_CLOUD_WEBSOCKET_ENDPOINT ?? "",
              defaultCentrifugeWorkspaceClientFactory,
            ),
        },
        agentProxy,
      );
    },
    async start() {
      if (config) {
        runtime ??= new DaemonRuntime(
          config,
          createCodeAgentAdapter,
          credentials,
          {
            create: () =>
              new CentrifugoWorkspaceTransport(
                Bun.env.COFORGE_CLOUD_WEBSOCKET_ENDPOINT ?? "",
                defaultCentrifugeWorkspaceClientFactory,
              ),
          },
          agentProxy,
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
  };
  const localRpc = await startDaemonLocalRpcServer({
    socketPath,
    validateCredential: (credential) => credential.length > 0,
    runtime: daemon,
    credentials,
    configStore,
  });
  try {
    await daemon.start();
  } catch {
    console.error("coforge-daemon: failed to recover configured Workspace");
  }
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await daemon.stopAll();
    agentProxy.close();
    await localRpc.close();
    resolveShutdown();
  };
  let resolveShutdown!: () => void;
  const shutdownRequested = new Promise<void>((resolve) => {
    resolveShutdown = resolve;
  });
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  await shutdownRequested;
}
