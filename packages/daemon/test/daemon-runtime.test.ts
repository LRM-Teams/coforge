import { afterAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonRuntime } from "../src/daemon-runtime/runtime";
import {
  AGENT_RUNTIME_EVENT_TYPE,
  AgentProcessCleanupError,
  type AgentRuntimeConfig,
  type AgentRuntimeEvent,
  type CodeAgentAdapter,
  type CodeAgentSession,
} from "../src/code-agent/contract";
import type { WorkspaceConfig } from "../src/daemon-runtime/runtime";
import { InMemoryDaemonCredentialStore } from "../src/credentials/credential-store";
import {
  DaemonConnection,
  type CentrifugeWorkspaceClient,
} from "../src/connection/daemon-connection";
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

const workspaceRoot = join(tmpdir(), `coforge-daemon-runtime-${crypto.randomUUID()}`);
const connection: WorkspaceConfig = {
  computerId: "computer-a",
  workspaceId: "workspace-a",
  workspaceRoot,
};

afterAll(() => rm(workspaceRoot, { recursive: true, force: true }));

const config: AgentRuntimeConfig = {
  provider: "pi",
  model: "default",
  modelProvider: "anthropic",
  reasoning: "balanced",
};

function agentLaunchConfig(
  agentApiKey: string,
  providerConfig?: AgentRuntimeConfig["providerConfig"],
) {
  return { agentApiKey, providerConfig };
}

