import { describe, expect, test } from "bun:test";
import { AgentRuntimePool } from "../src/agent-capacity/agent-runtime-pool";
import { WorkspaceWorkerImpl } from "../src/workspace-worker/worker";
import type {
  AgentRuntimeConfig,
  CodeAgentAdapter,
  CodeAgentSession,
} from "../src/code-agent/contract";
import type { WorkspaceConnection } from "../src/workspace-worker/supervisor";

function sessionSpy() {
  return {
    async prompt() {},
    subscribe() {
      return () => undefined;
    },
    async interrupt() {},
    onExit() {
      return () => undefined;
    },
    async dispose() {},
  } satisfies CodeAgentSession;
}

const connection: WorkspaceConnection = {
  connectionId: "connection-a",
  workspaceId: "workspace-a",
  workspaceRoot: "/workspaces/workspace-a",
};

const config: AgentRuntimeConfig = {
  provider: "pi",
  model: "default",
  reasoning: "balanced",
};

describe("WorkspaceWorkerImpl", () => {
  test("owns one AgentProcessManager and uses the shared pool", async () => {
    const pool = new AgentRuntimePool(1);
    const adapter: CodeAgentAdapter = {
      provider: "pi",
      async start() {
        return sessionSpy();
      },
    };
    const worker = new WorkspaceWorkerImpl(connection, pool, () => adapter);

    await worker.start(connection);
    await worker.startAgent("agent-a", config);

    expect(worker.agentProcessManager.size).toBe(1);
    expect(pool.size).toBe(1);
    await worker.stop();
    expect(worker.agentProcessManager.size).toBe(0);
    expect(pool.size).toBe(0);
  });
});
