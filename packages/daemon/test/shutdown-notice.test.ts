import { afterAll, afterEach, expect, setSystemTime, test } from "bun:test";
import { rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DAEMON_RUNTIME_SHUTDOWN_METHOD,
  RUNNER_HOLD_REASONS,
  decodeDaemonRuntimeShutdown,
  type DaemonRuntimeReadyRequest,
  type DaemonRuntimeShutdown,
} from "@lrm/coforge-sdk/internal";
import {
  DaemonConnection,
  type CentrifugeWorkspaceClient,
} from "#src/connection/daemon-connection";
import { DAEMON_SHUTDOWN_NOTICE_TIMEOUT_MS } from "#src/connection/shutdown-notice-timeout";
import { DaemonRuntime, type WorkspaceConfig } from "#src/daemon-runtime/runtime";
import { SHUTDOWN_HOLD_REASON_WINDOW_MS } from "#src/daemon-runtime/shutdown-reason";
import type { AgentRuntimeConfig, AgentSession } from "#src/code-agent/contract";
import { InMemoryDaemonCredentialStore } from "#src/credentials/credential-store";

// macOS tmpdir lives under /var, a symlink; the state store rejects linked ancestors.
const tempRoot = realpathSync(tmpdir());
const workspaceRoot = join(tempRoot, `coforge-shutdown-notice-${crypto.randomUUID()}`);
afterAll(() => rm(workspaceRoot, { recursive: true, force: true }));

const connection: WorkspaceConfig = {
  computerId: "computer-a",
  workspaceId: "workspace-a",
  workspaceRoot,
};

const notice = (): DaemonRuntimeShutdown => ({
  protocolMajor: 1,
  requestId: "shutdown-1",
  workspaceId: "workspace-a",
  computerId: "computer-a",
  workerInstanceId: "worker-a",
  reason: "computer_restart",
});

function fakeClient() {
  let connected = () => {};
  let disconnected = (_context?: { code: number; reason: string }) => {};
  const calls: { method: string; data: Uint8Array }[] = [];
  const client: CentrifugeWorkspaceClient = {
    on(event, callback) {
      if (event === "connected") connected = callback as () => void;
      else if (event === "disconnected") disconnected = callback as typeof disconnected;
    },
    connect() {
      connected();
    },
    disconnect() {},
    rpc: async (method, data) => {
      calls.push({ method, data });
      return new Uint8Array();
    },
  };
  return { client, calls, disconnect: () => disconnected() };
}

function manualTiming() {
  const scheduled: { callback: () => void; delayMs: number }[] = [];
  return {
    scheduled,
    timing: {
      schedule: (callback: () => void, delayMs: number) => {
        scheduled.push({ callback, delayMs });
        return scheduled.length;
      },
      cancel: () => {},
    },
  };
}

const connectionConfig = {
  workspaceId: "workspace-a",
  computerId: "computer-a",
  daemonId: "daemon-a",
  daemonInstanceId: "daemon-instance-a",
  expectedServerUrl: "https://cloud.example",
};

const shutdownCalls = (calls: { method: string; data: Uint8Array }[]) =>
  calls.filter(({ method }) => method === DAEMON_RUNTIME_SHUTDOWN_METHOD);

test("a connected daemon sends its shutdown notice on the shutdown RPC", async () => {
  const fake = fakeClient();
  const transport = new DaemonConnection("wss://cloud.example", () => fake.client);
  await transport.start("secret", connectionConfig);

  await transport.sendShutdownNotice(notice());

  const sent = shutdownCalls(fake.calls);
  expect(sent).toHaveLength(1);
  expect(decodeDaemonRuntimeShutdown(sent[0]!.data)).toEqual(notice());
});

test("a daemon that is not connected sends no shutdown notice", async () => {
  const fake = fakeClient();
  const transport = new DaemonConnection("wss://cloud.example", () => fake.client);
  await transport.start("secret", connectionConfig);
  fake.disconnect();

  await transport.sendShutdownNotice(notice());

  expect(shutdownCalls(fake.calls)).toHaveLength(0);
});

test("a shutdown notice the server never answers gives up after its bound", async () => {
  const fake = fakeClient();
  const manual = manualTiming();
  const transport = new DaemonConnection(
    "wss://cloud.example",
    () => fake.client,
    undefined,
    manual.timing,
  );
  await transport.start("secret", connectionConfig);
  fake.client.rpc = () => new Promise(() => {});

  const sending = transport.sendShutdownNotice(notice());
  const bound = manual.scheduled.find(
    ({ delayMs }) => delayMs === DAEMON_SHUTDOWN_NOTICE_TIMEOUT_MS,
  );
  expect(bound).toBeDefined();
  expect(DAEMON_SHUTDOWN_NOTICE_TIMEOUT_MS).toBeLessThanOrEqual(1_000);
  bound!.callback();

  expect(await sending).toBeUndefined();
});

test("a refused shutdown notice never fails the shutdown", async () => {
  const fake = fakeClient();
  const transport = new DaemonConnection("wss://cloud.example", () => fake.client);
  await transport.start("secret", connectionConfig);
  fake.client.rpc = async () => {
    throw new Error("404 unknown RPC method");
  };

  expect(await transport.sendShutdownNotice(notice())).toBeUndefined();
});

