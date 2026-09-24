import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { DaemonRuntime } from "#src/daemon-runtime/runtime";
import type { AgentRuntimeConfig, AgentSession } from "#src/code-agent/contract";
import type { WorkspaceConfig } from "#src/daemon-runtime/runtime";
import { InMemoryDaemonCredentialStore } from "#src/credentials/credential-store";

/** Focused daemon coverage for self-initiated launches reusing the server's last
 * launchId. Deliberately a new, small file — see the working rules for this branch — copying
 * only the small fixture helpers `daemon-runtime.test.ts` already uses (`sessionSpy`,
 * `agentLaunchConfig`, the `tempRoot`/`connection`/`config` constants). */

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
  } satisfies AgentSession;
}

function agentLaunchConfig(agentApiKey: string) {
  return { agentApiKey };
}

const tempRoot = realpathSync(tmpdir());
const connection: WorkspaceConfig = {
  computerId: "computer-a",
  workspaceId: "workspace-a",
  workspaceRoot: join(tempRoot, `coforge-wake-launch-id-${crypto.randomUUID()}`),
};

const config: AgentRuntimeConfig = {
  provider: "pi",
  model: "default",
  modelProvider: "anthropic",
  reasoning: "balanced",
};

/** Builds a runtime whose provider session exits on demand (via the returned `exit()`), and
 * captures every session report, sent activity, and control result — the same observable
 * surface `daemon-runtime.test.ts`'s rebind test already uses. */
