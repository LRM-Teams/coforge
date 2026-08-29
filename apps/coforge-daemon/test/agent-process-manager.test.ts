import { describe, expect, test } from "bun:test";
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
    async sendMessage() {},
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
  test("starts one runtime with its configuration and stops it", async () => {
    const session = sessionSpy();
    let startedOptions: unknown;
    const adapter: CodeAgentAdapter = {
      provider: "pi",
      async start(options) {
        startedOptions = options;
        return session;
      },
    };
    const manager = new AgentProcessManager(() => adapter);

    const runtime = await manager.start("agent-1", config, "/workspaces/a/agents/agent-1");

    expect(runtime.config).toEqual(config);
    expect(runtime.session).toBe(session);
    expect(startedOptions).toEqual({
      agentWorkspaceDirectory: "/workspaces/a/agents/agent-1",
      sessionId: undefined,
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
    const session = sessionSpy();
    const manager = new AgentProcessManager(() => ({
      provider: "pi",
      async start() {
        return session;
      },
    }));

    await manager.start("agent-1", config, "/agents/1");
    session.exit();

    expect(manager.status("agent-1")).toBe("offline");
  });

  test("starts multiple Agent runtimes for distinct Agents", async () => {
    let starts = 0;
    const adapter: CodeAgentAdapter = {
      provider: "pi",
      async start() {
        starts += 1;
        return sessionSpy();
      },
    };
    const manager = new AgentProcessManager(() => adapter);

    await manager.start("agent-1", config, "/agents/1");
    await manager.start("agent-2", config, "/agents/2");
    expect(starts).toBe(2);
    expect(manager.size).toBe(2);
  });

  test("passes a session id through the provider-neutral start seam", async () => {
    let options: { sessionId?: string } | undefined;
    const manager = new AgentProcessManager(() => ({
      provider: "pi",
      async start(startOptions) {
        options = startOptions;
        return sessionSpy();
      },
    }));
    await manager.start("agent-1", config, "/agents/1", "session-7");
    expect(options?.sessionId).toBe("session-7");
  });

  test("does not retain a runtime when adapter startup fails", async () => {
    const manager = new AgentProcessManager(() => ({
      provider: "pi",
      async start() {
        throw new Error("startup failed");
      },
    }));

    await expect(manager.start("agent-1", config, "/agents/1")).rejects.toThrow("startup failed");
    expect(manager.size).toBe(0);
  });
});