const agentConfig: AgentRuntimeConfig = {
  provider: "pi",
  model: "default",
  modelProvider: "anthropic",
  reasoning: "balanced",
};

/** A runtime with one live Agent whose transport records the order of the shutdown steps. */
async function runtimeHarness(
  hooks: {
    sendShutdownNotice?: (value: DaemonRuntimeShutdown) => Promise<void>;
    revokeAgentApiKey?: () => Promise<void>;
  } = {},
) {
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");
  const steps: string[] = [];
  const notices: DaemonRuntimeShutdown[] = [];
  let ready: DaemonRuntimeReadyRequest | undefined;
  const runtime = new DaemonRuntime(
    connection,
    () => ({
      provider: "pi",
      async createAgentSession() {
        return {
          async sendMessage() {},
          subscribe: () => () => undefined,
          async interrupt() {},
          onExit: () => () => undefined,
          async dispose() {
            steps.push("agent stopped");
          },
        } satisfies AgentSession;
      },
    }),
    credentials,
    {
      create: () => ({
        async start() {},
        async ready(createRequest: () => DaemonRuntimeReadyRequest) {
          ready ??= createRequest();
        },
        async stop() {
          steps.push("connection stopped");
        },
        async requestAgentLaunchConfig() {
          return { agentApiKey: `sk_agent_${"a".repeat(43)}` };
        },
        async revokeAgentApiKey() {
          await hooks.revokeAgentApiKey?.();
        },
        sendAgentActivity() {},
        async sendShutdownNotice(value: DaemonRuntimeShutdown) {
          steps.push("notice sent");
          notices.push(value);
          await hooks.sendShutdownNotice?.(value);
        },
      }),
    },
  );
  await runtime.start(connection);
  await runtime.startAgent("agent-a", agentConfig);
  return { runtime, steps, notices, ready: () => ready };
}

afterEach(() => setSystemTime());

test("a shutdown nobody held for tells the server the Computer is stopping, after its Agents stop and before it disconnects", async () => {
  const { runtime, steps, notices, ready } = await runtimeHarness();

  await runtime.stop();

  expect(steps).toEqual(["agent stopped", "notice sent", "connection stopped"]);
  expect(notices).toEqual([
    {
      protocolMajor: 1,
      requestId: expect.any(String),
      workspaceId: "workspace-a",
      computerId: "computer-a",
      workerInstanceId: ready()!.workerInstanceId,
      reason: "computer_stop",
    },
  ]);
});

test.each([
  [RUNNER_HOLD_REASONS.UPGRADE, "computer_upgrade"],
  [RUNNER_HOLD_REASONS.WORKSPACE_RESTART, "computer_restart"],
  [RUNNER_HOLD_REASONS.COMPUTER_RESTART, "computer_restart"],
] as const)("a shutdown held for %s names it as %s", async (hold, reason) => {
  const { runtime, notices } = await runtimeHarness();

  runtime.holdRunners(hold);
  await runtime.stop();

  expect(notices.map((sent) => sent.reason)).toEqual([reason]);
});

test("a hold released before the shutdown no longer names its reason", async () => {
  const { runtime, notices } = await runtimeHarness();

  runtime.holdRunners(RUNNER_HOLD_REASONS.UPGRADE);
  runtime.releaseRunners();
  await runtime.stop();

  expect(notices.map((sent) => sent.reason)).toEqual(["computer_stop"]);
});

test("a hold left over from an operation that ended long ago does not name a later stop", async () => {
  const { runtime, notices } = await runtimeHarness();
  const heldAt = Date.now();

  setSystemTime(heldAt);
  runtime.holdRunners(RUNNER_HOLD_REASONS.UPGRADE);
  setSystemTime(heldAt + SHUTDOWN_HOLD_REASON_WINDOW_MS + 1);
  await runtime.stop();

  expect(notices.map((sent) => sent.reason)).toEqual(["computer_stop"]);
});

test("a hold still being renewed names the stop that follows it", async () => {
  const { runtime, notices } = await runtimeHarness();
  const heldAt = Date.now();

  setSystemTime(heldAt);
  runtime.holdRunners(RUNNER_HOLD_REASONS.UPGRADE);
  setSystemTime(heldAt + SHUTDOWN_HOLD_REASON_WINDOW_MS);
  runtime.holdRunners(RUNNER_HOLD_REASONS.UPGRADE);
  setSystemTime(heldAt + SHUTDOWN_HOLD_REASON_WINDOW_MS + 1);
  await runtime.stop();

  expect(notices.map((sent) => sent.reason)).toEqual(["computer_upgrade"]);
});

test("the Agent keys are revoked without waiting for the shutdown notice", async () => {
  const notice = Promise.withResolvers<void>();
  const revoked = Promise.withResolvers<void>();
  const { runtime, steps } = await runtimeHarness({
    sendShutdownNotice: () => notice.promise,
    revokeAgentApiKey: async () => revoked.resolve(),
  });

  const stopping = runtime.stop();
  await revoked.promise;
  expect(steps).not.toContain("connection stopped");
  notice.resolve();
  await stopping;

  expect(steps.at(-1)).toBe("connection stopped");
});