async function harness() {
  const stateDirectory = join(tempRoot, `coforge-wake-launch-id-state-${crypto.randomUUID()}`);
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");
  // Both AgentProcessManager and #launchAgent itself register their own onExit listener on the
  // same session (agent-process-manager.ts:88 and runtime.ts's own `runtime.session.onExit`) —
  // a real provider session supports multiple independent listeners, so this mock must too.
  let exitListeners = new Set<() => void>();
  let sessions = 0;
  const sessionReports: Array<{
    startRequestId: string;
    controlEpoch?: number;
    launchId: string;
    previousLaunchId?: string;
  }> = [];
  const activities: Array<{ launchId: string; clientSeq: number }> = [];
  const controlResults: Array<{
    phase: string;
    requestId: string;
    launchId?: string;
    epoch: number;
  }> = [];
  const runtime = new DaemonRuntime(
    connection,
    () => ({
      provider: "pi",
      async createAgentSession() {
        sessions++;
        exitListeners = new Set();
        return {
          ...sessionSpy(),
          readSessionIdentity: async () => ({
            sessionId: "session-a",
            state: "resumable" as const,
          }),
          notify: async () => {},
          onExit(listener: () => void) {
            exitListeners.add(listener);
            return () => exitListeners.delete(listener);
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
        async requestAgentLaunchConfig() {
          return agentLaunchConfig(`sk_agent_${"a".repeat(43)}`);
        },
        async revokeAgentApiKey() {},
        sendAgentActivity(activity) {
          activities.push({ launchId: activity.launchId, clientSeq: activity.clientSeq });
        },
        async sendAgentControlResult(result) {
          controlResults.push({
            phase: result.phase,
            requestId: result.requestId,
            launchId: result.launchId,
            epoch: result.epoch,
          });
        },
        async reportAgentSession(report) {
          sessionReports.push({
            startRequestId: report.startRequestId,
            controlEpoch: report.controlEpoch,
            launchId: report.launchId,
            previousLaunchId: report.previousLaunchId,
          });
        },
      }),
    },
    undefined,
    {
      runtimes: async () => [],
      cachedCatalogs: async () => ({ catalogs: [], needsRefresh: false }),
      catalogs: async () => [],
    },
    stateDirectory,
  );
  return {
    runtime,
    stateDirectory,
    sessionCount: () => sessions,
    exitProcess: () => {
      if (exitListeners.size === 0) throw new Error("no process to exit");
      const listeners = Array.from(exitListeners);
      for (const listener of listeners) listener();
    },
    sessionReports,
    activities,
    controlResults,
  };
}

function managedStart(agentId: string, requestId: string, epoch: number, launchId: string) {
  return {
    protocolMajor: 1,
    requestId,
    workspaceId: connection.workspaceId,
    computerId: connection.computerId,
    agentId,
    ...config,
    controlEpoch: epoch,
    launchId,
  };
}

async function deliverMessage(
  runtime: DaemonRuntime,
  agentId: string,
  deliveryId: string,
): Promise<void> {
  await runtime.handleAgentMessage({
    protocolMajor: 1,
    requestId: `${deliveryId}-request`,
    messageId: `${deliveryId}-message`,
    deliveryId,
    sequence: 1,
    workspaceId: connection.workspaceId,
    conversationId: "conversation-1",
    agentId,
    body: "wake me",
    method: "agent:v1:message:deliver",
    target: "@agent",
  });
}

test("a wake reuses the remembered launchId and sends no previousLaunchId", async () => {
  const h = await harness();
  try {
    await h.runtime.start(connection);
    await h.runtime.handleAgentStart(managedStart("wake-a", "start-1", 1, "launch-1"));
    expect(h.sessionCount()).toBe(1);
    expect(h.runtime.agentProcessManager.serverLaunch("wake-a")).toMatchObject({
      requestId: "start-1",
      controlEpoch: 1,
      launchId: "launch-1",
    });

    h.exitProcess();
    expect(h.runtime.agentProcessManager.session("wake-a")).toBeUndefined();

    await deliverMessage(h.runtime, "wake-a", "delivery-1");
    expect(h.sessionCount()).toBe(2);

    const woken = h.sessionReports.at(-1);
    expect(woken?.launchId).toBe("launch-1");
    expect(woken?.previousLaunchId).toBeUndefined();
  } finally {
    await h.runtime.stop();
    await rm(h.stateDirectory, { recursive: true, force: true });
  }
});

test("clientSeq continues across a wake instead of restarting at the reused launchId's start", async () => {
  const h = await harness();
  try {
    await h.runtime.start(connection);
    await h.runtime.handleAgentStart(managedStart("wake-b", "start-1", 1, "launch-1"));
    const beforeExit = h.activities
      .filter((a) => a.launchId === "launch-1")
      .map((a) => a.clientSeq);
    expect(beforeExit.length).toBeGreaterThan(0);
    const highWaterMark = Math.max(...beforeExit);
    expect(h.runtime.agentProcessManager.lastClientSeq("wake-b")).toBe(highWaterMark);

    h.exitProcess();
    h.activities.length = 0;
    await deliverMessage(h.runtime, "wake-b", "delivery-1");

    const afterWake = h.activities.filter((a) => a.launchId === "launch-1").map((a) => a.clientSeq);
    expect(afterWake.length).toBeGreaterThan(0);
    for (const clientSeq of afterWake) expect(clientSeq).toBeGreaterThan(highWaterMark);
  } finally {
    await h.runtime.stop();
    await rm(h.stateDirectory, { recursive: true, force: true });
  }
});

test("an explicit Stop forgets the remembered launchId; the next managed Start supplies a new one", async () => {
  const h = await harness();
  try {
    await h.runtime.start(connection);
    await h.runtime.handleAgentStart(managedStart("wake-c", "start-1", 1, "launch-1"));
    expect(h.runtime.agentProcessManager.serverLaunch("wake-c")).toBeDefined();

    await h.runtime.handleAgentStop({
      protocolMajor: 1,
      requestId: "stop-1",
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      agentId: "wake-c",
      provider: "pi",
      controlEpoch: 1,
    });
    expect(h.runtime.agentProcessManager.serverLaunch("wake-c")).toBeUndefined();
    expect(h.runtime.agentProcessManager.session("wake-c")).toBeUndefined();

    await h.runtime.handleAgentStart(managedStart("wake-c", "start-2", 2, "launch-2"));
    expect(h.sessionCount()).toBe(2);
    expect(h.runtime.agentProcessManager.serverLaunch("wake-c")).toMatchObject({
      launchId: "launch-2",
    });
  } finally {
    await h.runtime.stop();
    await rm(h.stateDirectory, { recursive: true, force: true });
  }
});

test("a rebind updates the remembered launchId; a later wake reuses the rebound identity", async () => {
  const h = await harness();
  try {
    await h.runtime.start(connection);
    await h.runtime.handleAgentStart(managedStart("wake-d", "start-1", 1, "launch-1"));
    // A Start with a higher epoch meets the already-running process: rebinds, no
    // second process.
    await h.runtime.handleAgentStart(managedStart("wake-d", "start-2", 2, "launch-2"));
    expect(h.sessionCount()).toBe(1);
    expect(h.runtime.agentProcessManager.serverLaunch("wake-d")).toMatchObject({
      requestId: "start-2",
      controlEpoch: 2,
      launchId: "launch-2",
    });

    h.exitProcess();
    await deliverMessage(h.runtime, "wake-d", "delivery-1");
    const woken = h.sessionReports.at(-1);
    expect(woken?.launchId).toBe("launch-2");
  } finally {
    await h.runtime.stop();
    await rm(h.stateDirectory, { recursive: true, force: true });
  }
});

test("an unmanaged Agent still mints a fresh launchId on every wake", async () => {
  const h = await harness();
  try {
    await h.runtime.start(connection);
    // No controlEpoch/launchId: unmanaged, legacy start.
    await h.runtime.handleAgentStart({
      protocolMajor: 1,
      requestId: "legacy-1",
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      agentId: "wake-e",
      ...config,
    });
    expect(h.runtime.agentProcessManager.serverLaunch("wake-e")).toBeUndefined();
    // Unmanaged launches never call AgentControl (no `.stopped()`/session replay on exit), so
    // observe the minted launchId through the "starting" Activity every launch sends instead of
    // through a session report.
    const first = h.activities.at(-1)?.launchId;
    expect(first).toBeDefined();

    h.exitProcess();
    h.activities.length = 0;
    await deliverMessage(h.runtime, "wake-e", "delivery-1");
    const second = h.activities.at(-1)?.launchId;

    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    expect(h.runtime.agentProcessManager.serverLaunch("wake-e")).toBeUndefined();
  } finally {
    await h.runtime.stop();
    await rm(h.stateDirectory, { recursive: true, force: true });
  }
});

test("wake -> server Start rebinds the woken process instead of failing agent_already_running", async () => {
  const h = await harness();
  try {
    await h.runtime.start(connection);
    await h.runtime.handleAgentStart(managedStart("wake-f", "start-1", 1, "launch-1"));
    h.exitProcess();
    await deliverMessage(h.runtime, "wake-f", "delivery-1");
    expect(h.sessionCount()).toBe(2);

    h.controlResults.length = 0;
    await h.runtime.handleAgentStart(managedStart("wake-f", "start-2", 2, "launch-2"));

    // Rebound, not a second process, and the server's new operation terminates successfully.
    expect(h.sessionCount()).toBe(2);
    const started = h.controlResults.filter((r) => r.phase === "started");
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ requestId: "start-2", epoch: 2, launchId: "launch-2" });
    expect(h.controlResults.some((r) => r.phase === "failed")).toBe(false);
  } finally {
    await h.runtime.stop();
    await rm(h.stateDirectory, { recursive: true, force: true });
  }
});

