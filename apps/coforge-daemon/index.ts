import { startDaemonLocalRpcServer } from "./src/local-rpc";
import { createDaemonRuntime } from "./src/daemon-runtime";
import type { WorkspaceWorker } from "./src/workspace-worker/supervisor";

export type {
  AgentRuntimeConfig,
  CodeAgentAdapter,
  CodeAgentEvent,
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
export { createDaemonRuntime } from "./src/daemon-runtime";
export type { DaemonRuntime } from "./src/daemon-runtime";
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
export { createWorkspaceWorkerFactory, WorkspaceWorkerImpl } from "./src/workspace-worker/worker";

if (import.meta.main) {
  const socketIndex = Bun.argv.indexOf("--socket");
  const socketPath = socketIndex >= 0 ? Bun.argv[socketIndex + 1] : undefined;
  if (!socketPath) {
    console.error("coforge-daemon requires --socket");
    process.exit(2);
  }
  const runtime = createDaemonRuntime({
    workerFactory: {
      create: (): WorkspaceWorker => {
        throw new Error("workspace worker factory is not configured");
      },
    },
  });
  const localRpc = await startDaemonLocalRpcServer({ socketPath });
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await runtime.shutdown();
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
