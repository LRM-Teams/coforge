import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentProcessManager } from "../src/agent-runtime/agent-process-manager";
import type {
  CodeAgentAdapter,
  CodeAgentSession,
  AgentRuntimeConfig,
} from "../src/code-agent/contract";
import { AgentProcessCleanupError } from "../src/code-agent/contract";

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
const testWorkspaceRoot = join(tmpdir(), `coforge-agent-manager-${crypto.randomUUID()}`);

afterAll(() => rm(testWorkspaceRoot, { recursive: true, force: true }));

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

    const workspace = join(testWorkspaceRoot, "a", "agents", "agent-1");
    const runtime = await manager.start("agent-1", config, workspace);

    expect(runtime.config).toEqual(config);
    expect(runtime.session).toBe(session);
    expect(startedOptions).toEqual({
      agentWorkspaceDirectory: workspace,
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

  test("does not retain a provider API key after adapter startup", async () => {
    const manager = new AgentProcessManager(() => ({
      provider: "pi",
      async start() {
        return sessionSpy();
      },
    }));
    const credentialConfig = {
      ...config,
      providerConfig: {
        kind: "pi-builtin" as const,
        providerId: "deepseek",
        apiKey: "sk-deepseek-secret",
      },
    };

    const runtime = await manager.start(
      "agent-credential",
      credentialConfig,
      join(testWorkspaceRoot, "credential", "agent-credential"),
    );

    expect(runtime.config.providerConfig).toEqual({
      kind: "pi-builtin",
      providerId: "deepseek",
    });
    await manager.stop("agent-credential");
  });

  test("creates the Agent workspace before starting its adapter", async () => {
    const root = await mkdtemp(join(tmpdir(), "coforge-agent-runtime-"));
    const workspace = join(root, "workspace", "agents", "agent-1");
    let directoryExistsAtStart = false;
    const manager = new AgentProcessManager(() => ({
      provider: "pi",
      async start() {
        directoryExistsAtStart = (await stat(workspace)).isDirectory();
        return sessionSpy();
      },
    }));

    try {
      await manager.start("agent-1", config, workspace);
      expect(directoryExistsAtStart).toBe(true);
    } finally {
      await manager.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("becomes offline when the Agent runtime process exits", async () => {
    const session = sessionSpy();
    const manager = new AgentProcessManager(() => ({
      provider: "pi",
      async start() {
        return session;
      },
    }));

    await manager.start("agent-1", config, join(testWorkspaceRoot, "exit", "agent-1"));
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

    await manager.start("agent-1", config, join(testWorkspaceRoot, "multiple", "agent-1"));
    await manager.start("agent-2", config, join(testWorkspaceRoot, "multiple", "agent-2"));
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
    await manager.start(
      "agent-1",
      config,
      join(testWorkspaceRoot, "session", "agent-1"),
      "session-7",
    );
    expect(options?.sessionId).toBe("session-7");
  });

  test("does not retain a runtime when adapter startup fails", async () => {
    const manager = new AgentProcessManager(() => ({
      provider: "pi",
      async start() {
        throw new Error("startup failed");
      },
    }));

    await expect(
      manager.start("agent-1", config, join(testWorkspaceRoot, "failure", "agent-1")),
    ).rejects.toThrow("startup failed");
    expect(manager.size).toBe(0);
  });

  test("blocks replacement when failed startup cannot confirm process-tree cleanup", async () => {
    let starts = 0;
    const manager = new AgentProcessManager(() => ({
      provider: "pi",
      async start() {
        starts++;
        throw new AgentProcessCleanupError();
      },
    }));
    const workspace = join(testWorkspaceRoot, "startup-cleanup", "agent-1");

    await expect(manager.start("agent-1", config, workspace)).rejects.toThrow(
      "process tree did not exit",
    );
    await expect(manager.start("agent-1", config, workspace)).rejects.toThrow("stopping");
    expect(starts).toBe(1);
  });

  test("rejects a replacement start until stop confirms the old session exited", async () => {
    let release!: () => void;
    const exited = new Promise<void>((resolve) => (release = resolve));
    const session = sessionSpy();
    session.dispose = async () => {
      session.disposeCalls += 1;
      await exited;
      session.exit();
    };
    let starts = 0;
    const manager = new AgentProcessManager(() => ({
      provider: "pi",
      async start() {
        starts++;
        return session;
      },
    }));
    const workspace = join(testWorkspaceRoot, "replacement", "agent-1");
    await manager.start("agent-1", config, workspace);
    const stopping = manager.stop("agent-1");
    await expect(manager.start("agent-1", config, workspace)).rejects.toThrow("stopping");
    expect(starts).toBe(1);
    release();
    await stopping;
    await manager.start("agent-1", config, workspace);
    expect(starts).toBe(2);
  });

  test("rejects a replacement start when process-tree termination remains unresolved", async () => {
    const session = sessionSpy();
    session.dispose = async () => {
      session.disposeCalls += 1;
      session.exit();
      throw new Error("tree did not exit");
    };
    let starts = 0;
    const manager = new AgentProcessManager(() => ({
      provider: "pi",
      async start() {
        starts++;
        return session;
      },
    }));
    const workspace = join(testWorkspaceRoot, "unresolved", "agent-1");
    await manager.start("agent-1", config, workspace);

    await expect(manager.stop("agent-1")).rejects.toThrow("tree did not exit");
    await expect(manager.start("agent-1", config, workspace)).rejects.toThrow("stopping");
    expect(starts).toBe(1);
    expect(manager.status("agent-1")).toBe("online");
  });
});
