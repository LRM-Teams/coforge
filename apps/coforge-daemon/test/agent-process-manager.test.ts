import { describe, expect, test } from "bun:test";
import { AgentRuntimePool } from "../src/agent-capacity/agent-runtime-pool";
import { AgentProcessManager } from "../src/agent-runtime/agent-process-manager";
import type {
  CodeAgentAdapter,
  CodeAgentSession,
  AgentRuntimeConfig,
} from "../src/code-agent/contract";

function sessionSpy() {
  const exitListeners = new Set<() => void>();
  return {
    disposeCalls: 0,
    async prompt() {},
    subscribe() {
      return () => undefined;
    },
    async interrupt() {},
    onExit(listener: () => void) {
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },
    exit() {
      for (const listener of exitListeners) listener();
    },
    async dispose() {
      this.disposeCalls += 1;
      this.exit();
    },
  } satisfies CodeAgentSession & { disposeCalls: number; exit(): void };
}

const config: AgentRuntimeConfig = {
  provider: "pi",
  model: "default",
  reasoning: "balanced",
};

describe("AgentProcessManager", () => {
  test("starts one runtime with its configuration and releases capacity on stop", async () => {
    const session = sessionSpy();
    let startedOptions: unknown;
    const adapter: CodeAgentAdapter = {
      provider: "pi",
      async start(options) {
        startedOptions = options;
        return session;
      },
    };
    const manager = new AgentProcessManager(new AgentRuntimePool(1), "connection-a", () => adapter);

    const runtime = await manager.start("agent-1", config, "/workspaces/a/agents/agent-1");

    expect(runtime.config).toEqual(config);
    expect(runtime.session).toBe(session);
    expect(startedOptions).toEqual({
      agentWorkspaceDirectory: "/workspaces/a/agents/agent-1",
      runtime: config,
    });
    expect(manager.size).toBe(1);
    expect(manager.status("agent-1")).toBe("online");
    expect(manager.status("agent-2")).toBe("offline");
    await manager.stop("agent-1");
    expect(session.disposeCalls).toBe(1);
    expect(manager.size).toBe(0);
    expect(manager.status("agent-1")).toBe("offline");
  });

  test("becomes offline when the Agent runtime process exits", async () => {
    const pool = new AgentRuntimePool(1);
    const session = sessionSpy();
    const manager = new AgentProcessManager(pool, "connection-a", () => ({
      provider: "pi",
      async start() {
        return session;
      },
    }));

    await manager.start("agent-1", config, "/agents/1");
    session.exit();

    expect(manager.status("agent-1")).toBe("offline");
    expect(pool.size).toBe(0);
  });

  test("does not start a second runtime after the pool is full", async () => {
    let starts = 0;
    const adapter: CodeAgentAdapter = {
      provider: "pi",
      async start() {
        starts += 1;
        return sessionSpy();
      },
    };
    const manager = new AgentProcessManager(new AgentRuntimePool(1), "connection-a", () => adapter);

    await manager.start("agent-1", config, "/agents/1");
    await expect(manager.start("agent-2", config, "/agents/2")).rejects.toThrow(
      "Agent runtime capacity is full",
    );
    expect(starts).toBe(1);
  });

  test("returns capacity when adapter startup fails", async () => {
    const pool = new AgentRuntimePool(1);
    const manager = new AgentProcessManager(pool, "connection-a", () => ({
      provider: "pi",
      async start() {
        throw new Error("startup failed");
      },
    }));

    await expect(manager.start("agent-1", config, "/agents/1")).rejects.toThrow("startup failed");
    expect(pool.size).toBe(0);
    expect(manager.size).toBe(0);
  });
});