test("wake -> server Stop stops the woken process and forgets its launch identity", async () => {
  const h = await harness();
  try {
    await h.runtime.start(connection);
    await h.runtime.handleAgentStart(managedStart("wake-g", "start-1", 1, "launch-1"));
    h.exitProcess();
    await deliverMessage(h.runtime, "wake-g", "delivery-1");
    expect(h.sessionCount()).toBe(2);

    await h.runtime.handleAgentStop({
      protocolMajor: 1,
      requestId: "stop-1",
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      agentId: "wake-g",
      provider: "pi",
      controlEpoch: 1,
    });
    expect(h.runtime.agentProcessManager.session("wake-g")).toBeUndefined();
    expect(h.runtime.agentProcessManager.serverLaunch("wake-g")).toBeUndefined();
  } finally {
    await h.runtime.stop();
    await rm(h.stateDirectory, { recursive: true, force: true });
  }
});

test("wake -> idle exit again leaves the record truthfully stopped for a following managed Start", async () => {
  const h = await harness();
  try {
    await h.runtime.start(connection);
    await h.runtime.handleAgentStart(managedStart("wake-h", "start-1", 1, "launch-1"));
    h.exitProcess();
    await deliverMessage(h.runtime, "wake-h", "delivery-1");
    expect(h.sessionCount()).toBe(2);

    // The woken process itself now exits idle again.
    h.exitProcess();
    expect(h.runtime.agentProcessManager.session("wake-h")).toBeUndefined();

    // A following managed Start with a higher epoch must launch fresh (the record correctly
    // reports "stopped", not a stale "running" it could wrongly try to rebind against).
    h.controlResults.length = 0;
    await h.runtime.handleAgentStart(managedStart("wake-h", "start-2", 2, "launch-2"));
    expect(h.sessionCount()).toBe(3);
    const started = h.controlResults.filter((r) => r.phase === "started");
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ requestId: "start-2", epoch: 2, launchId: "launch-2" });
  } finally {
    await h.runtime.stop();
    await rm(h.stateDirectory, { recursive: true, force: true });
  }
});
