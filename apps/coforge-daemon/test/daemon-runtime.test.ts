import { describe, expect, test } from "bun:test";
import { DaemonRuntime } from "../src/daemon-runtime/runtime";
import type {
  AgentRuntimeConfig,
  CodeAgentAdapter,
  CodeAgentSession,
} from "../src/code-agent/contract";
import type { WorkspaceConfig } from "../src/daemon-runtime/runtime";
import { InMemoryDaemonCredentialStore } from "../src/credentials/credential-store";
import {
  CentrifugoWorkspaceTransport,
  type CentrifugeWorkspaceClient,
} from "../src/cloud-transport/workspace-cloud-transport";
import { startAgentProxy, type AgentProxy } from "../src/agent-proxy";

function sessionSpy() {
  return {
    async sendMessage() {},
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

const connection: WorkspaceConfig = {
  computerId: "computer-a",
  workspaceId: "workspace-a",
  workspaceRoot: "/workspaces/workspace-a",
};

const config: AgentRuntimeConfig = {
  provider: "pi",
  model: "default",
  reasoning: "balanced",
};

describe("DaemonRuntime", () => {
  test("passes the persisted server HTTP URL to the Agent API key client", async () => {
    const configuredConnection = {
      ...connection,
      serverHttpUrl: "https://server.example/api/internal/centrifugo",
    };
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "daemon-token");
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        requests.push({
          url: String(input),
          authorization: new Headers(init?.headers).get("authorization"),
        });
        return Response.json({ apiKey: `sk_agent_${"a".repeat(43)}` });
      },
      { preconnect: originalFetch.preconnect },
    );
    const client = connectedClient();
    const runtime = new DaemonRuntime(
      configuredConnection,
      () => ({ provider: "pi", start: async () => sessionSpy() }),
      credentials,
      {
        create: () => new CentrifugoWorkspaceTransport("wss://cloud.example", () => client),
      },
    );
    try {
      await runtime.start(configuredConnection);
      await runtime.startAgent("agent-a", config);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requests).toEqual([
      {
        url: "https://server.example/api/agent-api-keys",
        authorization: "Bearer daemon-token",
      },
    ]);
  });

  test("shares concurrent starts and starts transport once", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let starts = 0;
    const runtime = new DaemonRuntime(
      connection,
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

    const first = runtime.start(connection);
    const second = runtime.start(connection);
    expect(second).toBe(first);
    release();
    await Promise.all([first, second]);
    await runtime.start(connection);
    expect(starts).toBe(1);
    await runtime.stop();
  });

  test("buffers publications delivered synchronously by ready and handles them in order", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const startedAgents: string[] = [];
    let listener: ((intent: Parameters<DaemonRuntime["handleAgentStart"]>[0]) => void) | undefined;
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async start(input) {
          startedAgents.push(input.sessionId ?? "");
          return sessionSpy();
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          onAgentStart(callback) {
            listener = callback;
            return () => {
              listener = undefined;
            };
          },
          async ready() {
            listener?.({
              protocolMajor: 1,
              requestId: "ready-publication-1",
              workspaceId: connection.workspaceId,
              agentId: "agent-a",
              provider: "pi",
              model: "default",
              reasoning: "balanced",
              sessionId: "session-a",
            });
            listener?.({
              protocolMajor: 1,
              requestId: "ready-publication-2",
              workspaceId: connection.workspaceId,
              agentId: "agent-b",
              provider: "pi",
              model: "default",
              reasoning: "balanced",
              sessionId: "session-b",
            });
          },
          async requestAgentApiKey() {
            return `sk_agent_${crypto.randomUUID().replaceAll("-", "").padEnd(43, "a")}`;
          },
          async sendAgentActivity() {},
          async stop() {},
        }),
      },
    );

    await runtime.start(connection);
    expect(startedAgents).toEqual(["session-a", "session-b"]);
    await runtime.stop();
  });

  test("recreates transport after a failed start", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    let created = 0;
    let starts = 0;
    const runtime = new DaemonRuntime(
      connection,
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

    await expect(runtime.start(connection)).rejects.toThrow("start failed");
    await runtime.start(connection);
    expect(starts).toBe(2);
    expect(created).toBe(2);
    await runtime.stop();
  });

  test("removes startup listeners and buffered publications when ready fails", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    let listener: ((intent: Parameters<DaemonRuntime["handleAgentStart"]>[0]) => void) | undefined;
    let unsubscribed = false;
    const runtime = new DaemonRuntime(
      connection,
      () => ({ provider: "pi", start: async () => sessionSpy() }),
      credentials,
      {
        create: () => ({
          async start() {},
          onAgentStart(callback) {
            listener = callback;
            return () => {
              unsubscribed = true;
              listener = undefined;
            };
          },
          async ready() {
            listener?.({
              protocolMajor: 1,
              requestId: "discarded-publication",
              workspaceId: connection.workspaceId,
              agentId: "agent-a",
              provider: "pi",
              model: "default",
              reasoning: "balanced",
              sessionId: "session-a",
            });
            throw new Error("ready failed");
          },
          async stop() {},
        }),
      },
    );

    await expect(runtime.start(connection)).rejects.toThrow("ready failed");
    expect(unsubscribed).toBe(true);
    expect(listener).toBeUndefined();
    expect(runtime.agentProcessManager.size).toBe(0);
  });

  test("releases Agent runtimes when transport stop fails", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    let shutdownTransport = false;
    const runtime = new DaemonRuntime(
      connection,
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
          async requestAgentApiKey() {
            return `sk_agent_${"a".repeat(43)}`;
          },
          async stop() {
            shutdownTransport = true;
            throw new Error("stop failed");
          },
        }),
      },
    );
    await runtime.start(connection);
    await runtime.startAgent("agent-a", config);

    await expect(runtime.stop()).rejects.toThrow("stop failed");
    expect(shutdownTransport).toBe(true);
    expect(runtime.agentProcessManager.size).toBe(0);
  });

  test("waits for an in-flight start before stopping the transport", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    let release!: () => void;
    const started = new Promise<void>((resolve) => (release = resolve));
    const calls: string[] = [];
    const runtime = new DaemonRuntime(
      connection,
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

    const starting = runtime.start(connection);
    const stopping = runtime.stop();
    await Promise.resolve();
    expect(calls).toEqual(["start"]);
    release();
    await Promise.all([starting, stopping]);
    expect(calls).toEqual(["start", "stop"]);
  });

  test("owns one AgentProcessManager for its workspace", async () => {
    const adapter: CodeAgentAdapter = {
      provider: "pi",
      async start() {
        return sessionSpy();
      },
    };
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const transportCalls: unknown[] = [];
    const runtime = new DaemonRuntime(connection, () => adapter, credentials, {
      create: () => ({
        async start(token, config) {
          transportCalls.push([token, config]);
        },
        async ready() {},
        async requestAgentApiKey() {
          return `sk_agent_${"a".repeat(43)}`;
        },
        async stop() {
          transportCalls.push("stop");
        },
      }),
    });

    await runtime.start(connection);
    await runtime.startAgent("agent-a", config);

    expect(runtime.agentProcessManager.size).toBe(1);
    await runtime.stop();
    expect(runtime.agentProcessManager.size).toBe(0);
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
    const credentials = new InMemoryDaemonCredentialStore();
    let starts = 0;
    const runtime = new DaemonRuntime(
      connection,
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

    await expect(runtime.start(connection)).rejects.toThrow("credential is missing");
    await credentials.save(connection.workspaceId, connection.computerId, "retry-token");
    await runtime.start(connection);
    expect(starts).toBe(1);
    await runtime.stop();
  });

  test("shares a concurrent Agent launch and mints one credential", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    let release!: (credential: string) => void;
    const credential = new Promise<string>((resolve) => (release = resolve));
    let mints = 0;
    const runtime = new DaemonRuntime(
      connection,
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
          async stop() {},
          async requestAgentApiKey() {
            mints++;
            return credential;
          },
          async revokeAgentApiKey() {},
        }),
      },
    );
    await runtime.start(connection);
    const first = runtime.startAgent("agent-a", config);
    const second = runtime.startAgent("agent-a", config);
    expect(second).toBe(first);
    expect(mints).toBe(1);
    release(`sk_agent_${"a".repeat(43)}`);
    await Promise.all([first, second]);
    await runtime.stop();
  });

  test("stopAgent during credential mint cancels that launch and permits a later launch", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    let release!: (credential: string) => void;
    const pendingCredential = new Promise<string>((resolve) => (release = resolve));
    const replacementCredential = `sk_agent_${"c".repeat(43)}`;
    let mintCount = 0;
    let childStarts = 0;
    const revoked: string[] = [];
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async start() {
          childStarts++;
          return sessionSpy();
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {},
          async requestAgentApiKey() {
            mintCount++;
            return mintCount === 1 ? pendingCredential : replacementCredential;
          },
          async revokeAgentApiKey(value) {
            revoked.push(value);
          },
        }),
      },
    );
    await runtime.start(connection);
    const launching = runtime.startAgent("agent-a", config);
    const stopping = runtime.stopAgent("agent-a");
    await expect(runtime.startAgent("agent-a", config)).rejects.toThrow("stopping");
    const cancelledCredential = `sk_agent_${"b".repeat(43)}`;
    release(cancelledCredential);
    await expect(launching).rejects.toThrow("stopping");
    await stopping;
    expect(childStarts).toBe(0);
    expect(revoked).toEqual([cancelledCredential]);

    await runtime.startAgent("agent-a", config);
    expect(childStarts).toBe(1);
    await runtime.stop();
  });

  test("an old process exit cannot revoke a replacement launch's local proxy token", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    let releaseOldDispose!: () => void;
    const oldDispose = new Promise<void>((resolve) => (releaseOldDispose = resolve));
    const exitCallbacks: Array<Array<() => void>> = [];
    const proxyTokens: string[] = [];
    let launchCount = 0;
    const proxyFacade: AgentProxy = {
      url: "",
      issue: () => {
        throw new Error("proxy is not initialized");
      },
      revoke: () => undefined,
      close: () => undefined,
    };
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async start(input) {
          launchCount++;
          proxyTokens.push(input.environment?.COFORGE_AGENT_CONTEXT ?? "");
          const currentLaunch = launchCount;
          const launchExitCallbacks: Array<() => void> = [];
          exitCallbacks.push(launchExitCallbacks);
          return {
            ...sessionSpy(),
            onExit(callback) {
              launchExitCallbacks.push(callback);
              return () => undefined;
            },
            async dispose() {
              if (currentLaunch === 1) await oldDispose;
            },
          };
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {},
          async requestAgentApiKey() {
            return `sk_agent_${String.fromCharCode(96 + launchCount + 1).repeat(43)}`;
          },
          async revokeAgentApiKey() {
            throw new Error("remote revoke failed");
          },
        }),
      },
      proxyFacade,
    );
    const proxy = startAgentProxy({ runtime });
    proxyFacade.url = proxy.url;
    proxyFacade.issue = proxy.issue;
    proxyFacade.revoke = proxy.revoke;
    proxyFacade.close = proxy.close;

    try {
      await runtime.start(connection);
      await runtime.startAgent("agent-a", config);
      const stopping = runtime.stopAgent("agent-a");
      await Promise.resolve();
      await expect(runtime.startAgent("agent-a", config)).rejects.toThrow("stopping");
      releaseOldDispose();
      await expect(stopping).rejects.toThrow("remote revoke failed");

      await runtime.startAgent("agent-a", config);
      const replacementToken = proxyTokens[1]!;
      const request = () =>
        fetch(proxy.url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${replacementToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ requestId: "replacement", operation: "check" }),
        });
      expect((await request()).status).toBe(200);
      for (const callback of exitCallbacks[0] ?? []) callback();
      expect((await request()).status).toBe(200);
    } finally {
      proxy.close();
    }
  });

  test("failed remote revoke keeps its handle for shutdown retry and closes local access first", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    let attempts = 0;
    let releaseStop!: () => void;
    const stopGate = new Promise<void>((resolve) => (releaseStop = resolve));
    const proxyRevokes: string[] = [];
    const runtime = new DaemonRuntime(
      connection,
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
            await stopGate;
          },
          async requestAgentApiKey() {
            return `sk_agent_${"c".repeat(43)}`;
          },
          async revokeAgentApiKey() {
            attempts++;
            if (attempts === 1) throw new Error("offline");
          },
        }),
      },
      { url: "http://proxy", issue: () => "proxy-token", revoke: (id) => proxyRevokes.push(id) },
    );
    await runtime.start(connection);
    await runtime.startAgent("agent-a", config);
    const stopping = runtime.stop();
    expect(proxyRevokes).toEqual(["proxy-token"]);
    await expect(runtime.startAgent("agent-b", config)).rejects.toThrow("not running");
    await expect(
      runtime.agentMessage("proxy-token", {
        requestId: "r",
        operation: "check",
        context: "proxy-token",
      }),
    ).rejects.toThrow("not running");
    releaseStop();
    await expect(stopping).rejects.toThrow("offline");
    await runtime.stop();
    expect(attempts).toBe(2);
  });

  test("shutdown retry reuses the authenticated production transport for pending revokes", async () => {
    const configuredConnection = {
      ...connection,
      serverHttpUrl: "https://server.example/api/internal/centrifugo",
    };
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "daemon-token");
    const credential = `sk_agent_${"d".repeat(43)}`;
    const revokeAuthorizations: Array<string | null> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        if (init?.method === "POST") return Response.json({ apiKey: credential });
        revokeAuthorizations.push(new Headers(init?.headers).get("authorization"));
        return revokeAuthorizations.length === 1
          ? new Response(null, { status: 503 })
          : Response.json({ revoked: true });
      },
      { preconnect: originalFetch.preconnect },
    );
    let transportsCreated = 0;
    const runtime = new DaemonRuntime(
      configuredConnection,
      () => ({ provider: "pi", start: async () => sessionSpy() }),
      credentials,
      {
        create: () => {
          transportsCreated++;
          return new CentrifugoWorkspaceTransport("wss://cloud.example", () => connectedClient());
        },
      },
    );
    try {
      await runtime.start(configuredConnection);
      await runtime.startAgent("agent-a", config);
      await expect(runtime.stop()).rejects.toThrow("503");
      await runtime.stop();
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(revokeAuthorizations).toEqual(["Bearer daemon-token", "Bearer daemon-token"]);
    expect(transportsCreated).toBe(2);
  });
});

function connectedClient(): CentrifugeWorkspaceClient {
  let connected: (() => void) | undefined;
  return {
    on(event, callback) {
      if (event === "connected") connected = callback as () => void;
    },
    connect() {
      connected?.();
    },
    disconnect() {},
    async rpc() {},
  };
}
