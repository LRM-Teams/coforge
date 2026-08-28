import { startDaemonLocalRpcServer } from "./src/local-rpc";
import { createDaemonCoordinator } from "./src/daemon-coordinator";
import { AgentRuntimePool } from "./src/agent-capacity/agent-runtime-pool";
import { createCodeAgentAdapter } from "./src/code-agent/registry";
import { createWorkspaceWorkerFactory } from "./src/workspace-worker/worker";
import type { AgentAdapterFactory } from "./src/agent-runtime/agent-process-manager";
import { resolveAgentCapacity } from "./src/agent-capacity/policy";
import { NativeWorkspaceWorkerCredentialStore } from "./src/workspace-worker/credential-store";
import type { WorkspaceWorkerCloudTransportFactory } from "./src/cloud-transport/workspace-worker-cloud-transport";
import type { WorkspaceWorkerCredentialStore } from "./src/workspace-worker/credential-store";
import { FileWorkspaceConnectionRegistry } from "./src/persistence/workspace-connection-registry";
import { recoverWorkspaceConnections } from "./src/recovery";
import {
  CentrifugoWorkspaceWorkerTransport,
  defaultCentrifugeWorkspaceWorkerClientFactory,
} from "./src/cloud-transport/workspace-worker-cloud-transport";

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
export {
  LaunchdDaemonHost,
  launchdPlist,
  SystemdUserDaemonHost,
  systemdUserUnit,
  WindowsUserDaemonHost,
} from "./src/daemon-host";
export { LocalDaemonLauncher, resolveDaemonExecutablePath } from "./src/daemon-host/launcher";
export type { DaemonLauncher } from "./src/daemon-host/launcher";
export { createDaemonCoordinator } from "./src/daemon-coordinator";
export { FileWorkspaceConnectionRegistry } from "./src/persistence/workspace-connection-registry";
export { recoverWorkspaceConnections } from "./src/recovery";
export type { DaemonCoordinator } from "./src/daemon-coordinator";
export { AgentRuntimePool } from "./src/agent-capacity/agent-runtime-pool";
export type { AgentRuntimeHandle } from "./src/agent-capacity/agent-runtime-pool";
export { AgentProcessManager } from "./src/agent-runtime/agent-process-manager";
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
export {
  computedAgentCapacityPolicy,
  readDefaultAgentResources,
  resolveAgentCapacity,
} from "./src/agent-capacity/policy";
export type {
  AgentCapacityPolicy,
  AgentResourceSnapshot,
  ResolveAgentCapacityOptions,
} from "./src/agent-capacity/policy";
export {
  WorkspaceWorkerSupervisor,
  type WorkspaceConnection,
  type WorkspaceWorker,
  type WorkerFactory,
  type WorkspaceWorkerInfo,
} from "./src/workspace-worker/supervisor";
export { validateWorkspaceRoot } from "./src/workspace-worker/supervisor";
export { createWorkspaceWorkerFactory, WorkspaceWorkerImpl } from "./src/workspace-worker/worker";
export {
  InMemoryWorkspaceWorkerCredentialStore,
  NativeWorkspaceWorkerCredentialStore,
} from "./src/workspace-worker/credential-store";
export type { WorkspaceWorkerCredentialStore } from "./src/workspace-worker/credential-store";
export type {
  WorkspaceWorkerCloudTransport,
  WorkspaceWorkerCloudTransportConfig,
  WorkspaceWorkerCloudTransportFactory,
} from "./src/cloud-transport/workspace-worker-cloud-transport";
export {
  CentrifugoWorkspaceWorkerTransport,
  defaultCentrifugeWorkspaceWorkerClientFactory,
} from "./src/cloud-transport/workspace-worker-cloud-transport";

/** Assemble the daemon's shared capacity and provider-neutral worker factory. */
export function createDaemonWorkerFactory(options: {
  configuredCapacity?: number;
  environment?: Readonly<Record<string, string | undefined>>;
  createAdapter?: AgentAdapterFactory;
  credentials?: WorkspaceWorkerCredentialStore;
  transportFactory: WorkspaceWorkerCloudTransportFactory;
}) {
  const pool = new AgentRuntimePool(
    resolveAgentCapacity({
      configuredCapacity: options?.configuredCapacity,
      environment: options?.environment,
    }),
  );
  return createWorkspaceWorkerFactory({
    pool,
    createAdapter: options?.createAdapter ?? createCodeAgentAdapter,
    credentials: options?.credentials ?? new NativeWorkspaceWorkerCredentialStore(),
    transportFactory: options.transportFactory,
  });
}

if (import.meta.main) {
  const socketIndex = Bun.argv.indexOf("--socket");
  const socketPath = socketIndex >= 0 ? Bun.argv[socketIndex + 1] : undefined;
  const stateIndex = Bun.argv.indexOf("--state-directory");
  const stateDirectory = stateIndex >= 0 ? Bun.argv[stateIndex + 1] : undefined;
  if (!socketPath) {
    console.error("coforge-daemon requires --socket");
    process.exit(2);
  }
  const credentials = new NativeWorkspaceWorkerCredentialStore();
  const registry = new FileWorkspaceConnectionRegistry(
    stateDirectory ?? Bun.env.XDG_STATE_HOME ?? ".coforge",
  );
  const coordinator = createDaemonCoordinator({
    workerFactory: {
      create: createDaemonWorkerFactory({
        credentials,
        transportFactory: {
          create: () =>
            new CentrifugoWorkspaceWorkerTransport(
              Bun.env.COFORGE_CLOUD_WEBSOCKET_ENDPOINT ?? "",
              defaultCentrifugeWorkspaceWorkerClientFactory,
            ),
        },
      }),
    },
  });
  const localRpc = await startDaemonLocalRpcServer({
    socketPath,
    validateCredential: (credential) => credential.length > 0,
    runtime: coordinator,
    credentials,
    registry,
  });
  await recoverWorkspaceConnections(registry, coordinator);
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await coordinator.shutdown();
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