describe("DaemonRuntime", () => {
  test("reports a fresh external Code Agent snapshot on daemon start", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const updates: unknown[] = [];
    const runtime = new DaemonRuntime(
      connection,
      () => ({ provider: "pi", start: async () => sessionSpy() }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async updateCodeAgents(request) {
            updates.push(request);
          },
          async stop() {},
        }),
      },
      undefined,
      async () => ({
        runtimes: [
          { provider: "codex", version: "0.151.0", displayName: "Codex", kind: "external" },
        ],
        catalogs: [{ provider: "codex", models: [] }],
      }),
    );

    await runtime.start(connection);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      runtimes: [{ provider: "codex", version: "0.151.0", displayName: "Codex", kind: "external" }],
      catalogs: [{ provider: "codex", models: [] }],
    });
    await runtime.stop();
  });

  test("falls back to a current Claude rate-limit observation when direct usage is unavailable", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const listeners = new Set<(event: AgentRuntimeEvent) => void>();
    const adapter: CodeAgentAdapter = {
      provider: "claude-code",
      async readUsage() {
        return null;
      },
      async start() {
        return {
          ...sessionSpy(),
          subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        };
      },
    };
    const runtime = new DaemonRuntime(connection, () => adapter, credentials, {
      create: () => ({
        async start() {},
        async ready() {},
        async requestAgentLaunchConfig() {
          return agentLaunchConfig(`sk_agent_${"a".repeat(43)}`);
        },
        async stop() {},
      }),
    });
    await runtime.start(connection);
    await runtime.startAgent("agent-a", {
      provider: "claude-code",
      model: "claude-sonnet-5",
      reasoning: "high",
    });
    for (const listener of listeners)
      listener({
        type: AGENT_RUNTIME_EVENT_TYPE.USAGE,
        snapshot: {
          provider: "claude-code",
          primary: {
            status: "available",
            windowDurationMinutes: 300,
            resetsAt: "2099-09-04T03:00:00.000Z",
          },
        },
      });

    const result = await runtime.scanUsage("claude-code");
    expect(result.status).toBe("available");
    expect(JSON.parse(new TextDecoder().decode(result.snapshotJson))).toEqual({
      provider: "claude-code",
      primary: {
        status: "available",
        windowDurationMinutes: 300,
        resetsAt: "2099-09-04T03:00:00.000Z",
      },
    });
    await runtime.stop();
  });

  test("does not expose a usage adapter exception in the scan response", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "codex",
        async readUsage() {
          throw new Error("provider token secret at 127.0.0.1");
        },
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
        }),
      },
    );
    await runtime.start(connection);

    const result = await runtime.scanUsage("codex");
    expect(result).toMatchObject({ status: "error", message: "Usage scan failed" });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("127.0.0.1");
    await runtime.stop();
  });

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
        create: () => new DaemonConnection("wss://cloud.example", () => client),
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
              computerId: connection.computerId,
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
              computerId: connection.computerId,
              agentId: "agent-b",
              provider: "pi",
              model: "default",
              reasoning: "balanced",
              sessionId: "session-b",
            });
          },
          async requestAgentLaunchConfig() {
            return agentLaunchConfig(
              `sk_agent_${crypto.randomUUID().replaceAll("-", "").padEnd(43, "a")}`,
            );
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
              computerId: connection.computerId,
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
          async requestAgentLaunchConfig() {
            return agentLaunchConfig(`sk_agent_${"a".repeat(43)}`);
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
        async requestAgentLaunchConfig() {
          return agentLaunchConfig(`sk_agent_${"a".repeat(43)}`);
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

  test("passes the runtime provider config to its adapter without interpreting it", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    let startedCredential: unknown;
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async start(options) {
          startedCredential = options.runtime?.providerConfig;
          return sessionSpy();
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async requestAgentLaunchConfig() {
            return agentLaunchConfig(`sk_agent_${"a".repeat(43)}`, {
              kind: "pi-builtin",
              providerId: "deepseek",
              apiKey: "sk-deepseek-secret",
            });
          },
          async revokeAgentApiKey() {},
          async stop() {},
        }),
      },
    );

    await runtime.start(connection);
    await runtime.startAgent("agent-a", {
      provider: "pi",
      model: "deepseek-chat",
      modelProvider: "deepseek",
      reasoning: "high",
      providerConfig: {
        kind: "pi-builtin",
        providerId: "deepseek",
        apiKey: "sk-deepseek-secret",
      },
    });

    expect(startedCredential).toEqual({
      kind: "pi-builtin",
      providerId: "deepseek",
      apiKey: "sk-deepseek-secret",
    });
    await runtime.stop();
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
          async requestAgentLaunchConfig() {
            mints++;
            return agentLaunchConfig(await credential);
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
          async requestAgentLaunchConfig() {
            mintCount++;
            return agentLaunchConfig(
              mintCount === 1 ? await pendingCredential : replacementCredential,
            );
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
          async agentMessage() {
            return {
              protocolMajor: 1,
              requestId: "replacement",
              accepted: true,
              attentionCount: 0,
              messages: [],
            };
          },
          async requestAgentLaunchConfig() {
            return agentLaunchConfig(
              `sk_agent_${String.fromCharCode(96 + launchCount + 1).repeat(43)}`,
            );
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

  test("publishes current-launch command and tool Activity details", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const activities: import("@coforge/protocol").AgentActivity[] = [];
    const sessions: Array<{
      event(event: Parameters<Parameters<CodeAgentSession["subscribe"]>[0]>[0]): void;
      delayedExit(): void;
    }> = [];
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async start() {
          let listener: Parameters<CodeAgentSession["subscribe"]>[0] = () => undefined;
          const exits: Array<() => void> = [];
          let exited = false;
          const control = {
            event: (event: Parameters<typeof listener>[0]) => listener(event),
            delayedExit: () => {
              for (const exit of exits) exit();
            },
          };
          sessions.push(control);
          return {
            ...sessionSpy(),
            subscribe(next) {
              listener = next;
              return () => undefined;
            },
            onExit(callback) {
              exits.push(callback);
              return () => undefined;
            },
            async dispose() {
              if (!exited) {
                exited = true;
                for (const exit of exits) exit();
              }
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
          sendAgentActivity(activity) {
            activities.push(activity);
          },
          async requestAgentLaunchConfig() {
            return agentLaunchConfig(
              `sk_agent_${crypto.randomUUID().replaceAll("-", "").padEnd(43, "a")}`,
            );
          },
          async revokeAgentApiKey() {},
        }),
      },
    );
    await runtime.start(connection);
    const intent = {
      protocolMajor: 1,
      requestId: "start-1",
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      agentId: "agent-a",
      provider: "pi" as const,
      model: "default",
      reasoning: "balanced",
    };
    await runtime.handleAgentStart(intent);
    sessions[0]!.event({
      type: "activity",
      activity: {
        activity: "running_command",
        level: "info",
        message:
          "printf 012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789",
        occurredAt: "2026-08-29T00:00:00.000Z",
      },
    });
    sessions[0]!.event({
      type: "activity",
      activity: {
        activity: "reading_file",
        level: "info",
        message: "/workspace/src/input.ts",
        occurredAt: "2026-08-29T00:00:00.100Z",
      },
    });
    sessions[0]!.event({
      type: "activity",
      activity: {
        activity: "writing_file",
        level: "info",
        message: "/workspace/src/output.ts",
        occurredAt: "2026-08-29T00:00:00.200Z",
      },
    });
    sessions[0]!.event({
      type: "activity",
      activity: {
        activity: "editing_file",
        level: "info",
        message: "/workspace/src/existing.ts",
        occurredAt: "2026-08-29T00:00:00.300Z",
      },
    });
    sessions[0]!.event({
      type: "activity",
      activity: {
        activity: "using_tool",
        level: "info",
        message: "WebSearch query=CoForge",
        occurredAt: "2026-08-29T00:00:00.400Z",
      },
    });
    sessions[0]!.event({
      type: "activity",
      activity: {
        activity: "error",
        level: "error",
        message: "Provider request failed safely.",
        occurredAt: "2026-08-29T00:00:00.500Z",
      },
    });
    const firstLaunch = activities[0]!.launchId;
    expect(firstLaunch).not.toBe("");
    expect(activities.every((activity) => activity.launchId === firstLaunch)).toBe(true);
    expect(activities.map(({ clientSeq }) => clientSeq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(activities[1]!.message).toBe(
      "printf 012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012",
    );
    expect(activities.slice(2, 6).map(({ message }) => message)).toEqual([
      "/workspace/src/input.ts",
      "/workspace/src/output.ts",
      "/workspace/src/existing.ts",
      "WebSearch query=CoForge",
    ]);
    expect(activities[6]!.message).toBe("Provider request failed safely.");

    const stopping = runtime.stopAgent("agent-a");
    sessions[0]!.event({
      type: "activity",
      activity: {
        activity: "running_command",
        level: "info",
        message: "late command",
        occurredAt: "2026-08-29T00:00:01.000Z",
      },
    });
    await stopping;
    expect(activities.map(({ activity }) => activity)).toEqual([
      "starting",
      "running_command",
      "reading_file",
      "writing_file",
      "editing_file",
      "using_tool",
      "error",
      "stopped",
    ]);

    await runtime.handleAgentStart({ ...intent, requestId: "start-2" });
    const beforeOldCallbacks = activities.length;
    sessions[0]!.event({
      type: "activity",
      activity: {
        activity: "running_command",
        level: "info",
        message: "stale command",
        occurredAt: "2026-08-29T00:00:02.000Z",
      },
    });
    sessions[0]!.delayedExit();
    expect(activities).toHaveLength(beforeOldCallbacks);
    expect(activities.at(-1)!.launchId).not.toBe(firstLaunch);
    expect(activities.at(-1)!.clientSeq).toBe(1);
    await runtime.stop();
  });

  test("reports a safe launch failure and blocks retry when startup cleanup is unresolved", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const activities: import("@coforge/protocol").AgentActivity[] = [];
    let credentialRequests = 0;
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async start() {
          throw new AgentProcessCleanupError();
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {},
          sendAgentActivity(activity) {
            activities.push(activity);
          },
          async requestAgentLaunchConfig() {
            credentialRequests++;
            return agentLaunchConfig(`sk_agent_${"a".repeat(43)}`);
          },
          async revokeAgentApiKey() {},
        }),
      },
    );
    await runtime.start(connection);

    await expect(runtime.startAgent("agent-a", config)).rejects.toThrow(
      "process tree did not exit",
    );
    expect(activities.map(({ activity }) => activity)).toEqual(["starting", "launch_failed"]);
    expect(activities[1]).toMatchObject({
      agentId: "agent-a",
      activity: "launch_failed",
      level: "error",
      clientSeq: 2,
      message: "Agent process cleanup could not be confirmed. Replacement launch is blocked.",
    });
    await expect(runtime.startAgent("agent-a", config)).rejects.toThrow("stopping");
    expect(credentialRequests).toBe(1);
    await runtime.stop().catch(() => undefined);
  });

  test("reports stop failure when process-tree exit cannot be confirmed", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const activities: import("@coforge/protocol").AgentActivity[] = [];
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async start() {
          return {
            ...sessionSpy(),
            async dispose() {
              throw new AgentProcessCleanupError();
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
          sendAgentActivity(activity) {
            activities.push(activity);
          },
          async requestAgentLaunchConfig() {
            return agentLaunchConfig(`sk_agent_${"b".repeat(43)}`);
          },
          async revokeAgentApiKey() {},
        }),
      },
    );
    await runtime.start(connection);
    await runtime.handleAgentStart({
      protocolMajor: 1,
      requestId: "start-stop-failure",
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      agentId: "agent-a",
      provider: "pi",
      model: "default",
      reasoning: "balanced",
    });

    await expect(runtime.stopAgent("agent-a")).rejects.toThrow("process tree did not exit");
    expect(activities.map(({ activity }) => activity)).toEqual(["starting", "stop_failed"]);
    expect(activities[1]).toMatchObject({
      level: "error",
      clientSeq: 2,
      message: "Agent process cleanup could not be confirmed. Replacement launch is blocked.",
    });
    await runtime.stop().catch(() => undefined);
  });

  test("does not publish an old session exit after daemon stop and restart", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const activities: import("@coforge/protocol").AgentActivity[] = [];
    const oldExitListeners: Array<() => void> = [];
    let launches = 0;
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async start() {
          launches++;
          const listeners = launches === 1 ? oldExitListeners : [];
          return {
            ...sessionSpy(),
            onExit(listener) {
              listeners.push(listener);
              return () => undefined;
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
          sendAgentActivity(activity) {
            activities.push(activity);
          },
          async requestAgentLaunchConfig() {
            return agentLaunchConfig(`sk_agent_${String.fromCharCode(97 + launches).repeat(43)}`);
          },
          async revokeAgentApiKey() {},
        }),
      },
    );
    const intent = {
      protocolMajor: 1,
      requestId: "old-launch",
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      agentId: "agent-a",
      provider: "pi" as const,
      model: "default",
      reasoning: "balanced",
    };
    await runtime.start(connection);
    await runtime.handleAgentStart(intent);
    await runtime.stop();
    await runtime.start(connection);
    await runtime.handleAgentStart({ ...intent, requestId: "new-launch" });
    const beforeDelayedExit = activities.length;

    for (const listener of oldExitListeners) listener();

    expect(activities).toHaveLength(beforeDelayedExit);
    expect(activities.at(-1)?.requestId).toBe("new-launch");
    await runtime.stop();
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
          async requestAgentLaunchConfig() {
            return agentLaunchConfig(`sk_agent_${"c".repeat(43)}`);
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
          return new DaemonConnection("wss://cloud.example", () => connectedClient());
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
