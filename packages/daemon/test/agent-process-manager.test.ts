import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentProcessManager } from "../src/agent-runtime/agent-process-manager";
import { buildInitialMemoryMd } from "../src/agent-runtime/agent-memory-seed";
import type { AgentSession, AgentRuntimeConfig, AgentSessionOptions } from "@coforge/agent";
import type { CodeAgentProvider } from "../src/code-agent/contract";
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
  } satisfies AgentSession & { disposeCalls: number; exit(): void };
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
    let startedOptions: AgentSessionOptions | undefined;
    const adapter: CodeAgentProvider = {
      provider: "pi",
      async createAgentSession(options) {
        startedOptions = options;
        return session;
      },
    };
    const probedPaths: (string | undefined)[] = [];
    const manager = new AgentProcessManager(
      () => adapter,
      async (path) => {
        probedPaths.push(path);
        return { kind: "config-hook" };
      },
    );

    const workspace = join(testWorkspaceRoot, "a", "agents", "agent-1");
    const runtime = await manager.start("agent-1", config, workspace);

    expect(runtime.config).toEqual(config);
    expect(runtime.session).toBe(session);
    expect(startedOptions).toEqual({
      agentId: "agent-1",
      agentWorkspaceDirectory: workspace,
      environment: undefined,
      instructions: expect.stringContaining(`- Agent workspace: ${workspace}`),
      sessionId: undefined,
      runtime: config,
      gitHooks: { kind: "config-hook" },
    });
    // The commit trailer hook is probed once per launch, against the Agent's own PATH.
    expect(probedPaths).toHaveLength(1);
    expect(probedPaths[0]).toBeTruthy();
    if (!startedOptions) throw new Error("provider was not started");
    expect(startedOptions.instructions.match(/^## Current Runtime Context$/gm)).toHaveLength(1);
    expect(startedOptions.instructions.match(/^- Agent workspace: /gm)).toHaveLength(1);
    expect(startedOptions.instructions.split(workspace)).toHaveLength(2);
    expect(startedOptions.instructions).toContain("## CoForge communication");
    expect(startedOptions.instructions).toContain("coforge message send");
    expect(manager.size).toBe(1);
    expect(manager.status("agent-1")).toBe("active");
    expect(manager.status("agent-2")).toBe("inactive");
    expect(manager.activeAgentIds()).toEqual(["agent-1"]);
    expect(manager.runningAgentIds()).toEqual(["agent-1"]);
    await manager.stop("agent-1");
    expect(session.disposeCalls).toBe(1);
    expect(manager.size).toBe(0);
    expect(manager.status("agent-1")).toBe("inactive");
    expect(manager.activeAgentIds()).toEqual([]);
    expect(manager.runningAgentIds()).toEqual([]);
  });

  test("retains provider configuration for the provider launch", async () => {
    const manager = new AgentProcessManager(() => ({
      provider: "pi",
      async createAgentSession() {
        return sessionSpy();
      },
    }));
    const credentialConfig = {
      ...config,
      providerConfig: {
        kind: "coforge" as const,
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
      kind: "coforge",
      providerId: "deepseek",
      apiKey: "sk-deepseek-secret",
    });
    await manager.stop("agent-credential");
  });

  test("creates the Agent workspace before starting its provider", async () => {
    const root = await mkdtemp(join(tmpdir(), "coforge-agent-runtime-"));
    const workspace = join(root, "workspace", "agents", "agent-1");
    let directoryExistsAtStart = false;
    const manager = new AgentProcessManager(() => ({
      provider: "pi",
      async createAgentSession() {
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

  test("seeds MEMORY.md into the Agent workspace on start, using the server-authored identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "coforge-agent-memory-seed-manager-"));
    const workspace = join(root, "agents", "agent-1");
    const manager = new AgentProcessManager(() => ({
      provider: "pi",
      async createAgentSession() {
        return sessionSpy();
      },
    }));

    try {
      await manager.start(
        "agent-1",
        config,
        workspace,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        [],
        { name: "scout", displayName: "Scout", description: "Reviews pull requests." },
      );
      const content = await readFile(join(workspace, "MEMORY.md"), "utf8");
      expect(content).toBe(
        buildInitialMemoryMd({
          name: "scout",
          displayName: "Scout",
          description: "Reviews pull requests.",
        }),
      );
    } finally {
      await manager.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a second start leaves an Agent-modified MEMORY.md alone", async () => {
    const root = await mkdtemp(join(tmpdir(), "coforge-agent-memory-seed-preserve-"));
    const workspace = join(root, "agents", "agent-1");
    const manager = new AgentProcessManager(() => ({
      provider: "pi",
      async createAgentSession() {
        return sessionSpy();
      },
    }));

    try {
      await manager.start(
        "agent-1",
        config,
        workspace,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        [],
        {
          name: "scout",
        },
      );
      await manager.stop("agent-1");
      const memoryPath = join(workspace, "MEMORY.md");
      const ownedContent = "# Scout\n\n## Role\nKnowledge the Agent accumulated on its own.\n";
      await writeFile(memoryPath, ownedContent, { encoding: "utf8" });

      await manager.start(
        "agent-1",
        config,
        workspace,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        [],
        {
          name: "scout",
          description: "A brand-new description that must not overwrite the file above.",
        },
      );

      expect(await readFile(memoryPath, "utf8")).toBe(ownedContent);
    } finally {
      await manager.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("stays active when the Agent runtime process exits unexpectedly", async () => {
    const session = sessionSpy();
    const manager = new AgentProcessManager(() => ({
      provider: "pi",
      async createAgentSession() {
        return session;
      },
    }));

    await manager.start("agent-1", config, join(testWorkspaceRoot, "exit", "agent-1"));
    session.exit();

    expect(manager.status("agent-1")).toBe("active");
    expect(manager.restartConfig("agent-1")).toEqual({ config, sessionId: undefined });
    expect(manager.activeAgentIds()).toEqual(["agent-1"]);
    expect(manager.runningAgentIds()).toEqual([]);
    await manager.stop("agent-1");
    expect(manager.status("agent-1")).toBe("inactive");
    expect(manager.restartConfig("agent-1")).toBeUndefined();
  });

  test("starts multiple Agent runtimes for distinct Agents", async () => {
    let starts = 0;
    const adapter: CodeAgentProvider = {
      provider: "pi",
      async createAgentSession() {
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
      async createAgentSession(startOptions) {
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

  test("threads the server-authored identity through to the standing instructions", async () => {
    let options: { instructions: string } | undefined;
    const manager = new AgentProcessManager(() => ({
      provider: "pi",
      async createAgentSession(startOptions) {
        options = startOptions;
        return sessionSpy();
      },
    }));
    await manager.start(
      "agent-1",
      config,
      join(testWorkspaceRoot, "identity", "agent-1"),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      [],
      { name: "scout", runtimeContext: { computerName: "Builder Box" } },
    );
    expect(options?.instructions).toContain('You are "scout", an AI agent in CoForge');
    expect(options?.instructions).toContain("- Computer: Builder Box");
  });

  test("does not retain a runtime when provider startup fails", async () => {
    const manager = new AgentProcessManager(() => ({
      provider: "pi",
      async createAgentSession() {
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
      async createAgentSession() {
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
      async createAgentSession() {
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
      async createAgentSession() {
        starts++;
        return session;
      },
    }));
    const workspace = join(testWorkspaceRoot, "unresolved", "agent-1");
    await manager.start("agent-1", config, workspace);

    await expect(manager.stop("agent-1")).rejects.toThrow("tree did not exit");
    await expect(manager.start("agent-1", config, workspace)).rejects.toThrow("stopping");
    expect(starts).toBe(1);
    expect(manager.status("agent-1")).toBe("active");
  });
});
