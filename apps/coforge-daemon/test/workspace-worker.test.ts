import { describe, expect, test } from "bun:test";
import { AgentRuntimePool } from "../src/agent-capacity/agent-runtime-pool";
import { WorkspaceWorkerImpl } from "../src/workspace-worker/worker";
import type {
  AgentRuntimeConfig,
  CodeAgentAdapter,
  CodeAgentSession,
} from "../src/code-agent/contract";
import type { WorkspaceConnection } from "../src/workspace-worker/supervisor";
import { InMemoryWorkspaceWorkerCredentialStore } from "../src/workspace-worker/credential-store";

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
  computerId: "computer-a",
  workspaceId: "workspace-a",
  workspaceRoot: "/workspaces/workspace-a",
};

const config: AgentRuntimeConfig = {
  provider: "pi",
  model: "default",
  reasoning: "balanced",
};

describe("WorkspaceWorkerImpl", () => {
  test("shares concurrent starts and starts transport once", async () => {
    const credentials = new InMemoryWorkspaceWorkerCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let starts = 0;
    const worker = new WorkspaceWorkerImpl(
      connection,
      new AgentRuntimePool(1),
      () => ({
        provider: "pi",
        async start() {
          return sessionSpy();
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {
            starts++;
            await gate;
          },
          async ready() {},
          async stop() {},
        }),
      },
    );

    const first = worker.start(connection);
    const second = worker.start(connection);
    expect(second).toBe(first);
    release();
    await Promise.all([first, second]);
    await worker.start(connection);
    expect(starts).toBe(1);
    await worker.stop();
  });

  test("recreates transport after a failed start", async () => {
    const credentials = new InMemoryWorkspaceWorkerCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    let created = 0;
    let starts = 0;
    const worker = new WorkspaceWorkerImpl(
      connection,
      new AgentRuntimePool(1),
      () => ({
        provider: "pi",
        async start() {
          return sessionSpy();
        },
      }),
      credentials,
      {
        create: () => {
          created++;
          const attempt = created;
          return {
            async start() {
              starts++;
              if (attempt === 1) throw new Error("start failed");
            },
            async ready() {},
            async stop() {},
          };
        },
      },
    );

    await expect(worker.start(connection)).rejects.toThrow("start failed");
    await worker.start(connection);
    expect(starts).toBe(2);
    expect(created).toBe(2);
    await worker.stop();
  });

  test("releases Agent runtimes when transport stop fails", async () => {
    const credentials = new InMemoryWorkspaceWorkerCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    let shutdownTransport = false;
    const worker = new WorkspaceWorkerImpl(
      connection,
      new AgentRuntimePool(1),
      () => ({
        provider: "pi",
        async start() {
          return sessionSpy();
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {
            shutdownTransport = true;
            throw new Error("stop failed");
          },
        }),
      },
    );
    await worker.start(connection);
    await worker.startAgent("agent-a", config);

    await expect(worker.stop()).rejects.toThrow("stop failed");
    expect(shutdownTransport).toBe(true);
    expect(worker.agentProcessManager.size).toBe(0);
  });

  test("waits for an in-flight start before stopping the transport", async () => {
    const credentials = new InMemoryWorkspaceWorkerCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    let release!: () => void;
    const started = new Promise<void>((resolve) => (release = resolve));
    const calls: string[] = [];
    const worker = new WorkspaceWorkerImpl(
      connection,
      new AgentRuntimePool(1),
      () => ({
        provider: "pi",
        async start() {
          return sessionSpy();
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {
            calls.push("start");
            await started;
          },
          async ready() {},
          async stop() {
            calls.push("stop");
          },
        }),
      },
    );

    const starting = worker.start(connection);
    const stopping = worker.stop();
    await Promise.resolve();
    expect(calls).toEqual(["start"]);
    release();
    await Promise.all([starting, stopping]);
    expect(calls).toEqual(["start", "stop"]);
  });

  test("owns one AgentProcessManager and uses the shared pool", async () => {
    const pool = new AgentRuntimePool(1);
    const adapter: CodeAgentAdapter = {
      provider: "pi",
      async start() {
        return sessionSpy();
      },
    };
    const credentials = new InMemoryWorkspaceWorkerCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const transportCalls: unknown[] = [];
    const worker = new WorkspaceWorkerImpl(connection, pool, () => adapter, credentials, {
      create: () => ({
        async start(token, config) {
          transportCalls.push([token, config]);
        },
        async ready() {},
        async stop() {
          transportCalls.push("stop");
        },
      }),
    });

    await worker.start(connection);
    await worker.startAgent("agent-a", config);

    expect(worker.agentProcessManager.size).toBe(1);
    expect(pool.size).toBe(1);
    await worker.stop();
    expect(worker.agentProcessManager.size).toBe(0);
    expect(pool.size).toBe(0);
    expect(transportCalls).toEqual([
      [
        "token-a",
        {
          computerId: "computer-a",
          workspaceId: "workspace-a",
        },
      ],
      "stop",
    ]);
  });

  test("fails to start without a credential and can be retried", async () => {
    const credentials = new InMemoryWorkspaceWorkerCredentialStore();
    let starts = 0;
    const worker = new WorkspaceWorkerImpl(
      connection,
      new AgentRuntimePool(1),
      () => ({
        provider: "pi",
        async start() {
          return sessionSpy();
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {
            starts++;
          },
          async ready() {},
          async stop() {},
        }),
      },
    );

    await expect(worker.start(connection)).rejects.toThrow("credential is missing");
    await credentials.save(connection.workspaceId, connection.computerId, "retry-token");
    await worker.start(connection);
    expect(starts).toBe(1);
    await worker.stop();
  });
});
