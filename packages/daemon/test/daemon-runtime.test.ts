import { afterAll, describe, expect, setSystemTime, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { AGENT_STARTUP_TURN_TEXT, DaemonRuntime } from "../src/daemon-runtime/runtime";
import {
  AGENT_RUNTIME_EVENT_TYPE,
  AgentProcessCleanupError,
  AgentSessionRecoveryError,
  UsageUnavailableError,
  type AgentRuntimeConfig,
  type AgentRuntimeEvent,
  type CodeAgentProvider,
  type AgentSession,
} from "../src/code-agent/contract";
import type { WorkspaceConfig } from "../src/daemon-runtime/runtime";
import { InMemoryDaemonCredentialStore } from "../src/credentials/credential-store";
import {
  DaemonConnection,
  type AgentMessageTransportResponse,
  type CentrifugeWorkspaceClient,
} from "../src/connection/daemon-connection";
import { startAgentProxy, type AgentProxy } from "../src/agent-proxy";
import { AgentPreflightError } from "../src/daemon-runtime/agent-preflight-error";
import {
  AGENT_ACTIVITY_DETAIL_KIND,
  type AgentMessageRequest,
  type TaskRequest,
  type TaskResponse,
} from "@lrm/coforge-sdk/internal";
import { configure, reset, type LogRecord } from "@logtape/logtape";

/** Runs `run()` with a logtape capture sink installed for `coforge.daemon.*`, then restores the
 * previous (unconfigured) logging state. Mirrors the pattern in runtime-inventory-diagnostics.test.ts. */
async function captureLogs<T>(run: () => Promise<T>): Promise<{ result: T; records: LogRecord[] }> {
  const records: LogRecord[] = [];
  await configure({
    reset: true,
    sinks: { capture: (record) => records.push(record) },
    loggers: [
      { category: ["coforge", "daemon"], lowestLevel: "info", sinks: ["capture"] },
      { category: ["logtape", "meta"], lowestLevel: "error", sinks: ["capture"] },
    ],
  });
  try {
    const result = await run();
    return { result, records };
  } finally {
    await reset();
  }
}

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

const emptyCodeAgentDiscovery = {
  runtimes: async () => [],
  cachedCatalogs: async () => ({ catalogs: [], needsRefresh: false }),
  catalogs: async () => [],
};

// macOS tmpdir lives under /var, a symlink; the state store rejects linked ancestors.
const tempRoot = realpathSync(tmpdir());
const workspaceRoot = join(tempRoot, `coforge-daemon-runtime-${crypto.randomUUID()}`);
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

test("ready and reconnect snapshots report the executable version and observed OS", async () => {
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");
  let snapshot: (() => import("@lrm/coforge-sdk/internal").DaemonRuntimeReadyRequest) | undefined;
  const runtime = new DaemonRuntime(
    connection,
    () => ({ provider: "pi", createAgentSession: async () => sessionSpy() }),
    credentials,
    {
      create: () => ({
        async start() {},
        async stop() {},
        async ready(get) {
          snapshot = get;
        },
      }),
    },
    undefined,
    emptyCodeAgentDiscovery,
    workspaceRoot,
    {},
    "9.8.7",
  );
  try {
    await runtime.start(connection);
    const first = snapshot!();
    expect(first.computerVersion).toBe("9.8.7");
    expect(first.platform).toBe(process.platform);
    expect(first.osVersion).toBeTruthy();
    const reconnect = snapshot!();
    expect(reconnect.computerVersion).toBe("9.8.7");
    expect(reconnect.osVersion).toBe(first.osVersion);
    expect(reconnect.requestId).not.toBe(first.requestId);
  } finally {
    await runtime.stop();
  }
});

test("a refused Computer upgrade request reports exactly one failed result with its code instead of being swallowed", async () => {
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-upgrade-refused");
  let requestUpgrade: ((requestId: string, expectedVersion?: string) => Promise<void>) | undefined;
  const sentResults: unknown[] = [];
  let acknowledged = 0;
  const runtime = new DaemonRuntime(
    connection,
    () => ({ provider: "pi", createAgentSession: async () => sessionSpy() }),
    credentials,
    {
      create: () => ({
        async start(_token, transportConfig) {
          requestUpgrade = transportConfig.requestUpgrade;
        },
        async stop() {},
        async ready() {},
        async sendUpgradeResult(result: unknown) {
          sentResults.push(result);
          return true;
        },
      }),
    },
    undefined,
    emptyCodeAgentDiscovery,
    workspaceRoot,
    {
      requestUpgrade: async () => {
        const rejection = new Error(
          "Computer upgrade operation prior-request is still pending; wait for it to finish before starting another",
        );
        (rejection as Error & { code?: string }).code = "UPGRADE_OPERATION_PENDING";
        throw rejection;
      },
      acknowledgeUpgradeResult: async () => {
        acknowledged += 1;
      },
    },
  );
  try {
    await runtime.start(connection);
    await expect(requestUpgrade!("request-refused", "1.2.3")).rejects.toThrow("still pending");
    expect(sentResults).toHaveLength(1);
    expect(sentResults[0]).toMatchObject({
      requestId: "request-refused",
      workspaceId: connection.workspaceId,
      status: "failed",
      errorCode: "UPGRADE_OPERATION_PENDING",
    });
    expect((sentResults[0] as { error: string }).error).toContain("still pending");
    // A refusal is not a terminal receipt this machine owes an acknowledgement flow to; only
    // #reportUpgradeResults' recovered-terminal path calls this.
    expect(acknowledged).toBe(0);
  } finally {
    await runtime.stop();
  }
});

test("a duplicate fenced start wakes the managed runtime without replaying recovery context", async () => {
  const stateDirectory = join(tempRoot, `coforge-managed-wake-${crypto.randomUUID()}`);
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");
  const notices: string[] = [];
  let sessions = 0;
  const runtime = new DaemonRuntime(
    connection,
    () => ({
      provider: "pi",
      async createAgentSession() {
        sessions++;
        return {
          ...sessionSpy(),
          notify: async (notice) => {
            notices.push(notice);
          },
          readSessionIdentity: async () => ({ sessionId: "session-a", state: "resumable" }),
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
        async sendAgentControlResult() {},
        async reportAgentSession() {},
      }),
    },
    undefined,
    emptyCodeAgentDiscovery,
    stateDirectory,
  );
  const intent = {
    protocolMajor: 1,
    requestId: "managed-start",
    workspaceId: connection.workspaceId,
    computerId: connection.computerId,
    agentId: "managed-agent",
    ...config,
    controlEpoch: 1,
    launchId: "launch-managed-1",
  };
  try {
    await runtime.start(connection);
    await runtime.handleAgentStart(intent);
    await runtime.handleAgentStart({
      ...intent,
      wakeMessage: {
        messageId: "wake-message",
        deliveryId: "wake-delivery",
        conversationId: "conversation-a",
        sequence: 2,
        target: "@ada",
        latestSender: "@ada",
        body: "wake only",
      },
      resumeMessages: [
        {
          messageId: "resume-message",
          deliveryId: "resume-delivery",
          conversationId: "conversation-a",
          sequence: 1,
          target: "@ada",
          latestSender: "@ada",
          body: "must be ignored",
        },
      ],
      unreadSummary: { "@grace": 4 },
    });
    expect(sessions).toBe(1);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("wake only");
    expect(notices[0]).not.toContain("must be ignored");
    expect(notices[0]).not.toContain("@grace");
  } finally {
    await runtime.stop();
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("a Start that meets an already-running process rebinds it: exactly one launch, the next session report/status/activity carry the new scope (ADR 0041)", async () => {
  const stateDirectory = join(tempRoot, `coforge-rebind-${crypto.randomUUID()}`);
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");
  let sessions = 0;
  const statuses: { status: string; agentId: string }[] = [];
  const controlResults: { phase: string; requestId: string; launchId?: string; epoch: number }[] =
    [];
  const sessionReports: { startRequestId: string; controlEpoch?: number; launchId: string }[] = [];
  const activities: { launchId: string; clientSeq: number }[] = [];
  const runtime = new DaemonRuntime(
    connection,
    () => ({
      provider: "pi",
      async createAgentSession() {
        sessions++;
        return {
          ...sessionSpy(),
          readSessionIdentity: async () => ({ sessionId: "session-a", state: "resumable" }),
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
        sendAgentStatus(status) {
          statuses.push({ status: status.status, agentId: status.agentId });
        },
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
          });
        },
      }),
    },
    undefined,
    emptyCodeAgentDiscovery,
    stateDirectory,
  );
  const intent = {
    protocolMajor: 1,
    requestId: "rebind-start-1",
    workspaceId: connection.workspaceId,
    computerId: connection.computerId,
    agentId: "rebind-agent",
    ...config,
    controlEpoch: 1,
    launchId: "launch-rebind-1",
  };
  try {
    await runtime.start(connection);
    await runtime.handleAgentStart(intent);
    expect(sessions).toBe(1);
    const startedBeforeRebind = controlResults.filter((r) => r.phase === "started");
    expect(startedBeforeRebind).toHaveLength(1);
    expect(startedBeforeRebind[0]).toMatchObject({ launchId: "launch-rebind-1", epoch: 1 });

    // A new Start — different requestId, higher epoch, a different (server-supplied) launchId —
    // meets the already-running process. It must rebind, not spawn a second one.
    await runtime.handleAgentStart({
      ...intent,
      requestId: "rebind-start-2",
      controlEpoch: 2,
      launchId: "launch-rebind-2",
    });

    // No second process was launched.
    expect(sessions).toBe(1);

    const started = controlResults.filter((r) => r.phase === "started");
    expect(started).toHaveLength(2);
    expect(started[1]).toMatchObject({
      requestId: "rebind-start-2",
      epoch: 2,
      launchId: "launch-rebind-2",
    });

    // The immediate re-report after the rebind carries the new scope.
    const rebound = sessionReports.at(-1);
    expect(rebound).toMatchObject({
      startRequestId: "rebind-start-2",
      controlEpoch: 2,
      launchId: "launch-rebind-2",
    });

    // `agent:status(active)` was re-sent for the rebind.
    expect(statuses.filter((s) => s.status === "active").length).toBeGreaterThanOrEqual(2);

    // A later Activity for this agent (the "starting" activity from the original launch is
    // already emitted; anything emitted from here on must carry the new launchId).
    activities.length = 0;
    await runtime.handleAgentActivityProbe({
      protocolMajor: 1,
      requestId: "probe-1",
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      agentId: "rebind-agent",
      probeId: "probe-1",
    });
    for (const activity of activities) expect(activity.launchId).toBe("launch-rebind-2");
  } finally {
    await runtime.stop();
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("a recreated daemon waits for cloud start and forwards the cloud-selected session", async () => {
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");
  const sessions: Array<string | undefined> = [];
  const modes: Array<string | undefined> = [];
  const make = () =>
    new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async createAgentSession(options) {
          sessions.push(options.sessionId);
          modes.push(options.sessionMode);
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
            return `sk_agent_${"a".repeat(43)}`;
          },
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
    );
  const original = make();
  await original.start(connection);
  expect(sessions).toEqual([]);
  await original.handleAgentStart({
    protocolMajor: 1,
    requestId: "first",
    workspaceId: connection.workspaceId,
    computerId: connection.computerId,
    agentId: "cloud-agent",
    ...config,
    sessionId: "cloud-first",
    sessionMode: "create",
  });
  await original.stop();
  const recreated = make();
  try {
    await recreated.start(connection);
    expect(sessions).toEqual(["cloud-first"]);
    await recreated.handleAgentStart({
      protocolMajor: 1,
      requestId: "second",
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      agentId: "cloud-agent",
      ...config,
      sessionId: "cloud-selected",
      sessionMode: "resume",
    });
    expect(sessions).toEqual(["cloud-first", "cloud-selected"]);
    expect(modes).toEqual(["create", "resume"]);
  } finally {
    await original.stop();
    await recreated.stop();
  }
});

test("returned identity is acknowledged before Agent readiness and retired callbacks are rejected", async () => {
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");
  const reported = Promise.withResolvers<void>();
  const acknowledged = Promise.withResolvers<void>();
  let callback: ((id: string) => Promise<void>) | undefined;
  const reports: import("@lrm/coforge-sdk/internal").AgentSessionReport[] = [];
  const runtime = new DaemonRuntime(
    connection,
    () => ({
      provider: "pi",
      async createAgentSession(options) {
        callback = options.onSessionId;
        await callback!("returned-session");
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
          return `sk_agent_${"a".repeat(43)}`;
        },
        async reportAgentSession(report) {
          reports.push(report);
          reported.resolve();
          await acknowledged.promise;
        },
      }),
    },
  );
  try {
    await runtime.start(connection);
    let ready = false;
    const launch = runtime
      .handleAgentStart({
        protocolMajor: 1,
        requestId: "cloud-start",
        workspaceId: connection.workspaceId,
        computerId: connection.computerId,
        agentId: "reported-agent",
        ...config,
      })
      .then(() => {
        ready = true;
      });
    await reported.promise;
    expect(ready).toBe(false);
    expect(reports[0]).toMatchObject({
      startRequestId: "cloud-start",
      sessionId: "returned-session",
      agentId: "reported-agent",
    });
    acknowledged.resolve();
    await launch;
    await runtime.stop();
    await expect(callback!("late-session")).rejects.toThrow("superseded");
    expect(reports).toHaveLength(1);
  } finally {
    acknowledged.resolve();
    await runtime.stop();
  }
});

test("cloud-authorized wake restores the acknowledged identity with a successor launch fence", async () => {
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");
  const exits: Array<() => void> = [];
  const selected: Array<string | undefined> = [];
  const callbacks: Array<(id: string) => Promise<void>> = [];
  const reports: import("@lrm/coforge-sdk/internal").AgentSessionReport[] = [];
  const runtime = new DaemonRuntime(
    connection,
    () => ({
      provider: "pi",
      async createAgentSession(options) {
        selected.push(options.sessionId);
        callbacks.push(options.onSessionId!);
        await options.onSessionId!("returned-session");
        return {
          ...sessionSpy(),
          onExit(listener: () => void) {
            exits.push(listener);
            return () => {};
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
          return `sk_agent_${"a".repeat(43)}`;
        },
        async reportAgentSession(report) {
          reports.push(report);
          if (reports.length === 3) throw new Error("session ACK lost");
        },
      }),
    },
  );
  try {
    await runtime.start(connection);
    await runtime.handleAgentStart({
      protocolMajor: 1,
      requestId: "cloud-start",
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      agentId: "wake-agent",
      ...config,
    });
    for (const exit of exits.splice(0)) exit();
    await runtime.startAgent("wake-agent", config);
    expect(selected).toEqual([undefined, "returned-session"]);
    expect(reports[1]).toMatchObject({
      startRequestId: "cloud-start",
      previousLaunchId: reports[0]!.launchId,
    });
    expect(reports[1]!.launchId).not.toBe(reports[0]!.launchId);
    await expect(callbacks[0]!("late-old-session")).rejects.toThrow("superseded");
    expect(reports).toHaveLength(2);
    for (const exit of exits.splice(0)) exit();
    await expect(runtime.startAgent("wake-agent", config)).rejects.toThrow("session ACK lost");
    await runtime.handleAgentStart({
      protocolMajor: 1,
      requestId: "cloud-start",
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      agentId: "wake-agent",
      ...config,
      sessionId: "returned-session",
      previousLaunchId: reports[2]!.launchId,
    });
    expect(reports[3]!.previousLaunchId).toBe(reports[2]!.launchId);
  } finally {
    await runtime.stop();
  }
});

function messageRecord(
  sequence: number,
  sender: string,
  target: string,
  id = `message-${sequence}`,
) {
  return {
    id,
    sequence,
    sender,
    target,
    body: `body-${sequence}`,
    createdAt: "2026-09-03T00:00:00Z",
    attachments: [],
  };
}

function agentLaunchConfig(
  agentApiKey: string,
  providerConfig?: AgentRuntimeConfig["providerConfig"],
) {
  return { agentApiKey, providerConfig };
}

async function queueHarness(
  options: {
    credential?: Promise<string>;
    launch?: () => void | Promise<void>;
    notify?: (notice: string) => void | Promise<void>;
    subscribe?: (listener: (event: AgentRuntimeEvent) => void) => void;
    dispose?: () => void | Promise<void>;
    lifecycle?: (event: string) => void;
    activity?: (activity: import("@lrm/coforge-sdk/internal").AgentActivity) => void;
  } = {},
) {
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");
  const notices: string[] = [];
  const acknowledgements: string[] = [];
  let sessions = 0;
  let mints = 0;
  let readyFactory: (() => { runningAgentIds: string[] }) | undefined;
  const runtime = new DaemonRuntime(
    connection,
    () => ({
      provider: "pi",
      async createAgentSession() {
        await options.launch?.();
        sessions++;
        return {
          ...sessionSpy(),
          subscribe(listener: (event: AgentRuntimeEvent) => void) {
            options.subscribe?.(listener);
            return () => undefined;
          },
          async notify(notice: string) {
            notices.push(notice);
            await options.notify?.(notice);
          },
          async dispose() {
            await options.dispose?.();
          },
        };
      },
    }),
    credentials,
    {
      create: () => ({
        async start() {},
        async ready(createRequest) {
          readyFactory = createRequest;
        },
        async stop() {},
        async requestAgentLaunchConfig() {
          mints++;
          return agentLaunchConfig(
            options.credential ? await options.credential : `sk_agent_${"a".repeat(43)}`,
          );
        },
        async revokeAgentApiKey() {},
        sendAgentStatus(status) {
          options.lifecycle?.(`status:${status.status}`);
        },
        sendAgentActivity(activity) {
          options.lifecycle?.(`activity:${activity.detailKind}`);
          options.activity?.(activity);
        },
        async sendAgentDeliveryAck(ack) {
          acknowledgements.push(ack.deliveryId);
          options.lifecycle?.(`ack:${ack.deliveryId}`);
        },
      }),
    },
  );
  await runtime.start(connection);
  return {
    runtime,
    notices,
    acknowledgements,
    sessions: () => sessions,
    mints: () => mints,
    runningAgentIds: () => readyFactory!().runningAgentIds,
    delivery: (sequence: number) =>
      runtime.handleAgentMessage({
        protocolMajor: 1,
        requestId: `request-${sequence}`,
        messageId: `message-${sequence}`,
        deliveryId: `delivery-${sequence}`,
        sequence,
        workspaceId: connection.workspaceId,
        conversationId: "conversation-a",
        agentId: "agent-a",
        body: "private",
        method: "agent:deliver",
        target: "@ada",
      }),
  };
}

async function messageHarness(
  respond: (request: AgentMessageRequest) => Promise<AgentMessageTransportResponse>,
  respondTask?: (request: TaskRequest) => Promise<TaskResponse>,
  respondAttachmentUpload?: (request: Request, agentApiKey?: string) => Promise<Response>,
  respondUploadSessions?: {
    create?: (body: unknown, agentApiKey?: string) => Promise<Response>;
    complete?: (uploadId: string, agentApiKey?: string) => Promise<Response>;
    cancel?: (uploadId: string, agentApiKey?: string) => Promise<Response>;
    get?: (uploadId: string, agentApiKey?: string) => Promise<Response>;
  },
) {
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");
  const runtime = new DaemonRuntime(
    connection,
    () => ({
      provider: "pi",
      createAgentSession: async () => ({ ...sessionSpy(), async notify() {} }),
    }),
    credentials,
    {
      create: () => ({
        async start() {},
        async ready() {},
        async stop() {},
        async requestAgentApiKey() {
          return `sk_agent_${"a".repeat(43)}`;
        },
        async revokeAgentApiKey() {},
        async sendAgentDeliveryAck() {},
        agentMessage: respond,
        agentTask: respondTask,
        agentAttachmentUpload: respondAttachmentUpload,
        agentAttachmentUploadSessionCreate: respondUploadSessions?.create,
        agentAttachmentUploadSessionComplete: respondUploadSessions?.complete,
        agentAttachmentUploadSessionCancel: respondUploadSessions?.cancel,
        agentAttachmentUploadSessionGet: respondUploadSessions?.get,
      }),
    },
  );
  await runtime.start(connection);
  await runtime.startAgent("agent-a", config);
  return {
    runtime,
    context: runtime.issueAgentContext("agent-a"),
    apiKey: `sk_agent_${"a".repeat(43)}`,
    deliver: (sequence: number, target: string) =>
      runtime.handleAgentMessage({
        protocolMajor: 1,
        requestId: `delivery-${sequence}`,
        messageId: `message-${sequence}`,
        deliveryId: `delivery-${sequence}`,
        sequence,
        workspaceId: connection.workspaceId,
        conversationId: "conversation-a",
        agentId: "agent-a",
        body: `body-${sequence}`,
        method: "agent:deliver",
        target,
      }),
  };
}

describe("Agent Task freshness", () => {
  test("reviewer-isolation holds are repeatable without reading, forwarding, or consuming", async () => {
    const messageCalls: AgentMessageRequest[] = [];
    const taskCalls: TaskRequest[] = [];
    const harness = await messageHarness(
      async (request) => {
        messageCalls.push(request);
        return {
          protocolMajor: 1,
          requestId: request.requestId,
          accepted: true,
          attentionCount: 0,
          messages: [],
        };
      },
      async (request) => {
        taskCalls.push(request);
        return { protocolMajor: 1, requestId: request.requestId, tasks: [] };
      },
    );
    try {
      await harness.deliver(4, "#tasks");
      const command = {
        operation: "claim" as const,
        requestId: "claim-withheld",
        target: "#tasks",
        number: 7,
        freshnessContextMode: "withheld" as const,
      };

      expect(await harness.runtime.agentTask(harness.context, command, harness.apiKey)).toEqual({
        tasks: [],
        state: "held",
        freshnessContextMode: "withheld",
        withheldMessageCount: 1,
      });
      expect(await harness.runtime.agentTask(harness.context, command, harness.apiKey)).toEqual({
        tasks: [],
        state: "held",
        freshnessContextMode: "withheld",
        withheldMessageCount: 1,
      });
      expect(messageCalls).toHaveLength(0);
      expect(taskCalls).toHaveLength(0);
    } finally {
      await harness.runtime.stop();
    }
  });

  test("claim isolates exact-target freshness, bounds pending reads, and preserves Task results", async () => {
    const messageCalls: AgentMessageRequest[] = [];
    const upstream = {
      protocolMajor: 1,
      requestId: "claim-forward",
      tasks: [],
      claims: [],
      assignmentReceipt: {
        messageId: "receipt-message",
        content: "claimed",
        assignee: "@agent-a",
        state: "started" as const,
      },
    };
    const harness = await messageHarness(
      async (request) => {
        messageCalls.push(request);
        return {
          protocolMajor: 1,
          requestId: request.requestId,
          accepted: true,
          attentionCount: 1,
          messages: [messageRecord(9, "@alice", request.target)],
        };
      },
      async () => upstream,
    );
    try {
      await harness.deliver(3, "#unrelated");
      const firstTouch = await harness.runtime.agentTask(
        harness.context,
        { operation: "claim", requestId: "first-touch", target: "#tasks", number: 7 },
        harness.apiKey,
      );
      expect(firstTouch).toMatchObject({ state: "held", freshnessContextMode: "inline" });
      expect(messageCalls[0]).toMatchObject({ target: "#tasks", limit: 3 });

      const result = await harness.runtime.agentTask(
        harness.context,
        { operation: "claim", requestId: "claim-forward", target: "#tasks", number: 7 },
        harness.apiKey,
      );
      expect(result).toBe(upstream);
    } finally {
      await harness.runtime.stop();
    }
  });

  test("an unavailable exact-target pending read holds instead of forwarding or consuming", async () => {
    const messageCalls: AgentMessageRequest[] = [];
    const taskCalls: TaskRequest[] = [];
    const harness = await messageHarness(
      async (request) => {
        messageCalls.push(request);
        return {
          protocolMajor: 1,
          requestId: request.requestId,
          accepted: messageCalls.length > 1,
          attentionCount: 1,
          messages: [],
        };
      },
      async (request) => {
        taskCalls.push(request);
        return { protocolMajor: 1, requestId: request.requestId, tasks: [] };
      },
    );
    try {
      await harness.deliver(5, "#tasks");
      const command = {
        operation: "update" as const,
        requestId: "update",
        target: "#tasks",
        number: 7,
      };

      expect(await harness.runtime.agentTask(harness.context, command, harness.apiKey)).toEqual({
        tasks: [],
        state: "held",
        freshnessContextMode: "inline",
        heldMessages: [],
        newMessageCount: 1,
      });
      expect(messageCalls[0]).toMatchObject({
        target: "#tasks",
        fromSequence: 5,
        throughSequence: 5,
        limit: 3,
      });
      expect(taskCalls).toHaveLength(0);

      await harness.runtime.agentTask(harness.context, command, harness.apiKey);
      expect(messageCalls).toHaveLength(2);
      expect(taskCalls).toHaveLength(0);
    } finally {
      await harness.runtime.stop();
    }
  });

  test("amend bypasses local freshness preflight and forwards the complete result", async () => {
    const messageCalls: AgentMessageRequest[] = [];
    const upstream = {
      protocolMajor: 1,
      requestId: "amend",
      tasks: [],
      history: [],
      resourceFollowup: {
        id: "followup-a",
        ownerAgentId: "agent-a",
        owner: "@agent-a",
        fireAt: "2026-09-10T12:00:00.000Z",
        messageId: "message-a",
        conversationId: "conversation-a",
      },
    };
    const harness = await messageHarness(
      async (request) => {
        messageCalls.push(request);
        throw new Error("amend must not read messages");
      },
      async () => upstream,
    );
    try {
      await harness.deliver(2, "#tasks");
      const result = await harness.runtime.agentTask(
        harness.context,
        { operation: "amend", requestId: "amend", target: "#tasks", number: 7, title: "new" },
        harness.apiKey,
      );
      expect(result).toBe(upstream);
      expect(messageCalls).toHaveLength(0);
    } finally {
      await harness.runtime.stop();
    }
  });
});

const recovery = {
  resumeMessages: [],
  unreadSummary: { "@ada": 1 },
};

test("channel check and notification settings use the bound Agent without replacing its session", async () => {
  const calls: AgentMessageRequest[] = [];
  const harness = await messageHarness(async (request) => {
    calls.push(request);
    return {
      protocolMajor: 1,
      requestId: request.requestId,
      accepted: true,
      attentionCount: 0,
      hasMore: false,
      messages:
        request.operation === "check"
          ? [messageRecord(1, "@alice", "#general"), messageRecord(3, "@bob", "#general")]
          : [],
    };
  });
  try {
    await harness.deliver(1, "#general");
    await harness.deliver(3, "#general");
    const checked = await harness.runtime.agentMessage(
      harness.context,
      { requestId: "channel-check", context: harness.context, operation: "check" },
      harness.apiKey,
    );
    expect(checked.messages.map((m) => m.sender)).toEqual(["@alice", "@bob"]);
    for (const operation of ["mute", "unmute"] as const)
      await harness.runtime.agentMessage(
        harness.context,
        { requestId: operation, context: harness.context, operation, target: "#general" },
        harness.apiKey,
      );
    await harness.runtime.agentMessage(
      harness.context,
      {
        requestId: "thread-unfollow",
        context: harness.context,
        operation: "thread-unfollow",
        target: "#general:12345678-0000-4000-8000-000000000001",
      },
      harness.apiKey,
    );
    expect(
      calls.slice(-3).map(({ operation, target, agentId }) => [operation, target, agentId]),
    ).toEqual([
      ["mute", "#general", "agent-a"],
      ["unmute", "#general", "agent-a"],
      ["thread-unfollow", "#general:12345678-0000-4000-8000-000000000001", "agent-a"],
    ]);
  } finally {
    await harness.runtime.stop();
  }
});

test("resolve, react, and unreact reach the transport with messageId, emoji, and the bound Agent", async () => {
  const calls: AgentMessageRequest[] = [];
  const harness = await messageHarness(async (request) => {
    calls.push(request);
    return {
      protocolMajor: 1,
      requestId: request.requestId,
      accepted: true,
      attentionCount: 0,
      messages: request.operation === "resolve" ? [messageRecord(1, "@alice", "#general")] : [],
      messageId: request.operation === "react" || request.operation === "unreact" ? "abcd1234" : "",
    };
  });
  try {
    await harness.runtime.agentMessage(
      harness.context,
      {
        requestId: "resolve-1",
        context: harness.context,
        operation: "resolve",
        messageId: "abcd1234",
      },
      harness.apiKey,
    );
    await harness.runtime.agentMessage(
      harness.context,
      {
        requestId: "react-1",
        context: harness.context,
        operation: "react",
        messageId: "abcd1234",
        emoji: "👍",
      },
      harness.apiKey,
    );
    await harness.runtime.agentMessage(
      harness.context,
      {
        requestId: "unreact-1",
        context: harness.context,
        operation: "unreact",
        messageId: "abcd1234",
        emoji: "👍",
      },
      harness.apiKey,
    );
    expect(
      calls.map(({ operation, messageId, emoji, agentId }) => [
        operation,
        messageId,
        emoji,
        agentId,
      ]),
    ).toEqual([
      ["resolve", "abcd1234", undefined, "agent-a"],
      ["react", "abcd1234", "👍", "agent-a"],
      ["unreact", "abcd1234", "👍", "agent-a"],
    ]);
  } finally {
    await harness.runtime.stop();
  }
});

describe("Agent attachment upload", () => {
  test("authorizes the local context before delegating the multipart request to the transport", async () => {
    const calls: Array<{ agentApiKey: string | undefined }> = [];
    const uploadResponse = Response.json({
      id: "attachment-1",
      fileName: "note.txt",
      contentType: "text/plain",
      sizeBytes: 4,
    });
    const harness = await messageHarness(
      async (request) => ({
        protocolMajor: 1,
        requestId: request.requestId,
        accepted: true,
        attentionCount: 0,
        messages: [],
      }),
      undefined,
      async (_request, agentApiKey) => {
        calls.push({ agentApiKey });
        return uploadResponse;
      },
    );
    try {
      const request = new Request("http://local-proxy.test/api/agent/v1/attachments", {
        method: "POST",
        headers: { "content-type": "multipart/form-data; boundary=b" },
        body: "irrelevant",
      });
      const response = await harness.runtime.agentAttachmentUpload(
        harness.context,
        request,
        harness.apiKey,
      );
      expect(response).toBe(uploadResponse);
      expect(calls).toEqual([{ agentApiKey: harness.apiKey }]);
    } finally {
      await harness.runtime.stop();
    }
  });

  test("rejects an upload from an unrecognized local context before touching the transport", async () => {
    let calls = 0;
    const harness = await messageHarness(
      async (request) => ({
        protocolMajor: 1,
        requestId: request.requestId,
        accepted: true,
        attentionCount: 0,
        messages: [],
      }),
      undefined,
      async () => {
        calls++;
        throw new Error("must not forward an unauthorized upload");
      },
    );
    try {
      const request = new Request("http://local-proxy.test/api/agent/v1/attachments", {
        method: "POST",
        headers: { "content-type": "multipart/form-data; boundary=b" },
        body: "irrelevant",
      });
      await expect(
        harness.runtime.agentAttachmentUpload("forged-context", request, harness.apiKey),
      ).rejects.toThrow();
      expect(calls).toBe(0);
    } finally {
      await harness.runtime.stop();
    }
  });
});

describe("Agent direct-upload sessions", () => {
  test("authorizes the local context before delegating each session operation to the transport", async () => {
    const calls: Array<{ op: string; arg: unknown; agentApiKey: string | undefined }> = [];
    const createResponse = Response.json({ uploadId: "upload-1" }, { status: 201 });
    const completeResponse = Response.json({ uploadId: "upload-1", state: "completed" });
    const cancelResponse = Response.json({ uploadId: "upload-1", state: "canceled" });
    const getResponse = Response.json({ uploadId: "upload-1", state: "pending" });
    const harness = await messageHarness(
      async (request) => ({
        protocolMajor: 1,
        requestId: request.requestId,
        accepted: true,
        attentionCount: 0,
        messages: [],
      }),
      undefined,
      undefined,
      {
        create: async (body, agentApiKey) => {
          calls.push({ op: "create", arg: body, agentApiKey });
          return createResponse;
        },
        complete: async (uploadId, agentApiKey) => {
          calls.push({ op: "complete", arg: uploadId, agentApiKey });
          return completeResponse;
        },
        cancel: async (uploadId, agentApiKey) => {
          calls.push({ op: "cancel", arg: uploadId, agentApiKey });
          return cancelResponse;
        },
        get: async (uploadId, agentApiKey) => {
          calls.push({ op: "get", arg: uploadId, agentApiKey });
          return getResponse;
        },
      },
    );
    try {
      expect(
        await harness.runtime.agentAttachmentUploadSessionCreate(
          harness.context,
          { target: "#general" },
          harness.apiKey,
        ),
      ).toBe(createResponse);
      expect(
        await harness.runtime.agentAttachmentUploadSessionComplete(
          harness.context,
          "upload-1",
          harness.apiKey,
        ),
      ).toBe(completeResponse);
      expect(
        await harness.runtime.agentAttachmentUploadSessionCancel(
          harness.context,
          "upload-1",
          harness.apiKey,
        ),
      ).toBe(cancelResponse);
      expect(
        await harness.runtime.agentAttachmentUploadSessionGet(
          harness.context,
          "upload-1",
          harness.apiKey,
        ),
      ).toBe(getResponse);
      expect(calls).toEqual([
        { op: "create", arg: { target: "#general" }, agentApiKey: harness.apiKey },
        { op: "complete", arg: "upload-1", agentApiKey: harness.apiKey },
        { op: "cancel", arg: "upload-1", agentApiKey: harness.apiKey },
        { op: "get", arg: "upload-1", agentApiKey: harness.apiKey },
      ]);
    } finally {
      await harness.runtime.stop();
    }
  });

  test("rejects a session operation from an unrecognized local context before touching the transport", async () => {
    let calls = 0;
    const harness = await messageHarness(
      async (request) => ({
        protocolMajor: 1,
        requestId: request.requestId,
        accepted: true,
        attentionCount: 0,
        messages: [],
      }),
      undefined,
      undefined,
      {
        create: async () => {
          calls++;
          throw new Error("must not forward an unauthorized create");
        },
      },
    );
    try {
      await expect(
        harness.runtime.agentAttachmentUploadSessionCreate(
          "forged-context",
          { target: "#general" },
          harness.apiKey,
        ),
      ).rejects.toThrow();
      expect(calls).toBe(0);
    } finally {
      await harness.runtime.stop();
    }
  });
});

describe("DaemonRuntime", () => {
  test("orders stop completion before replacement start lifecycle", async () => {
    let releaseDispose!: () => void;
    const disposeGate = new Promise<void>((resolve) => (releaseDispose = resolve));
    const lifecycle: string[] = [];
    const harness = await queueHarness({
      dispose: () => disposeGate,
      lifecycle: (event) => lifecycle.push(event),
    });
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
    await harness.runtime.handleAgentStart(intent);

    const stopping = harness.runtime.handleAgentStop({
      protocolMajor: 1,
      requestId: "stop-1",
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      agentId: "agent-a",
    });
    const restarting = harness.runtime.handleAgentStart({ ...intent, requestId: "start-2" });
    await Bun.sleep(0);
    expect(harness.sessions()).toBe(1);
    expect(lifecycle).toEqual(["status:active", "activity:starting"]);

    releaseDispose();
    await Promise.all([stopping, restarting]);
    expect(harness.sessions()).toBe(2);
    expect(lifecycle).toEqual([
      "status:active",
      "activity:starting",
      "status:inactive",
      "activity:stopped",
      "status:active",
      "activity:starting",
    ]);
    await harness.runtime.stop();
  });

  test("does not control-start a replacement when the same Agent stop fails", async () => {
    let releaseDispose!: () => void;
    const disposeGate = new Promise<void>((resolve) => (releaseDispose = resolve));
    const harness = await queueHarness({
      async dispose() {
        await disposeGate;
        throw new Error("dispose failed");
      },
    });
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
    await harness.runtime.handleAgentStart(intent);

    const stopping = harness.runtime.handleAgentStop({
      protocolMajor: 1,
      requestId: "stop-1",
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      agentId: "agent-a",
    });
    const restarting = harness.runtime.handleAgentStart({ ...intent, requestId: "start-2" });
    const results = Promise.allSettled([stopping, restarting]);
    releaseDispose();
    expect(await results).toEqual([
      expect.objectContaining({ status: "rejected", reason: expect.any(Error) }),
      expect.objectContaining({ status: "rejected", reason: expect.any(Error) }),
    ]);
    expect(harness.sessions()).toBe(1);
    await harness.runtime.stop().catch(() => undefined);
  });

  test("message check drains the events endpoint in one session, honoring the requested limit", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    let launches = 0;
    const checkRequests: Array<{ limit?: number }> = [];
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        createAgentSession: async () => {
          launches++;
          return { ...sessionSpy(), async notify() {} };
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {},
          async requestAgentApiKey() {
            return `sk_agent_${"a".repeat(43)}`;
          },
          async revokeAgentApiKey() {},
          async sendAgentDeliveryAck() {},
          async agentMessage(request) {
            if (request.operation === "check") {
              checkRequests.push(request);
              const round = checkRequests.length;
              return {
                protocolMajor: 1,
                requestId: request.requestId,
                accepted: true,
                attentionCount: round === 1 ? 2 : 0,
                hasMore: round === 1,
                messages:
                  round === 1
                    ? [
                        {
                          id: "message-5",
                          sequence: 5,
                          sender: "@ada",
                          target: "@ada",
                          body: "old message",
                          createdAt: "2026-09-03T00:00:00Z",
                          attachments: [],
                        },
                      ]
                    : round === 2
                      ? [
                          {
                            id: "message-7",
                            sequence: 7,
                            sender: "@ada",
                            target: "@ada",
                            body: "new message",
                            createdAt: "2026-09-03T00:01:00Z",
                            attachments: [],
                          },
                        ]
                      : [],
              };
            }
            return {
              protocolMajor: 1,
              requestId: request.requestId,
              accepted: true,
              attentionCount: 0,
              messages: [],
            };
          },
        }),
      },
    );
    await runtime.start(connection);
    await runtime.startAgent("agent-a", config);
    const context = runtime.issueAgentContext("agent-a");
    await runtime.handleAgentMessage({
      protocolMajor: 1,
      requestId: "delivery-request",
      messageId: "message-7",
      deliveryId: "delivery-7",
      sequence: 7,
      workspaceId: connection.workspaceId,
      conversationId: "conversation-a",
      agentId: "agent-a",
      body: "new message",
      method: "agent:deliver",
      target: "@ada",
    });

    const first = await runtime.agentMessage(
      context,
      { requestId: "check-1", context, operation: "check", limit: 1 },
      `sk_agent_${"a".repeat(43)}`,
    );
    const second = await runtime.agentMessage(
      context,
      { requestId: "check-2", context, operation: "check", limit: 1 },
      `sk_agent_${"a".repeat(43)}`,
    );

    expect(first.messages.map(({ id }) => id)).toEqual(["message-5", "message-7"]);
    expect(first.hasMore).toBe(false);
    expect(second.messages).toEqual([]);
    expect(second.hasMore).toBe(false);
    expect(checkRequests.map((r) => r.limit)).toEqual([1, 1, 1]);
    expect(launches).toBe(1);
    await runtime.stop();
  });

  test.each(["@ada", "@ada:12345678"])(
    "resolves a short thread target for a history read that follows a message check in one session",
    async (target) => {
      const rootId = "12345678-1234-4234-8234-123456789abc";
      const credentials = new InMemoryDaemonCredentialStore();
      await credentials.save(connection.workspaceId, connection.computerId, "token-a");
      let launches = 0;
      const requests: Array<{ before?: string; around?: string; limit?: number }> = [];
      const runtime = new DaemonRuntime(
        connection,
        () => ({
          provider: "pi",
          createAgentSession: async () => {
            launches++;
            return { ...sessionSpy(), async notify() {} };
          },
        }),
        credentials,
        {
          create: () => ({
            async start() {},
            async ready() {},
            async stop() {},
            async requestAgentApiKey() {
              return `sk_agent_${"a".repeat(43)}`;
            },
            async revokeAgentApiKey() {},
            async sendAgentDeliveryAck() {},
            async agentMessage(request) {
              if (request.operation === "check")
                return {
                  protocolMajor: 1,
                  requestId: request.requestId,
                  accepted: true,
                  attentionCount: 0,
                  hasMore: false,
                  messages: [],
                };
              if (
                target.includes(":") &&
                request.target === "@ada" &&
                request.around === "12345678"
              )
                return {
                  protocolMajor: 1,
                  requestId: request.requestId,
                  accepted: true,
                  attentionCount: 0,
                  messages: [
                    {
                      id: rootId,
                      sequence: 1,
                      sender: "@ada",
                      target: "@ada",
                      body: "root",
                      createdAt: "2026-09-03T00:00:00Z",
                      attachments: [],
                    },
                  ],
                };
              requests.push(request);
              return {
                protocolMajor: 1,
                requestId: request.requestId,
                accepted: true,
                attentionCount: 0,
                messages: [],
              };
            },
          }),
        },
      );
      await runtime.start(connection);
      await runtime.startAgent("agent-a", config);
      const context = runtime.issueAgentContext("agent-a");
      await runtime.agentMessage(
        context,
        { requestId: "check-1", context, operation: "check" },
        `sk_agent_${"a".repeat(43)}`,
      );
      await runtime.agentMessage(
        context,
        { requestId: "history", context, operation: "read", target, around: "12345678", limit: 1 },
        `sk_agent_${"a".repeat(43)}`,
      );
      expect(requests.at(-1)).toMatchObject({ around: "12345678", limit: 1 });
      expect(launches).toBe(1);
      await runtime.stop();
    },
  );

  test("uses the full target and short-read position when sending to a short thread target", async () => {
    const rootId = "12345678-1234-4234-8234-123456789abc";
    const fullTarget = `@ada:${rootId}`;
    const requests: AgentMessageRequest[] = [];
    const harness = await messageHarness(async (request) => {
      requests.push(request);
      if (request.target === "@ada")
        return {
          protocolMajor: 1,
          requestId: request.requestId,
          accepted: true,
          attentionCount: 0,
          messages: [messageRecord(1, "@ada", "@ada", rootId)],
        };
      return {
        protocolMajor: 1,
        requestId: request.requestId,
        accepted: true,
        attentionCount: 0,
        messageId: request.operation === "send" ? "sent" : undefined,
        messages: request.operation === "read" ? [messageRecord(7, "@ada", fullTarget)] : [],
      };
    });
    try {
      await harness.runtime.agentMessage(
        harness.context,
        {
          requestId: "read-short",
          context: harness.context,
          operation: "read",
          target: "@ada:12345678",
        },
        harness.apiKey,
      );
      await harness.runtime.agentMessage(
        harness.context,
        {
          requestId: "send-short",
          context: harness.context,
          operation: "send",
          target: "@ada:12345678",
          body: "reply",
        },
        harness.apiKey,
      );
      expect(requests.at(-1)).toMatchObject({
        operation: "send",
        target: fullTarget,
        seenUpToSequence: 7,
      });
    } finally {
      await harness.runtime.stop();
    }
  });

  test("resolves a short channel thread target through its parent channel", async () => {
    const rootId = "abcdef12-1234-4234-8234-123456789abc";
    const fullTarget = `#general:${rootId}`;
    const requests: AgentMessageRequest[] = [];
    const harness = await messageHarness(async (request) => {
      requests.push(request);
      if (request.target === "#general")
        return {
          protocolMajor: 1,
          requestId: request.requestId,
          accepted: true,
          attentionCount: 0,
          messages: [messageRecord(1, "@ada", "#general", rootId)],
        };
      return {
        protocolMajor: 1,
        requestId: request.requestId,
        accepted: true,
        attentionCount: 0,
        messageId: request.operation === "send" ? "sent" : undefined,
        messages: [],
      };
    });
    try {
      await harness.runtime.agentMessage(
        harness.context,
        {
          requestId: "send-channel-thread",
          context: harness.context,
          operation: "send",
          target: "#general:abcdef12",
          body: "thread reply",
        },
        harness.apiKey,
      );
      expect(requests.at(-1)).toMatchObject({
        operation: "send",
        target: fullTarget,
      });
    } finally {
      await harness.runtime.stop();
    }
  });

  test("reuses a short-target held draft token and body when sent with the full target", async () => {
    const rootId = "12345678-1234-4234-8234-123456789abc";
    const fullTarget = `@ada:${rootId}`;
    const sends: AgentMessageRequest[] = [];
    const harness = await messageHarness(async (request) => {
      if (request.target === "@ada")
        return {
          protocolMajor: 1,
          requestId: request.requestId,
          accepted: true,
          attentionCount: 0,
          messages: [messageRecord(1, "@ada", "@ada", rootId)],
        };
      sends.push(request);
      return sends.length === 1
        ? {
            protocolMajor: 1,
            requestId: request.requestId,
            accepted: false,
            attentionCount: 1,
            messages: [],
            sideEffectDecision: "hold",
            holdToken: "opaque-token",
          }
        : {
            protocolMajor: 1,
            requestId: request.requestId,
            accepted: true,
            attentionCount: 0,
            messageId: "sent",
            messages: [],
            sideEffectDecision: "forward",
          };
    });
    try {
      await harness.runtime.agentMessage(
        harness.context,
        {
          requestId: "hold-short",
          context: harness.context,
          operation: "send",
          target: "@ada:12345678",
          body: "original body",
        },
        harness.apiKey,
      );
      await harness.runtime.agentMessage(
        harness.context,
        {
          requestId: "send-full-draft",
          context: harness.context,
          operation: "send",
          target: fullTarget,
          sendDraft: true,
        },
        harness.apiKey,
      );
      expect(sends[1]).toMatchObject({
        target: fullTarget,
        body: "original body",
        holdToken: "opaque-token",
      });
    } finally {
      await harness.runtime.stop();
    }
  });

  test("blocks a top-level send after a more recently read thread, saves the draft (Raft-aligned), and --send-draft resends it unchanged", async () => {
    const rootId = "12345678-1234-4234-8234-123456789abc";
    const sends: AgentMessageRequest[] = [];
    const harness = await messageHarness(async (request) => {
      if (request.operation === "read")
        return {
          protocolMajor: 1,
          requestId: request.requestId,
          accepted: true,
          attentionCount: 0,
          messages: [messageRecord(1, "@ada", request.target)],
        };
      sends.push(request);
      return {
        protocolMajor: 1,
        requestId: request.requestId,
        accepted: true,
        attentionCount: 0,
        messageId: "sent",
        messages: [],
        sideEffectDecision: "forward",
      };
    });
    try {
      await harness.runtime.agentMessage(
        harness.context,
        {
          requestId: "read-thread",
          context: harness.context,
          operation: "read",
          target: `@ada:${rootId}`,
        },
        harness.apiKey,
      );
      const blocked = await harness.runtime
        .agentMessage(
          harness.context,
          {
            requestId: "blocked-send",
            context: harness.context,
            operation: "send",
            target: "@ada",
            body: "top-level reply",
          },
          harness.apiKey,
        )
        .catch((error: unknown) => error);
      expect(blocked).toBeInstanceOf(AgentPreflightError);
      const preflight = blocked as AgentPreflightError;
      expect(preflight.code).toBe("THREAD_CONTEXT_TARGET_CONFIRMATION_REQUIRED");
      expect(preflight.message).toContain("Possible thread target mismatch");
      expect(preflight.message).toContain('coforge message send --send-draft --target "@ada"');
      // Raft-aligned: the guard saves the outgoing content as a draft before refusing, and reports
      // that back so the CLI renders `Draft saved: yes`, not `no`.
      expect(preflight.draftSaved).toBe(true);
      expect(sends).toEqual([]);

      // The saved draft resends unchanged via --send-draft, with no holdToken (there was no hold).
      await harness.runtime.agentMessage(
        harness.context,
        {
          requestId: "resend-saved-draft",
          context: harness.context,
          operation: "send",
          target: "@ada",
          sendDraft: true,
        },
        harness.apiKey,
      );
      expect(sends).toHaveLength(1);
      expect(sends[0]).toMatchObject({
        target: "@ada",
        body: "top-level reply",
        holdToken: undefined,
      });

      // --target-confirmed remains the other bypass, for a fresh (non-draft) send.
      await harness.runtime.agentMessage(
        harness.context,
        {
          requestId: "confirmed-send",
          context: harness.context,
          operation: "send",
          target: "@ada",
          body: "top-level reply",
          targetConfirmed: true,
        },
        harness.apiKey,
      );
      expect(sends).toHaveLength(2);
      expect(sends[1]).toMatchObject({ target: "@ada" });
    } finally {
      await harness.runtime.stop();
    }
  });

  test("a --send-draft resend of a tokenless draft sends as a plain send and rejects --anyway", async () => {
    const rootId = "12345678-1234-4234-8234-123456789abc";
    const sends: AgentMessageRequest[] = [];
    const harness = await messageHarness(async (request) => {
      if (request.operation === "read")
        return {
          protocolMajor: 1,
          requestId: request.requestId,
          accepted: true,
          attentionCount: 0,
          messages: [messageRecord(1, "@ada", request.target)],
        };
      sends.push(request);
      return {
        protocolMajor: 1,
        requestId: request.requestId,
        accepted: true,
        attentionCount: 0,
        messageId: "sent",
        messages: [],
        sideEffectDecision: "forward",
      };
    });
    try {
      await harness.runtime.agentMessage(
        harness.context,
        {
          requestId: "read-thread",
          context: harness.context,
          operation: "read",
          target: `@ada:${rootId}`,
        },
        harness.apiKey,
      );
      await harness.runtime
        .agentMessage(
          harness.context,
          {
            requestId: "blocked-send",
            context: harness.context,
            operation: "send",
            target: "@ada",
            body: "top-level reply",
          },
          harness.apiKey,
        )
        .catch(() => undefined);

      // --anyway has nothing to bypass without a hold token.
      await expect(
        harness.runtime.agentMessage(
          harness.context,
          {
            requestId: "resend-anyway",
            context: harness.context,
            operation: "send",
            target: "@ada",
            sendDraft: true,
            continueAnyway: true,
          },
          harness.apiKey,
        ),
      ).rejects.toThrow("Held draft token is unavailable");
      expect(sends).toEqual([]);

      // Without --anyway, the same tokenless draft resends as an ordinary send.
      await harness.runtime.agentMessage(
        harness.context,
        {
          requestId: "resend-plain",
          context: harness.context,
          operation: "send",
          target: "@ada",
          sendDraft: true,
        },
        harness.apiKey,
      );
      expect(sends).toHaveLength(1);
      expect(sends[0]).toMatchObject({ holdToken: undefined, continueAnyway: undefined });
    } finally {
      await harness.runtime.stop();
    }
  });

  test("the mention-in-content check runs on a --send-draft resend against the effective mentions", async () => {
    const sends: AgentMessageRequest[] = [];
    const harness = await messageHarness(async (request) => {
      sends.push(request);
      return {
        protocolMajor: 1,
        requestId: request.requestId,
        accepted: false,
        attentionCount: 1,
        messages: [],
        sideEffectDecision: "hold",
        holdToken: "opaque-token",
      };
    });
    try {
      await harness.runtime.agentMessage(
        harness.context,
        {
          requestId: "held-send",
          context: harness.context,
          operation: "send",
          target: "@ada",
          body: "hi @ada",
          mentions: [{ type: "user", id: "actor-1", name: "ada" }],
        },
        harness.apiKey,
      );
      expect(sends).toHaveLength(1);

      const rejected = await harness.runtime
        .agentMessage(
          harness.context,
          {
            requestId: "resend-with-bad-override",
            context: harness.context,
            operation: "send",
            target: "@ada",
            sendDraft: true,
            mentions: [{ type: "user", id: "actor-2", name: "ghost" }],
          },
          harness.apiKey,
        )
        .catch((error: unknown) => error);
      expect(rejected).toBeInstanceOf(AgentPreflightError);
      expect((rejected as AgentPreflightError).code).toBe("MENTION_NOT_IN_CONTENT");
      expect((rejected as Error).message).toBe(
        "Structured mention @ghost is not present in the message body.",
      );
      // No second transport call: the daemon caught this before ever reaching the transport.
      expect(sends).toHaveLength(1);
    } finally {
      await harness.runtime.stop();
    }
  });

  test("does not block a top-level send when the parent itself was read more recently than any thread", async () => {
    const rootId = "12345678-1234-4234-8234-123456789abc";
    const sends: AgentMessageRequest[] = [];
    const harness = await messageHarness(async (request) => {
      if (request.operation === "read")
        return {
          protocolMajor: 1,
          requestId: request.requestId,
          accepted: true,
          attentionCount: 0,
          messages: [messageRecord(1, "@ada", request.target)],
        };
      sends.push(request);
      return {
        protocolMajor: 1,
        requestId: request.requestId,
        accepted: true,
        attentionCount: 0,
        messageId: "sent",
        messages: [],
        sideEffectDecision: "forward",
      };
    });
    try {
      await harness.runtime.agentMessage(
        harness.context,
        {
          requestId: "read-thread",
          context: harness.context,
          operation: "read",
          target: `@ada:${rootId}`,
        },
        harness.apiKey,
      );
      await harness.runtime.agentMessage(
        harness.context,
        { requestId: "read-parent", context: harness.context, operation: "read", target: "@ada" },
        harness.apiKey,
      );
      await harness.runtime.agentMessage(
        harness.context,
        {
          requestId: "unconfirmed-send",
          context: harness.context,
          operation: "send",
          target: "@ada",
          body: "top-level reply",
        },
        harness.apiKey,
      );
      expect(sends).toHaveLength(1);
    } finally {
      await harness.runtime.stop();
    }
  });

  test("forwards attachmentIds and mentions on send; --send-draft resend reuses them unless overridden", async () => {
    const sends: AgentMessageRequest[] = [];
    const mentions = [{ type: "user" as const, id: "actor-1", name: "ada" }];
    const harness = await messageHarness(async (request) => {
      sends.push(request);
      if (sends.length === 1)
        return {
          protocolMajor: 1,
          requestId: request.requestId,
          accepted: false,
          attentionCount: 1,
          messages: [],
          sideEffectDecision: "hold",
          holdToken: "opaque-token",
        };
      return {
        protocolMajor: 1,
        requestId: request.requestId,
        accepted: true,
        attentionCount: 0,
        messageId: "sent",
        messages: [],
        sideEffectDecision: "forward",
      };
    });
    try {
      await harness.runtime.agentMessage(
        harness.context,
        {
          requestId: "held-send",
          context: harness.context,
          operation: "send",
          target: "@ada",
          body: "first body @ada",
          attachmentIds: ["attachment-1", "attachment-2"],
          mentions,
        },
        harness.apiKey,
      );
      expect(sends[0]).toMatchObject({
        attachmentIds: ["attachment-1", "attachment-2"],
        mentions,
      });

      await harness.runtime.agentMessage(
        harness.context,
        {
          requestId: "resend-draft",
          context: harness.context,
          operation: "send",
          target: "@ada",
          sendDraft: true,
        },
        harness.apiKey,
      );
      expect(sends[1]).toMatchObject({
        attachmentIds: ["attachment-1", "attachment-2"],
        mentions,
      });
    } finally {
      await harness.runtime.stop();
    }
  });

  test("an explicit --mention on --send-draft replaces the draft's saved mentions", async () => {
    const sends: AgentMessageRequest[] = [];
    const overrideMentions = [{ type: "agent" as const, id: "actor-2", name: "helper" }];
    const harness = await messageHarness(async (request) => {
      sends.push(request);
      if (sends.length === 1)
        return {
          protocolMajor: 1,
          requestId: request.requestId,
          accepted: false,
          attentionCount: 1,
          messages: [],
          sideEffectDecision: "hold",
          holdToken: "opaque-token",
        };
      return {
        protocolMajor: 1,
        requestId: request.requestId,
        accepted: true,
        attentionCount: 0,
        messageId: "sent",
        messages: [],
        sideEffectDecision: "forward",
      };
    });
    try {
      await harness.runtime.agentMessage(
        harness.context,
        {
          requestId: "held-send",
          context: harness.context,
          operation: "send",
          target: "@ada",
          body: "first body @ada @helper",
          mentions: [{ type: "user", id: "actor-1", name: "ada" }],
        },
        harness.apiKey,
      );
      await harness.runtime.agentMessage(
        harness.context,
        {
          requestId: "resend-draft-with-override",
          context: harness.context,
          operation: "send",
          target: "@ada",
          sendDraft: true,
          mentions: overrideMentions,
        },
        harness.apiKey,
      );
      expect(sends[1]).toMatchObject({ mentions: overrideMentions });
    } finally {
      await harness.runtime.stop();
    }
  });

  test("recentUnread from a bypassed hold is returned and advances modelSeen for future sends", async () => {
    const sends: AgentMessageRequest[] = [];
    const harness = await messageHarness(async (request) => {
      if (request.operation !== "send")
        return {
          protocolMajor: 1,
          requestId: request.requestId,
          accepted: true,
          attentionCount: 0,
          messages: [],
        };
      sends.push(request);
      if (sends.length === 1)
        return {
          protocolMajor: 1,
          requestId: request.requestId,
          accepted: true,
          attentionCount: 0,
          messageId: "sent-1",
          messages: [],
          sideEffectDecision: "anyway_accepted",
          recentUnread: [messageRecord(11, "@bea", "@ada")],
        };
      return {
        protocolMajor: 1,
        requestId: request.requestId,
        accepted: true,
        attentionCount: 0,
        messageId: "sent-2",
        messages: [],
        sideEffectDecision: "forward",
      };
    });
    try {
      const result = await harness.runtime.agentMessage(
        harness.context,
        {
          requestId: "anyway-send",
          context: harness.context,
          operation: "send",
          target: "@ada",
          body: "reply",
          continueAnyway: true,
        },
        harness.apiKey,
      );
      expect(result.recentUnread?.map((m) => m.id)).toEqual(["message-11"]);

      await harness.runtime.agentMessage(
        harness.context,
        {
          requestId: "follow-up-send",
          context: harness.context,
          operation: "send",
          target: "@ada",
          body: "follow up",
        },
        harness.apiKey,
      );
      expect(sends[1]).toMatchObject({ seenUpToSequence: 11 });
    } finally {
      await harness.runtime.stop();
    }
  });

  test("an empty read clears only attention that existed when the read started", async () => {
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => (releaseRead = resolve));
    let markReadEntered!: () => void;
    const readEntered = new Promise<void>((resolve) => (markReadEntered = resolve));
    const harness = await messageHarness(async (request) => {
      if (request.operation === "read" && request.requestId === "held-read") {
        markReadEntered();
        await readGate;
      }
      return {
        protocolMajor: 1,
        requestId: request.requestId,
        accepted: true,
        attentionCount: 0,
        messages:
          request.requestId === "check-after-race" ? [messageRecord(9, "@ada", "@ada")] : [],
      };
    });
    try {
      await harness.deliver(7, "@ada");
      const reading = harness.runtime.agentMessage(
        harness.context,
        { requestId: "held-read", context: harness.context, operation: "read", target: "@ada" },
        harness.apiKey,
      );
      await readEntered;
      await harness.deliver(9, "@ada");
      releaseRead();
      await reading;
      const pending = await harness.runtime.agentMessage(
        harness.context,
        { requestId: "check-after-race", context: harness.context, operation: "check" },
        harness.apiKey,
      );
      expect(pending.summaries).toEqual([
        expect.objectContaining({ target: "@ada", latestSequence: 9 }),
      ]);
    } finally {
      releaseRead();
      await harness.runtime.stop();
    }
  });

  test.each([
    ["rejected", false, []],
    ["wrong-target", true, [messageRecord(7, "@bea", "@bea")]],
  ])("a %s read result does not clear target attention", async (_case, accepted, messages) => {
    const harness = await messageHarness(async (request) => ({
      protocolMajor: 1,
      requestId: request.requestId,
      accepted,
      attentionCount: 1,
      messages:
        request.requestId === "check-preserved" ? [messageRecord(7, "@ada", "@ada")] : messages,
    }));
    try {
      await harness.deliver(7, "@ada");
      await harness.runtime.agentMessage(
        harness.context,
        { requestId: "read-result", context: harness.context, operation: "read", target: "@ada" },
        harness.apiKey,
      );
      const pending = await harness.runtime.agentMessage(
        harness.context,
        { requestId: "check-preserved", context: harness.context, operation: "check" },
        harness.apiKey,
      );
      expect(pending.summaries).toEqual([expect.objectContaining({ target: "@ada" })]);
    } finally {
      await harness.runtime.stop();
    }
  });

  test("workspace info without a valid Agent API key is the AGENT_API_KEY_MISSING precondition", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    let forwarded = 0;
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        createAgentSession: async () => ({ ...sessionSpy(), async notify() {} }),
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {},
          requestAgentApiKey: async () => `sk_agent_${"a".repeat(43)}`,
          async workspaceInfo() {
            forwarded += 1;
            return {} as never;
          },
        }),
      },
    );
    await runtime.start(connection);
    await runtime.startAgent("agent-a", config);
    const context = runtime.issueAgentContext("agent-a");

    const rejected = await runtime
      .workspaceInfo(context, { requestId: "r", protocolMajor: 1 }, "not-an-agent-key")
      .catch((error: unknown) => error);

    expect(rejected).toBeInstanceOf(AgentPreflightError);
    expect((rejected as AgentPreflightError).code).toBe("AGENT_API_KEY_MISSING");
    expect(forwarded).toBe(0);
    await runtime.stop();
  });

  test("version answers coforge version's local-only query from the already-running process, without a transport call", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-version");
    const runtime = new DaemonRuntime(
      connection,
      () => ({ provider: "pi", createAgentSession: async () => sessionSpy() }),
      credentials,
      { create: () => ({ async start() {}, async ready() {}, async stop() {} }) },
      undefined,
      emptyCodeAgentDiscovery,
      workspaceRoot,
      {},
      "9.8.7",
    );
    try {
      await runtime.start(connection);
      // `issueAgentContext` only needs the runtime started, not an actually-launched Agent
      // process (`#agentIdForContext` reads the same map `#authorizedAgent` checks); `version()`
      // never touches the Agent runtime itself.
      const context = runtime.issueAgentContext("agent-a");
      const response = await runtime.version(context, {}, `sk_agent_${"a".repeat(43)}`);
      expect(response.ok).toBe(true);
      expect(response.daemonVersion).toBeTruthy();
      expect(response.computerVersion).toBe("9.8.7");
      expect(response.daemonPid).toBe(process.pid);
      expect(typeof response.startedAt).toBe("number");
    } finally {
      await runtime.stop();
    }
  });

  test("version without a valid Agent API key is the AGENT_API_KEY_MISSING precondition", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-version-invalid");
    const runtime = new DaemonRuntime(
      connection,
      () => ({ provider: "pi", createAgentSession: async () => sessionSpy() }),
      credentials,
      { create: () => ({ async start() {}, async ready() {}, async stop() {} }) },
      undefined,
      emptyCodeAgentDiscovery,
      workspaceRoot,
      {},
      "9.8.7",
    );
    try {
      await runtime.start(connection);
      const context = runtime.issueAgentContext("agent-a");
      const rejected = await runtime
        .version(context, {}, "not-an-agent-key")
        .catch((error: unknown) => error);
      expect(rejected).toBeInstanceOf(AgentPreflightError);
      expect((rejected as AgentPreflightError).code).toBe("AGENT_API_KEY_MISSING");
    } finally {
      await runtime.stop();
    }
  });

  test("message check drains multiple event pages, stops when hasMore is false, and clears attention only for returned targets", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const limits: Array<number | undefined> = [];
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        createAgentSession: async () => ({ ...sessionSpy(), async notify() {} }),
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
          async sendAgentDeliveryAck() {},
          async agentMessage(request) {
            limits.push(request.limit);
            const round = limits.length;
            if (round === 1)
              return {
                protocolMajor: 1,
                requestId: request.requestId,
                accepted: true,
                attentionCount: 2,
                hasMore: true,
                messages: [messageRecord(1, "@ada", "@ada"), messageRecord(2, "@bea", "@bea")],
              };
            return {
              protocolMajor: 1,
              requestId: request.requestId,
              accepted: true,
              attentionCount: 0,
              hasMore: false,
              messages: [],
            };
          },
        }),
      },
    );
    await runtime.start(connection);
    await runtime.startAgent("agent-a", config);
    await runtime.handleAgentMessage({
      protocolMajor: 1,
      requestId: "delivery-1",
      messageId: "message-1",
      deliveryId: "delivery-1",
      sequence: 1,
      workspaceId: connection.workspaceId,
      conversationId: "conversation-a",
      agentId: "agent-a",
      body: "body-1",
      method: "agent:deliver",
      target: "@ada",
    });
    await runtime.handleAgentMessage({
      protocolMajor: 1,
      requestId: "delivery-untouched",
      messageId: "message-untouched",
      deliveryId: "delivery-untouched",
      sequence: 9,
      workspaceId: connection.workspaceId,
      conversationId: "conversation-b",
      agentId: "agent-a",
      body: "body-9",
      method: "agent:deliver",
      target: "@carl",
    });
    const context = runtime.issueAgentContext("agent-a");
    const result = await runtime.agentMessage(
      context,
      { requestId: "check-drain", context, operation: "check", limit: 2 },
      `sk_agent_${"a".repeat(43)}`,
    );

    expect(limits).toEqual([2, 2]);
    expect(result.messages.map(({ id }) => id)).toEqual(["message-1", "message-2"]);
    expect(result.hasMore).toBe(false);

    // @ada's attention (sequence 1) is fully drained; @carl's attention was never returned and
    // stays intact; @bea had no prior attention entry, so recording it seen is a harmless no-op.
    const second = await runtime.agentMessage(
      context,
      { requestId: "check-after", context, operation: "check" },
      `sk_agent_${"a".repeat(43)}`,
    );
    expect(second.summaries.map((s) => s.target)).toEqual(["@carl"]);
    await runtime.stop();
  });

  test("preserves a server-held draft and returns its opaque token only to the server", async () => {
    const stateDirectory = join(tempRoot, `coforge-message-drafts-${crypto.randomUUID()}`);
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const operations: string[] = [];
    const messageRequests: Array<{ requestId: string; holdToken?: string }> = [];
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        createAgentSession: async () => ({ ...sessionSpy(), async notify() {} }),
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {},
          async requestAgentApiKey() {
            return `sk_agent_${"a".repeat(43)}`;
          },
          async revokeAgentApiKey() {},
          async sendAgentDeliveryAck() {},
          async agentMessage(request) {
            operations.push(request.operation);
            messageRequests.push({ requestId: request.requestId, holdToken: request.holdToken });
            return request.requestId === "send-1"
              ? {
                  protocolMajor: 1,
                  requestId: request.requestId,
                  accepted: false,
                  attentionCount: 1,
                  sideEffectDecision: "hold" as const,
                  holdToken: "server-opaque-token",
                  messages: [
                    {
                      id: "message-7",
                      sequence: 7,
                      sender: "@ada",
                      target: "@agent",
                      body: "new context",
                      createdAt: "2026-09-03T00:00:00Z",
                      attachments: [],
                    },
                  ],
                }
              : {
                  protocolMajor: 1,
                  requestId: request.requestId,
                  accepted: true,
                  attentionCount: 0,
                  messageId: "sent",
                  messages: [],
                  sideEffectDecision: "forward" as const,
                };
          },
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
      stateDirectory,
    );
    await runtime.start(connection);
    await runtime.startAgent("agent-a", config);
    const context = runtime.issueAgentContext("agent-a");
    await runtime.handleAgentMessage({
      protocolMajor: 1,
      requestId: "delivery-request",
      messageId: "message-7",
      deliveryId: "delivery-7",
      sequence: 7,
      workspaceId: connection.workspaceId,
      conversationId: "conversation-a",
      agentId: "agent-a",
      body: "new context",
      method: "agent:deliver",
      target: "@ada",
    });

    const held = await runtime.agentMessage(
      context,
      { requestId: "send-1", context, operation: "send", target: "@ada", body: "reply" },
      `sk_agent_${"a".repeat(43)}`,
    );
    expect(held).toMatchObject({
      accepted: false,
      sideEffectDecision: "hold",
      messages: [{ id: "message-7" }],
    });
    expect(held).not.toHaveProperty("seenUpToSequence");
    expect(held).not.toHaveProperty("holdToken");
    expect(operations).toEqual(["send"]);
    expect(messageRequests).toEqual([{ requestId: "send-1" }]);

    await runtime.stop();
    const recoveredRuntime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        createAgentSession: async () => ({ ...sessionSpy(), async notify() {} }),
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {},
          async requestAgentApiKey() {
            return `sk_agent_${"b".repeat(43)}`;
          },
          async revokeAgentApiKey() {},
          async sendAgentDeliveryAck() {},
          async agentMessage(request) {
            operations.push(request.operation);
            messageRequests.push({ requestId: request.requestId, holdToken: request.holdToken });
            return {
              protocolMajor: 1,
              requestId: request.requestId,
              accepted: true,
              attentionCount: 0,
              messageId: "sent",
              messages: [],
              sideEffectDecision: "forward" as const,
            };
          },
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
      stateDirectory,
    );
    await recoveredRuntime.start(connection);
    await recoveredRuntime.startAgent("agent-a", config);
    const recoveredContext = recoveredRuntime.issueAgentContext("agent-a");

    const sent = await recoveredRuntime.agentMessage(
      recoveredContext,
      {
        requestId: "send-2",
        context: recoveredContext,
        operation: "send",
        target: "@ada",
        sendDraft: true,
      },
      `sk_agent_${"a".repeat(43)}`,
    );
    expect(sent).toMatchObject({ accepted: true, sideEffectDecision: "forward" });
    expect(operations).toEqual(["send", "send"]);
    expect(messageRequests).toEqual([
      { requestId: "send-1" },
      { requestId: "send-2", holdToken: "server-opaque-token" },
    ]);

    await expect(
      recoveredRuntime.agentMessage(
        recoveredContext,
        {
          requestId: "send-cleared",
          context: recoveredContext,
          operation: "send",
          target: "@ada",
          sendDraft: true,
        },
        `sk_agent_${"a".repeat(43)}`,
      ),
    ).rejects.toThrow("No held draft");

    const ordinarySend = await recoveredRuntime.agentMessage(
      recoveredContext,
      {
        requestId: "send-3",
        context: recoveredContext,
        operation: "send",
        target: "@ada",
        body: "follow-up",
      },
      `sk_agent_${"a".repeat(43)}`,
    );
    expect(ordinarySend).toMatchObject({ accepted: true, sideEffectDecision: "forward" });
    expect(operations).toEqual(["send", "send", "send"]);
    expect(messageRequests.at(-1)).toEqual({ requestId: "send-3", holdToken: undefined });
    await recoveredRuntime.stop();
    await rm(stateDirectory, { recursive: true, force: true });
  });

  test("a withheld send forwards the mode, redacts bodies locally, and prefers the server's count", async () => {
    const requests: AgentMessageRequest[] = [];
    const harness = await messageHarness(async (request) => {
      requests.push(request);
      return {
        protocolMajor: 1,
        requestId: request.requestId,
        accepted: false,
        attentionCount: 3,
        // An older server that has not adopted the mode may still echo message bodies; the
        // daemon must redact them locally regardless, and fall back to attentionCount only
        // when the server omits withheldMessageCount.
        messages: [messageRecord(9, "@ada", "@ada")],
        sideEffectDecision: "hold" as const,
        freshnessContextMode: "withheld" as const,
        ...(request.requestId === "send-server-count" ? { withheldMessageCount: 5 } : {}),
      };
    });
    try {
      const noServerCount = await harness.runtime.agentMessage(
        harness.context,
        {
          requestId: "send-no-server-count",
          context: harness.context,
          operation: "send",
          target: "@ada",
          body: "reply",
          freshnessContextMode: "withheld",
        },
        harness.apiKey,
      );
      expect(noServerCount).toMatchObject({
        messages: [],
        freshnessContextMode: "withheld",
        withheldMessageCount: 3,
      });

      const withServerCount = await harness.runtime.agentMessage(
        harness.context,
        {
          requestId: "send-server-count",
          context: harness.context,
          operation: "send",
          target: "@ada",
          body: "reply",
          freshnessContextMode: "withheld",
        },
        harness.apiKey,
      );
      expect(withServerCount).toMatchObject({
        messages: [],
        freshnessContextMode: "withheld",
        withheldMessageCount: 5,
      });

      expect(requests).toHaveLength(2);
      for (const request of requests)
        expect(request).toMatchObject({ operation: "send", freshnessContextMode: "withheld" });
    } finally {
      await harness.runtime.stop();
    }
  });

  test("keeps an Agent active without a process, wakes it for a message, and deactivates it", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const exits = new Set<() => void>();
    const statuses: import("@lrm/coforge-sdk/internal").AgentStatus[] = [];
    const notices: string[] = [];
    const acknowledgements: string[] = [];
    let starts = 0;
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        createAgentSession: async () => ({
          ...sessionSpy(),
          notify: async (notice) => {
            notices.push(notice);
          },
          onExit(listener) {
            exits.add(listener);
            return () => exits.delete(listener);
          },
        }),
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          sendAgentStatus(status) {
            statuses.push(status);
          },
          async sendAgentDeliveryAck(ack) {
            acknowledgements.push(ack.deliveryId);
          },
          async requestAgentApiKey() {
            starts++;
            return `sk_agent_${"a".repeat(43)}`;
          },
          async revokeAgentApiKey() {},
          async stop() {},
        }),
      },
    );

    await runtime.start(connection);
    await runtime.startAgent("agent-a", config);
    expect(statuses.map(({ agentId, status }) => ({ agentId, status }))).toEqual([
      { agentId: "agent-a", status: "active" },
    ]);

    for (const exit of exits) exit();
    expect(statuses.map(({ agentId, status }) => ({ agentId, status }))).toEqual([
      { agentId: "agent-a", status: "active" },
    ]);
    expect(runtime.agentProcessManager.session("agent-a")).toBeUndefined();

    await runtime.handleAgentMessage({
      protocolMajor: 1,
      requestId: "message-request-1",
      messageId: "message-1",
      deliveryId: "delivery-1",
      sequence: 1,
      workspaceId: connection.workspaceId,
      conversationId: "conversation-1",
      agentId: "agent-a",
      body: "private body",
      method: "agent:deliver",
      target: "@agent",
    });
    expect(starts).toBe(2);
    expect(notices).toEqual([
      "[CoForge inbox notice:\nInbox update: 1 unread message total; 1 changed target\n@agent  pending: 1 message\nRun `coforge message check` to read pending messages.]",
    ]);
    expect(acknowledgements).toEqual(["delivery-1"]);

    await runtime.stopAgent("agent-a");
    expect(statuses.at(-1)?.status).toBe("inactive");
    await runtime.stop();
  });

  test("reports active Agents inactive before a graceful daemon shutdown", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const statuses: import("@lrm/coforge-sdk/internal").AgentStatus[] = [];
    let statusAtTransportStop: string | undefined;
    const runtime = new DaemonRuntime(
      connection,
      () => ({ provider: "pi", createAgentSession: async () => sessionSpy() }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          sendAgentStatus(status) {
            statuses.push(status);
          },
          async requestAgentApiKey() {
            return `sk_agent_${"a".repeat(43)}`;
          },
          async revokeAgentApiKey() {},
          async stop() {
            statusAtTransportStop = statuses.at(-1)?.status;
          },
        }),
      },
    );

    await runtime.start(connection);
    await runtime.startAgent("agent-a", config);
    await Bun.sleep(2);
    await runtime.stop();

    expect(statuses.map(({ status }) => status)).toEqual(["active", "inactive"]);
    expect(new Set(statuses.map(({ observedAtMs }) => observedAtMs)).size).toBe(1);
    expect(statusAtTransportStop).toBe("inactive");
  });

  test("reports runtimes without waiting for catalog discovery, then catalogs in a second update", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const updates: unknown[] = [];
    const secondUpdate = Promise.withResolvers<void>();
    const catalogDiscovery =
      Promise.withResolvers<import("@lrm/coforge-sdk/internal").CodeAgentModelCatalog[]>();
    let catalogDiscoveryStarted = false;
    const runtime = new DaemonRuntime(
      connection,
      () => ({ provider: "pi", createAgentSession: async () => sessionSpy() }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async updateCodeAgents(request) {
            updates.push(request);
            if (updates.length === 2) secondUpdate.resolve();
          },
          async stop() {},
        }),
      },
      undefined,
      {
        runtimes: async () => [{ provider: "codex", version: "0.151.0", displayName: "Codex" }],
        cachedCatalogs: async () => ({ catalogs: [], needsRefresh: true }),
        catalogs: async () => {
          // Never resolves until the assertion below releases it: proves start() does not wait.
          catalogDiscoveryStarted = true;
          return catalogDiscovery.promise;
        },
      },
    );

    await runtime.start(connection);
    expect(catalogDiscoveryStarted).toBe(true);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      runtimes: [{ provider: "codex", version: "0.151.0", displayName: "Codex" }],
      catalogs: [],
    });

    catalogDiscovery.resolve([{ provider: "codex", models: [] }]);
    await secondUpdate.promise;
    expect(updates).toHaveLength(2);
    expect(updates[1]).toMatchObject({
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      runtimes: [{ provider: "codex", version: "0.151.0", displayName: "Codex" }],
      catalogs: [{ provider: "codex", models: [] }],
    });
    await runtime.stop();
  });

  test("skips the background catalog refresh when the cached catalogs are already fresh", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const updates: unknown[] = [];
    let catalogDiscoveryCalls = 0;
    const runtime = new DaemonRuntime(
      connection,
      () => ({ provider: "pi", createAgentSession: async () => sessionSpy() }),
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
      {
        runtimes: async () => [{ provider: "codex", version: "0.151.0", displayName: "Codex" }],
        cachedCatalogs: async () => ({
          catalogs: [{ provider: "codex", models: [] }],
          needsRefresh: false,
        }),
        catalogs: async () => {
          catalogDiscoveryCalls++;
          return [{ provider: "codex", models: [] }];
        },
      },
    );

    await runtime.start(connection);
    // Give a scheduled-but-unwanted background task a chance to run before asserting it didn't.
    await Bun.sleep(2);
    expect(catalogDiscoveryCalls).toBe(0);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ catalogs: [{ provider: "codex", models: [] }] });
    await runtime.stop();
  });

  test("falls back to a current Claude rate-limit observation when direct usage is unavailable", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const listeners = new Set<(event: AgentRuntimeEvent) => void>();
    const adapter: CodeAgentProvider = {
      provider: "claude-code",
      async readUsage() {
        return null;
      },
      async createAgentSession() {
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
    const { collectedAt, ...snapshot } = JSON.parse(new TextDecoder().decode(result.snapshotJson));
    // Stamped when the usage event was observed, not "now" when this later scan reused it.
    expect(typeof collectedAt).toBe("string");
    expect(snapshot).toEqual({
      provider: "claude-code",
      primary: {
        status: "available",
        windowDurationMinutes: 300,
        resetsAt: "2099-09-04T03:00:00.000Z",
      },
    });
    await runtime.stop();
  });

  test("an observed usage snapshot keeps the time it was observed, not the later scan time", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const listeners = new Set<(event: AgentRuntimeEvent) => void>();
    const adapter: CodeAgentProvider = {
      provider: "claude-code",
      async readUsage() {
        return null;
      },
      async createAgentSession() {
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
    try {
      await runtime.start(connection);
      await runtime.startAgent("agent-a", {
        provider: "claude-code",
        model: "claude-sonnet-5",
        reasoning: "high",
      });
      setSystemTime(new Date("2026-09-17T00:00:00.000Z"));
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
      // The scan itself happens an hour later; the reused snapshot must still report when it was
      // actually observed, not this later moment.
      setSystemTime(new Date("2026-09-17T01:00:00.000Z"));
      const result = await runtime.scanUsage("claude-code");
      const { collectedAt } = JSON.parse(new TextDecoder().decode(result.snapshotJson));
      expect(collectedAt).toBe("2026-09-17T00:00:00.000Z");
    } finally {
      setSystemTime();
      await runtime.stop();
    }
  });

  test("scans Kiro quota and distinguishes an unrepresentable window from expired authentication", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const snapshot = {
      provider: "kiro" as const,
      primary: {
        usedPercent: 37,
        windowDurationMinutes: 43200,
        resetsAt: "2026-10-01T00:00:00.000Z",
      },
    };
    let outcome: "available" | "unavailable" | "reauth" = "available";
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "kiro",
        async readUsage() {
          if (outcome === "unavailable") throw new UsageUnavailableError();
          if (outcome === "reauth") return null;
          return snapshot;
        },
        async createAgentSession() {
          return sessionSpy();
        },
      }),
      credentials,
      { create: () => ({ async start() {}, async ready() {}, async stop() {} }) },
    );
    await runtime.start(connection);
    try {
      const result = await runtime.scanUsage("kiro");
      expect(result.status).toBe("available");
      const { collectedAt, ...decoded } = JSON.parse(new TextDecoder().decode(result.snapshotJson));
      expect(typeof collectedAt).toBe("string");
      expect(decoded).toEqual(snapshot);
      outcome = "unavailable";
      expect((await runtime.scanUsage("kiro")).status).toBe("unavailable");
      outcome = "reauth";
      expect((await runtime.scanUsage("kiro")).status).toBe("reauth");
    } finally {
      await runtime.stop();
    }
  });

  test("does not expose a usage provider exception in the scan response", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "codex",
        async readUsage() {
          throw new Error("provider token secret at 127.0.0.1");
        },
        async createAgentSession() {
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
        const url = String(input);
        // Other DaemonRuntime instances in this test file may still have a background Code Agent
        // catalog refresh in flight; only this test's own target host is under test here.
        if (url.startsWith("https://server.example/"))
          requests.push({ url, authorization: new Headers(init?.headers).get("authorization") });
        return Response.json({ apiKey: `sk_agent_${"a".repeat(43)}` });
      },
      { preconnect: originalFetch.preconnect },
    );
    const client = connectedClient();
    const runtime = new DaemonRuntime(
      configuredConnection,
      () => ({ provider: "pi", createAgentSession: async () => sessionSpy() }),
      credentials,
      {
        create: () => new DaemonConnection("wss://cloud.example", () => client),
      },
      undefined,
      emptyCodeAgentDiscovery,
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
        async createAgentSession() {
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

  test("starts all ready publications without blocking other Agents on a slow launch", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const startedAgents: string[] = [];
    let releaseFirstCredential!: () => void;
    const firstCredential = new Promise<void>((resolve) => (releaseFirstCredential = resolve));
    let secondAgentActive!: () => void;
    const secondActive = new Promise<void>((resolve) => (secondAgentActive = resolve));
    let listener: ((intent: Parameters<DaemonRuntime["handleAgentStart"]>[0]) => void) | undefined;
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async createAgentSession(input) {
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
          async requestAgentLaunchConfig({ agentId }) {
            if (agentId === "agent-a") await firstCredential;
            return agentLaunchConfig(
              `sk_agent_${crypto.randomUUID().replaceAll("-", "").padEnd(43, "a")}`,
            );
          },
          sendAgentStatus({ agentId, status }) {
            if (agentId === "agent-b" && status === "active") secondAgentActive();
          },
          async sendAgentActivity() {},
          async stop() {},
        }),
      },
    );

    const starting = runtime.start(connection);
    try {
      await secondActive;
      expect(startedAgents).toEqual(["session-b"]);
      releaseFirstCredential();
      await starting;
      expect(startedAgents).toEqual(["session-b", "session-a"]);
    } finally {
      releaseFirstCredential();
      await starting;
      await runtime.stop();
    }
  });

  test("flushes buffered starts before delivery without losing starts received during flush", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    let startListener:
      | ((intent: Parameters<DaemonRuntime["handleAgentStart"]>[0]) => void)
      | undefined;
    let messageListener:
      | ((message: Parameters<DaemonRuntime["handleAgentMessage"]>[0]) => void)
      | undefined;
    const events: string[] = [];
    let notifyStarted!: () => void;
    const notifying = new Promise<void>((resolve) => (notifyStarted = resolve));
    let releaseNotify!: () => void;
    const notifyGate = new Promise<void>((resolve) => (releaseNotify = resolve));
    let releaseSecondCredential!: () => void;
    const secondCredential = new Promise<void>((resolve) => (releaseSecondCredential = resolve));
    let secondAgentActive!: () => void;
    const secondActive = new Promise<void>((resolve) => (secondAgentActive = resolve));
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        createAgentSession: async ({ agentId }) => {
          events.push(`start:${agentId}`);
          return {
            ...sessionSpy(),
            async notify() {
              events.push(`notify:${agentId}`);
              notifyStarted();
              await notifyGate;
            },
          };
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          onAgentStart(callback) {
            startListener = callback;
            return () => {};
          },
          onAgentMessage(callback) {
            messageListener = callback;
            return () => {};
          },
          async ready() {
            messageListener?.({
              protocolMajor: 1,
              requestId: "delivery-1",
              messageId: "message-1",
              deliveryId: "delivery-1",
              sequence: 1,
              workspaceId: connection.workspaceId,
              conversationId: "conversation-a",
              agentId: "agent-a",
              body: "hello",
              method: "agent:deliver",
              target: "@ada",
            });
            startListener?.({
              protocolMajor: 1,
              requestId: "start-1",
              workspaceId: connection.workspaceId,
              computerId: connection.computerId,
              agentId: "agent-a",
              provider: "pi",
              model: "default",
              reasoning: "balanced",
            });
          },
          async requestAgentLaunchConfig({ agentId }) {
            if (agentId === "agent-b") await secondCredential;
            return agentLaunchConfig(`sk_agent_${"a".repeat(43)}`);
          },
          sendAgentStatus({ agentId, status }) {
            if (agentId === "agent-b" && status === "active") secondAgentActive();
          },
          async sendAgentDeliveryAck() {},
          async stop() {},
        }),
      },
    );

    const starting = runtime.start(connection);
    try {
      await notifying;
      startListener?.({
        protocolMajor: 1,
        requestId: "start-2",
        workspaceId: connection.workspaceId,
        computerId: connection.computerId,
        agentId: "agent-b",
        provider: "pi",
        model: "default",
        reasoning: "balanced",
      });
      releaseNotify();
      await starting;
      // Live starts received during the initial flush run independently. Wait
      // for the observable active status, not a timer tick or initial startup.
      expect(events).toEqual(["start:agent-a", "notify:agent-a"]);
      releaseSecondCredential();
      await secondActive;

      expect(events).toEqual(["start:agent-a", "notify:agent-a", "start:agent-b"]);
    } finally {
      releaseNotify();
      releaseSecondCredential();
      await starting;
      await runtime.stop();
    }
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
        async createAgentSession() {
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
      () => ({ provider: "pi", createAgentSession: async () => sessionSpy() }),
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
        async createAgentSession() {
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
    const entered = Promise.withResolvers<void>();
    let release!: () => void;
    const started = new Promise<void>((resolve) => (release = resolve));
    const calls: string[] = [];
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async createAgentSession() {
          return sessionSpy();
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {
            calls.push("start");
            entered.resolve();
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
    await entered.promise;
    expect(calls).toEqual(["start"]);
    release();
    await Promise.all([starting, stopping]);
    expect(calls).toEqual(["start", "stop"]);
  });

  test("owns one AgentProcessManager for its workspace", async () => {
    const adapter: CodeAgentProvider = {
      provider: "pi",
      async createAgentSession() {
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

  test("passes the runtime provider config to its provider without interpreting it", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    let startedCredential: unknown;
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async createAgentSession(options) {
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
              kind: "coforge",
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
        kind: "coforge",
        providerId: "deepseek",
        apiKey: "sk-deepseek-secret",
      },
    });

    expect(startedCredential).toEqual({
      kind: "coforge",
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
        async createAgentSession() {
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

  test("reports Message received after acceptance and before ACK, once per injection", async () => {
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const events: string[] = [];
    const activities: import("@lrm/coforge-sdk/internal").AgentActivity[] = [];
    const harness = await queueHarness({
      lifecycle: (event) => events.push(event),
      activity: (activity) => activities.push(activity),
      notify: async () => {
        entered.resolve();
        await gate.promise;
        events.push("accepted");
      },
    });
    try {
      await harness.runtime.startAgent("agent-a", config);
      events.length = 0;
      const delivery = harness.delivery(1);
      await entered.promise;
      expect(events).toEqual([]);
      gate.resolve();
      await delivery;
      expect(events).toEqual(["accepted", "activity:message_received", "ack:delivery-1"]);
      expect(activities[1]).toMatchObject({
        agentId: "agent-a",
        detailKind: "message_received",
        detail: "Message received",
        level: "info",
        entries: [],
        launchId: activities[0]!.launchId,
        clientSeq: activities[0]!.clientSeq + 1,
      });
      await harness.delivery(1);
      expect(activities).toHaveLength(2);
      expect(harness.notices).toHaveLength(1);
    } finally {
      gate.resolve();
      await harness.runtime.stop();
    }
  });

  test.each(["wake", "resume", "summary"])(
    "reports accepted %s recovery only for concrete messages",
    async (kind) => {
      const entered = Promise.withResolvers<void>();
      const gate = Promise.withResolvers<void>();
      const activities: import("@lrm/coforge-sdk/internal").AgentActivity[] = [];
      const harness = await queueHarness({
        activity: (activity) => activities.push(activity),
        notify: async () => {
          entered.resolve();
          await gate.promise;
        },
      });
      const message = {
        messageId: "recovery-message",
        deliveryId: "recovery-delivery",
        conversationId: "conversation-a",
        sequence: 1,
        target: "@ada",
        latestSender: "@ada",
        body: "hello",
      };
      try {
        const launch = harness.runtime.startAgent("agent-a", config, undefined, "recovery", {
          ...(kind === "wake" ? { wakeMessage: message } : {}),
          resumeMessages: kind === "resume" ? [message] : [],
          unreadSummary: { "@ada": 3 },
        });
        await entered.promise;
        expect(activities.map((activity) => activity.detailKind)).toEqual(["starting"]);
        gate.resolve();
        await launch;
        expect(activities.map((activity) => activity.detailKind)).toEqual(
          kind === "summary" ? ["starting"] : ["starting", "message_received"],
        );
        if (kind !== "summary") {
          expect(activities[1]).toMatchObject({
            agentId: "agent-a",
            detailKind: "message_received",
            detail: "Message received",
            level: "info",
            entries: [],
            launchId: activities[0]!.launchId,
            clientSeq: activities[0]!.clientSeq + 1,
          });
          await harness.runtime.startAgent("agent-a", config, undefined, "duplicate-wake", {
            wakeMessage: message,
          });
          expect(activities).toHaveLength(2);
          expect(harness.notices).toHaveLength(1);
        }
      } finally {
        gate.resolve();
        await harness.runtime.stop();
      }
    },
  );

  test("late acceptance while stopping does not report Message received", async () => {
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const activities: string[] = [];
    const harness = await queueHarness({
      activity: (activity) => activities.push(activity.detailKind),
      notify: async () => {
        entered.resolve();
        await gate.promise;
      },
    });
    try {
      await harness.runtime.startAgent("agent-a", config);
      const delivery = harness.delivery(1);
      await entered.promise;
      const stopping = harness.runtime.stopAgent("agent-a");
      gate.resolve();
      await delivery;
      await stopping;
      await harness.runtime.startAgent("agent-a", config);
      expect(activities).toEqual(["starting", "stopped", "starting"]);
      expect(harness.acknowledgements).toEqual(["delivery-1"]);
    } finally {
      gate.resolve();
      await harness.runtime.stop();
    }
  });

  test("Activity publication failure does not reject accepted delivery", async () => {
    const harness = await queueHarness({
      activity: (activity) => {
        if (activity.detailKind === "message_received") throw new Error("offline observer");
      },
    });
    try {
      await harness.runtime.startAgent("agent-a", config);
      await harness.delivery(1);
      await harness.delivery(1);
      expect(harness.acknowledgements).toEqual(["delivery-1", "delivery-1"]);
      expect(harness.notices).toHaveLength(1);
    } finally {
      await harness.runtime.stop();
    }
  });

  test("does not ACK rejected notification and accepts redelivery in the same session", async () => {
    let attempts = 0;
    const activities: string[] = [];
    const harness = await queueHarness({
      activity: (activity) => activities.push(activity.detailKind),
      notify: () => {
        attempts++;
        if (attempts === 1) throw new Error("code agent request failed");
      },
    });
    try {
      await harness.runtime.startAgent("agent-a", config);
      await expect(harness.delivery(1)).rejects.toThrow("code agent request failed");
      expect(harness.acknowledgements).toEqual([]);
      expect(activities).toEqual(["starting"]);
      await harness.delivery(1);
      expect(attempts).toBe(2);
      expect(activities).toEqual(["starting", "message_received"]);
      expect(harness.acknowledgements).toEqual(["delivery-1"]);
      expect(harness.sessions()).toBe(1);
    } finally {
      await harness.runtime.stop();
    }
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
        async createAgentSession() {
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

  test("a launch that creates a new session with nothing to recover sends one startup turn", async () => {
    const harness = await queueHarness();
    await harness.runtime.startAgent(
      "agent-a",
      config,
      "cloud-first",
      "create-request",
      undefined,
      undefined,
      "create",
    );
    await Bun.sleep(10);
    expect(harness.notices).toEqual([AGENT_STARTUP_TURN_TEXT]);
    await harness.runtime.stop();
  });

  test("the end of the startup turn reports the Agent idle", async () => {
    const listeners: Array<(event: AgentRuntimeEvent) => void> = [];
    const kinds: string[] = [];
    const harness = await queueHarness({
      subscribe: (listener) => listeners.push(listener),
      notify: () => {
        for (const listener of listeners) listener({ type: "completed", status: "completed" });
      },
      activity: (activity) => kinds.push(activity.detailKind),
    });
    await harness.runtime.startAgent(
      "agent-a",
      config,
      undefined,
      "create-request",
      undefined,
      undefined,
      "create",
    );
    await Bun.sleep(10);
    expect(harness.notices).toEqual([AGENT_STARTUP_TURN_TEXT]);
    expect(kinds.indexOf("idle")).toBeGreaterThan(kinds.indexOf("starting"));
    expect(kinds).toContain("starting");
    await harness.runtime.stop();
  });

  test("the launch resolves without waiting for the startup turn to finish", async () => {
    let finishTurn!: () => void;
    const turn = new Promise<void>((resolve) => (finishTurn = resolve));
    const harness = await queueHarness({ notify: () => turn });
    await harness.runtime.startAgent(
      "agent-a",
      config,
      undefined,
      "create-request",
      undefined,
      undefined,
      "create",
    );
    await Bun.sleep(10);
    expect(harness.notices).toEqual([AGENT_STARTUP_TURN_TEXT]);
    finishTurn();
    await harness.runtime.stop();
  });

  test("a resume launch sends no startup turn", async () => {
    const harness = await queueHarness();
    await harness.runtime.startAgent(
      "agent-a",
      config,
      "stored-session-id",
      "resume-request",
      undefined,
      undefined,
      "resume",
    );
    await Bun.sleep(10);
    expect(harness.notices).toEqual([]);
    await harness.runtime.stop();
  });

  test("a launch without an explicit session mode sends no startup turn", async () => {
    const harness = await queueHarness();
    await harness.runtime.startAgent("agent-a", config);
    await Bun.sleep(10);
    expect(harness.notices).toEqual([]);
    await harness.runtime.stop();
  });

  test("a create launch with a wake message sends only the wake notice", async () => {
    const harness = await queueHarness();
    await harness.runtime.startAgent(
      "agent-a",
      config,
      undefined,
      "wake-request",
      {
        wakeMessage: {
          messageId: "wake-message",
          deliveryId: "wake-delivery",
          conversationId: "conversation-a",
          sequence: 1,
          target: "@ada",
          latestSender: "@ada",
          body: "wake only",
        },
      },
      undefined,
      "create",
    );
    await Bun.sleep(10);
    expect(harness.notices).toHaveLength(1);
    expect(harness.notices[0]).toContain("wake only");
    await harness.runtime.stop();
  });

  test("a stop that races a create launch drops its queued startup turn", async () => {
    let releaseLaunch!: () => void;
    const launchGate = new Promise<void>((resolve) => (releaseLaunch = resolve));
    const harness = await queueHarness({ launch: () => launchGate });
    const launching = harness.runtime.startAgent(
      "agent-a",
      config,
      undefined,
      "create-request",
      undefined,
      undefined,
      "create",
    );
    await Bun.sleep(0);
    const stopping = harness.runtime.stopAgent("agent-a");
    releaseLaunch();
    await expect(launching).rejects.toThrow("stopping");
    await stopping;
    await Bun.sleep(10);
    expect(harness.notices).toEqual([]);
    await harness.runtime.stop();
  });

  test("queues launch recovery before live delivery", async () => {
    let release!: (credential: string) => void;
    const credential = new Promise<string>((resolve) => (release = resolve));
    const harness = await queueHarness({ credential });
    const launch = harness.runtime.startAgent("agent-a", config);
    const launchRecovery = {
      resumeMessages: [
        {
          messageId: "message-recovery",
          deliveryId: "delivery-recovery",
          conversationId: "conversation-a",
          sequence: 1,
          target: "@ada",
          latestSender: "@ada",
          body: "hello from recovery",
        },
      ],
      unreadSummary: { "@ada": 1 },
    };
    const recoveryForLaunch = harness.runtime.startAgent(
      "agent-a",
      config,
      undefined,
      "recovery",
      launchRecovery,
    );
    const live = harness.delivery(2);

    release(`sk_agent_${"a".repeat(43)}`);
    const [started, recovered] = await Promise.all([launch, recoveryForLaunch, live]);
    expect(recovered).toBe(started);
    expect(harness.notices[0]).toContain("New message received:");
    expect(harness.notices[0]).toContain("hello");
    expect(harness.notices[1]).toContain("CoForge inbox notice");
    expect(harness.acknowledgements).toEqual(["delivery-2"]);
    expect(harness.sessions()).toBe(1);
    await harness.runtime.stop();
  });

  test("ready waits for recovery added to an existing launch", async () => {
    let releaseLaunch!: () => void;
    let releaseRecovery!: () => void;
    const launchGate = new Promise<void>((resolve) => (releaseLaunch = resolve));
    const recoveryGate = new Promise<void>((resolve) => (releaseRecovery = resolve));
    const harness = await queueHarness({ launch: () => launchGate, notify: () => recoveryGate });

    const launching = harness.runtime.startAgent("agent-a", config);
    const recovering = harness.runtime.startAgent(
      "agent-a",
      config,
      undefined,
      "recovery",
      recovery,
    );
    releaseLaunch();
    const started = await launching;

    expect(harness.runningAgentIds()).toEqual([]);
    releaseRecovery();
    const recovered = await recovering;
    expect(recovered).toBe(started);
    expect(harness.sessions()).toBe(1);
    expect(harness.runningAgentIds()).toEqual(["agent-a"]);
    await harness.runtime.stop();
  });

  test("ready reports only Agents past recovery and outside stopping", async () => {
    let releaseRecovery!: () => void;
    let releaseDispose!: () => void;
    const recoveryGate = new Promise<void>((resolve) => (releaseRecovery = resolve));
    const disposeGate = new Promise<void>((resolve) => (releaseDispose = resolve));
    const harness = await queueHarness({ notify: () => recoveryGate, dispose: () => disposeGate });
    const launching = harness.runtime.startAgent("agent-a", config, undefined, "recovery", {
      resumeMessages: [
        {
          messageId: "message-recovery",
          deliveryId: "delivery-recovery",
          conversationId: "conversation-a",
          sequence: 1,
          target: "@ada",
          latestSender: "@ada",
          body: "recover",
        },
      ],
      unreadSummary: { "@ada": 1 },
    });
    await Bun.sleep(0);
    expect(harness.runningAgentIds()).toEqual([]);
    releaseRecovery();
    await launching;
    expect(harness.runningAgentIds()).toEqual(["agent-a"]);

    const stopping = harness.runtime.stopAgent("agent-a");
    expect(harness.runningAgentIds()).toEqual([]);
    releaseDispose();
    await stopping;
    await harness.runtime.stop();
  });

  test("failed launch recovery disposes the runtime and can retry canonical recovery", async () => {
    let notifyAttempts = 0;
    let disposals = 0;
    const received: string[] = [];
    const harness = await queueHarness({
      activity(activity) {
        if (activity.detailKind === "message_received") received.push(activity.detail);
      },
      notify() {
        notifyAttempts++;
        if (notifyAttempts === 1) throw new Error("recovery rejected");
      },
      dispose() {
        disposals++;
      },
    });
    const recoveryContext = {
      resumeMessages: [
        {
          messageId: "message-recovery",
          deliveryId: "delivery-recovery",
          conversationId: "conversation-a",
          sequence: 1,
          target: "@ada",
          latestSender: "@ada",
          body: "retry this recovery body",
        },
      ],
      unreadSummary: { "@ada": 1 },
    };

    await expect(
      harness.runtime.startAgent("agent-a", config, undefined, "failed-recovery", recoveryContext),
    ).rejects.toThrow("recovery rejected");
    expect(harness.runningAgentIds()).toEqual([]);
    expect(disposals).toBe(1);
    expect(received).toEqual([]);

    await harness.runtime.startAgent(
      "agent-a",
      config,
      undefined,
      "retried-recovery",
      recoveryContext,
    );
    expect(harness.sessions()).toBe(2);
    expect(harness.notices).toHaveLength(2);
    expect(harness.notices.every((notice) => notice.includes("retry this recovery body"))).toBe(
      true,
    );
    expect(received).toEqual(["Message received"]);
    expect(harness.runningAgentIds()).toEqual(["agent-a"]);
    await harness.runtime.stop();
  });

  test("failed launch recovery preserves an explicit stop fence until stop completes", async () => {
    let rejectRecovery!: (error: Error) => void;
    let markRecoveryStarted!: () => void;
    let markDisposed!: () => void;
    const recoveryGate = new Promise<void>((_, reject) => (rejectRecovery = reject));
    const recoveryStarted = new Promise<void>((resolve) => (markRecoveryStarted = resolve));
    const disposed = new Promise<void>((resolve) => (markDisposed = resolve));
    const harness = await queueHarness({
      async notify() {
        markRecoveryStarted();
        await recoveryGate;
      },
      dispose() {
        markDisposed();
      },
    });
    const launching = harness.runtime.startAgent(
      "agent-a",
      config,
      undefined,
      "blocked-recovery",
      recovery,
    );
    await recoveryStarted;

    const startDuringStop = launching.then(
      () => "launch unexpectedly succeeded",
      async () => {
        try {
          await harness.runtime.startAgent("agent-a", config);
          return "start unexpectedly succeeded";
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
    );
    const stopping = harness.runtime.stopAgent("agent-a");
    rejectRecovery(new Error("recovery rejected"));
    await expect(launching).rejects.toThrow("recovery rejected");
    await disposed;

    expect(await startDuringStop).toContain("stopping");
    await stopping;
    await harness.runtime.startAgent("agent-a", config);
    await harness.runtime.stop();
  });

  test("active recovery rebind keeps its runtime and precedes live delivery", async () => {
    let releaseRecovery!: () => void;
    const recoveryGate = new Promise<void>((resolve) => (releaseRecovery = resolve));
    const harness = await queueHarness({
      notify: (notice) => (notice.includes("wake only") ? recoveryGate : undefined),
    });
    const active = await harness.runtime.startAgent("agent-a", config);
    const rebound = harness.runtime.startAgent("agent-a", config, undefined, "recovery", {
      wakeMessage: {
        messageId: "wake-message",
        deliveryId: "wake-delivery",
        conversationId: "conversation-a",
        sequence: 3,
        target: "@ada",
        latestSender: "@ada",
        body: "wake only",
      },
      resumeMessages: [
        {
          messageId: "resume-message",
          deliveryId: "resume-delivery",
          conversationId: "conversation-a",
          sequence: 2,
          target: "@ada",
          latestSender: "@ada",
          body: "must be ignored",
        },
      ],
      unreadSummary: { "@grace": 9 },
    });
    const live = harness.delivery(4);
    await Bun.sleep(0);

    expect(harness.notices).toHaveLength(1);
    expect(harness.notices[0]).toContain("wake only");
    expect(harness.notices[0]).not.toContain("must be ignored");
    expect(harness.notices[0]).not.toContain("@grace");
    expect(harness.acknowledgements).toEqual([]);
    releaseRecovery();
    expect(await rebound).toBe(active);
    await live;
    expect(harness.notices[1]).toContain("CoForge inbox notice");
    expect(harness.acknowledgements).toEqual(["delivery-4"]);
    expect(harness.sessions()).toBe(1);
    expect(harness.mints()).toBe(1);
    await harness.runtime.stop();
  });

  test("active rebind without a wake ignores resume context and continues live delivery", async () => {
    const harness = await queueHarness();
    await harness.runtime.startAgent("agent-a", config);

    await Promise.all([
      harness.runtime.startAgent("agent-a", config, undefined, "recovery", recovery),
      harness.delivery(2),
    ]);
    expect(harness.notices).toHaveLength(1);
    expect(harness.notices[0]).toContain("CoForge inbox notice");
    expect(harness.acknowledgements).toEqual(["delivery-2"]);
    await harness.runtime.stop();
  });

  test("stop lets current input finish without continuing queued items", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const harness = await queueHarness({ notify: () => gate });
    await harness.runtime.startAgent("agent-a", config);
    const current = harness.delivery(1);
    const queued = harness.delivery(2);
    void queued.catch(() => {});
    await Bun.sleep(0);
    const stop = harness.runtime.stopAgent("agent-a");
    release();

    await Promise.all([current, stop]);
    await expect(queued).rejects.toThrow("stopping");
    expect(harness.notices).toHaveLength(1);
    expect(harness.acknowledgements).toEqual(["delivery-1"]);
    await harness.runtime.stop();
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
        async createAgentSession() {
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
        async createAgentSession(input) {
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
      // Stop's outcome depends only on the local process exiting (docs/adr/0033): the process
      // exited fine, so the revoke failure above never rejects the Stop itself.
      await expect(stopping).resolves.toBeUndefined();

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

  test("exports the server-authored launch identity as environment variables, alongside the existing local capabilities", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    let capturedEnvironment: Readonly<Record<string, string>> | undefined;
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async createAgentSession(input) {
          capturedEnvironment = input.environment;
          return sessionSpy();
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async stop() {},
          async ready() {},
          async requestAgentLaunchConfig() {
            return {
              agentApiKey: `sk_agent_${"a".repeat(43)}`,
              identity: {
                name: "scout",
                runtimeContext: {
                  workspaceId: "ws-1",
                  workspaceSlug: "acme",
                  workspaceName: "Acme",
                  computerId: "computer-1",
                  computerName: "Builder Box",
                  computerOs: "macOS 27",
                  computerVersion: "0.1.0-dev.36",
                },
              },
            };
          },
        }),
      },
    );

    try {
      await runtime.start(connection);
      await runtime.startAgent("agent-a", config);
      // The local capability sockets already carried this way remain, alongside the new
      // runtime-context variables sourced from the same launch-config identity.
      expect(capturedEnvironment?.COFORGE_AGENT_CONTEXT).toBeTruthy();
      expect(capturedEnvironment).toMatchObject({
        COFORGE_CURRENT_AGENT_ID: "agent-a",
        COFORGE_CURRENT_AGENT_NAME: "scout",
        COFORGE_CURRENT_WORKSPACE_ID: "ws-1",
        COFORGE_CURRENT_WORKSPACE_SLUG: "acme",
        COFORGE_CURRENT_WORKSPACE_NAME: "Acme",
        COFORGE_CURRENT_COMPUTER_ID: "computer-1",
        COFORGE_CURRENT_COMPUTER_NAME: "Builder Box",
        COFORGE_CURRENT_COMPUTER_OS: "macOS 27",
        COFORGE_CURRENT_COMPUTER_VERSION: "0.1.0-dev.36",
      });
      expect(capturedEnvironment?.COFORGE_CURRENT_AGENT_WORKSPACE_PATH).toContain("agent-a");
    } finally {
      await runtime.stop();
    }
  });

  test("publishes current-launch command and tool Activity details", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const activities: import("@lrm/coforge-sdk/internal").AgentActivity[] = [];
    const sessions: Array<{
      event(event: Parameters<Parameters<AgentSession["subscribe"]>[0]>[0]): void;
      delayedExit(): void;
    }> = [];
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async createAgentSession() {
          let listener: Parameters<AgentSession["subscribe"]>[0] = () => undefined;
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
        detailKind: "running_command",
        level: "info",
        detail:
          "printf 012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789",
        observedAtMs: Date.parse("2026-08-29T00:00:00.000Z"),
      },
    });
    sessions[0]!.event({
      type: "activity",
      activity: {
        detailKind: "tool_started",
        level: "info",
        detail: "/workspace/src/input.ts",
        observedAtMs: Date.parse("2026-08-29T00:00:00.100Z"),
        entries: [{ kind: "tool_start", toolName: "read_file" }],
      },
    });
    sessions[0]!.event({
      type: "activity",
      activity: {
        detailKind: "tool_started",
        level: "info",
        detail: "/workspace/src/output.ts",
        observedAtMs: Date.parse("2026-08-29T00:00:00.200Z"),
        entries: [{ kind: "tool_start", toolName: "write_file" }],
      },
    });
    sessions[0]!.event({
      type: "activity",
      activity: {
        detailKind: "tool_started",
        level: "info",
        detail: "/workspace/src/existing.ts",
        observedAtMs: Date.parse("2026-08-29T00:00:00.300Z"),
        entries: [{ kind: "tool_start", toolName: "edit_file" }],
      },
    });
    sessions[0]!.event({
      type: "activity",
      activity: {
        detailKind: "tool_started",
        level: "info",
        detail: "WebSearch query=CoForge",
        observedAtMs: Date.parse("2026-08-29T00:00:00.400Z"),
        entries: [{ kind: "tool_start", toolName: "WebSearch" }],
      },
    });
    sessions[0]!.event({
      type: "activity",
      activity: {
        detailKind: "runtime_error",
        level: "error",
        detail: "request timed out: Bearer fixture-private-token",
        observedAtMs: Date.parse("2026-08-29T00:00:00.500Z"),
      },
    });
    const firstLaunch = activities[0]!.launchId;
    expect(firstLaunch).not.toBe("");
    expect(activities.every((activity) => activity.launchId === firstLaunch)).toBe(true);
    expect(activities.map(({ clientSeq }) => clientSeq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(activities[1]!.detail).toBe(
      "printf 012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012",
    );
    expect(activities.slice(2, 6).map(({ detail }) => detail)).toEqual([
      "/workspace/src/input.ts",
      "/workspace/src/output.ts",
      "/workspace/src/existing.ts",
      "WebSearch query=CoForge",
    ]);
    expect(activities[6]!.detail).toBe("request timed out: Bearer fixture-private-token");

    sessions[0]!.event({
      type: "activity",
      activity: {
        detailKind: "runtime_reconnecting",
        level: "info",
        detail: "Codex reconnecting to provider…",
        observedAtMs: Date.now(),
        entries: [{ kind: "text", text: "Reconnecting... 3/5" }],
      },
    });
    expect(activities[7]).toMatchObject({
      detailKind: "runtime_reconnecting",
      level: "info",
      detail: "Codex reconnecting to provider…",
      entries: [{ kind: "text", text: "Reconnecting... 3/5" }],
    });

    const stopping = runtime.stopAgent("agent-a");
    sessions[0]!.event({
      type: "activity",
      activity: {
        detailKind: "running_command",
        level: "info",
        detail: "late command",
        observedAtMs: Date.parse("2026-08-29T00:00:01.000Z"),
      },
    });
    await stopping;
    expect(activities.map(({ detailKind }) => detailKind)).toEqual([
      "starting",
      "running_command",
      "tool_started",
      "tool_started",
      "tool_started",
      "tool_started",
      "runtime_error",
      "runtime_reconnecting",
      "stopped",
    ]);

    await runtime.handleAgentStart({ ...intent, requestId: "start-2" });
    const beforeOldCallbacks = activities.length;
    sessions[0]!.event({
      type: "activity",
      activity: {
        detailKind: "running_command",
        level: "info",
        detail: "stale command",
        observedAtMs: Date.parse("2026-08-29T00:00:02.000Z"),
      },
    });
    sessions[0]!.delayedExit();
    expect(activities).toHaveLength(beforeOldCallbacks);
    expect(activities.at(-1)!.launchId).not.toBe(firstLaunch);
    expect(activities.at(-1)!.clientSeq).toBe(1);
    await runtime.stop();
  });

  test("converts a provider error event into a classified runtime_error activity, and a reconnecting event into runtime_reconnecting", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const activities: import("@lrm/coforge-sdk/internal").AgentActivity[] = [];
    let listener: Parameters<AgentSession["subscribe"]>[0] = () => undefined;
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async createAgentSession() {
          return {
            ...sessionSpy(),
            subscribe(next) {
              listener = next;
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
            return agentLaunchConfig(`sk_agent_${"a".repeat(43)}`);
          },
          async revokeAgentApiKey() {},
        }),
      },
    );
    await runtime.start(connection);
    await runtime.startAgent("agent-a", config);
    // The provider reports a raw fact only; the daemon core is the single place
    // that redacts, caps, and classifies it (agent-runtime/runtime-error-activity.ts).
    listener({ type: "error", message: "provider request failed" });
    listener({ type: "reconnecting", attempt: 2, message: "Reconnecting... 2/5" });
    expect(activities.map(({ detailKind }) => detailKind)).toEqual([
      "starting",
      "runtime_error",
      "runtime_reconnecting",
    ]);
    expect(activities[1]).toMatchObject({
      level: "error",
      detail: "provider request failed",
      entries: [{ kind: "text", text: "Error: provider request failed" }],
      runtimeError: { errorClass: "AgentRuntimeError", errorReason: "runtime_failure" },
    });
    expect(activities[2]).toMatchObject({
      level: "info",
      detail: "Reconnecting... 2/5",
      entries: [{ kind: "text", text: "Reconnecting... 2/5" }],
    });
    await runtime.stop();
  });

  test("reports runtime_crashed with Crashed(...) wording on an unintentional exit that follows an unresolved error", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const activities: import("@lrm/coforge-sdk/internal").AgentActivity[] = [];
    let listener: Parameters<AgentSession["subscribe"]>[0] = () => undefined;
    let exit: (() => void) | undefined;
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async createAgentSession() {
          return {
            ...sessionSpy(),
            subscribe(next) {
              listener = next;
              return () => undefined;
            },
            onExit(next) {
              exit = next;
              return () => {
                exit = undefined;
              };
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
            return agentLaunchConfig(`sk_agent_${"a".repeat(43)}`);
          },
          async revokeAgentApiKey() {},
        }),
      },
    );
    await runtime.start(connection);
    await runtime.startAgent("agent-a", config);
    listener({ type: "error", message: "code agent process exited unexpectedly" });
    exit?.();
    // `AgentSession.onExit` itself carries no exit code/signal; "Crashed" wording can only
    // describe the last observed error, tracked on the launch since the `error` event above.
    expect(activities.map(({ detailKind }) => detailKind)).toEqual([
      "starting",
      "runtime_error",
      "runtime_crashed",
    ]);
    expect(activities.at(-1)).toMatchObject({
      level: "error",
      detail: "Crashed (code agent process exited unexpectedly)",
    });
    await runtime.stop();
  });

  test("keeps the stopped wording on an unintentional exit with no unresolved error", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const activities: import("@lrm/coforge-sdk/internal").AgentActivity[] = [];
    let exit: (() => void) | undefined;
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async createAgentSession() {
          return {
            ...sessionSpy(),
            onExit(next) {
              exit = next;
              return () => {
                exit = undefined;
              };
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
            return agentLaunchConfig(`sk_agent_${"a".repeat(43)}`);
          },
          async revokeAgentApiKey() {},
        }),
      },
    );
    await runtime.start(connection);
    await runtime.startAgent("agent-a", config);
    // No `error` event preceded this exit, so it is not a crash: it keeps the stopped wording.
    exit?.();
    expect(activities.map(({ detailKind }) => detailKind)).toEqual(["starting", "stopped"]);
    await runtime.stop();
  });

  test("publishes a completion Activity without lifecycle detail for a successful turn", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const activities: import("@lrm/coforge-sdk/internal").AgentActivity[] = [];
    let listener: Parameters<AgentSession["subscribe"]>[0] = () => undefined;
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async createAgentSession() {
          return {
            ...sessionSpy(),
            subscribe(next) {
              listener = next;
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
            return agentLaunchConfig(`sk_agent_${"a".repeat(43)}`);
          },
          async revokeAgentApiKey() {},
        }),
      },
    );
    try {
      await runtime.start(connection);
      await runtime.startAgent("agent-a", config);
      listener({ type: "completed", status: "completed" });
      await Bun.sleep(10);
      expect(activities.map(({ detailKind }) => detailKind)).toEqual(["starting", "idle"]);
      expect(activities.at(-1)).toMatchObject({ detailKind: "idle", level: "info", detail: "" });
    } finally {
      await runtime.stop();
    }
  });

  test("reports a fenced fresh session and an honest notice without exposing unrelated provider errors", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const activities: import("@lrm/coforge-sdk/internal").AgentActivity[] = [];
    let fail = false;
    const reports: import("@lrm/coforge-sdk/internal").AgentSessionReport[] = [];
    const invalidations: import("@lrm/coforge-sdk/internal").AgentSessionInvalidate[] = [];
    const order: string[] = [];
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async createAgentSession(options) {
          if (fail) throw new Error("private-provider-token");
          await options.onSessionId?.("new-session", "old-session");
          return sessionSpy();
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
            return agentLaunchConfig(`sk_agent_${"a".repeat(43)}`);
          },
          async revokeAgentApiKey() {},
          sendSessionInvalidate(message) {
            order.push("invalidate");
            invalidations.push(message);
          },
          async reportAgentSession(report) {
            order.push("report");
            reports.push(report);
          },
        }),
      },
    );
    try {
      await runtime.start(connection);
      await runtime.startAgent("agent-a", config, "old-session", "cloud-start");
      // Driver-reported replacement (Claude Code/Codex's own in-driver session recreation, here
      // simulated on "pi" for test simplicity): exactly one invalidate, sent BEFORE the report
      // so the server's exact match against the still-stale session can succeed.
      expect(order).toEqual(["invalidate", "report"]);
      expect(invalidations).toHaveLength(1);
      expect(invalidations[0]).toMatchObject({
        sessionId: "old-session",
        reason: "missing",
      });
      expect(invalidations[0]).not.toHaveProperty("startRequestId");
      expect(invalidations[0]).not.toHaveProperty("controlEpoch");
      expect(reports[0]).toMatchObject({
        sessionId: "new-session",
        replacedSessionId: "old-session",
        startRequestId: "cloud-start",
      });
      expect(
        activities.some(
          (activity) =>
            activity.detailKind === "runtime_unavailable" &&
            activity.detail === "Stored Pi session missing; cold-starting a new session…" &&
            activity.entries?.some(
              (entry) =>
                entry.kind === "text" &&
                entry.text ===
                  "Stored Pi session old-session is unavailable locally. Falling back to a cold start; earlier runtime context may not be restored.",
            ),
        ),
      ).toBe(true);
      fail = true;
      await expect(runtime.startAgent("agent-b", config)).rejects.toThrow("private-provider-token");
      expect(activities.at(-1)?.detail).toBe("Agent runtime could not be started.");
      expect(JSON.stringify(activities)).not.toContain("private-provider-token");
    } finally {
      await runtime.stop();
    }
  });

  test.each([
    ["session_missing", "missing"],
    ["provider_replay_rejected", "provider_replay_rejected"],
  ] as const)(
    "reports exactly one session invalidate with the correct reason for a kiro/pi retry (%s)",
    async (code, reason) => {
      // AgentControl's persisted control record is keyed by stateDirectory, not just agentId;
      // a dedicated directory (cleaned up below) keeps this test isolated from every other test
      // in this file and from any other run — the shared default is a real, reused directory.
      const stateDirectory = join(tempRoot, `coforge-retry-invalidate-${crypto.randomUUID()}`);
      const credentials = new InMemoryDaemonCredentialStore();
      await credentials.save(connection.workspaceId, connection.computerId, "token-a");
      const invalidations: import("@lrm/coforge-sdk/internal").AgentSessionInvalidate[] = [];
      const activities: import("@lrm/coforge-sdk/internal").AgentActivity[] = [];
      let attempts = 0;
      const runtime = new DaemonRuntime(
        connection,
        () => ({
          provider: "kiro",
          async createAgentSession(options) {
            attempts++;
            if (options.sessionId) throw new AgentSessionRecoveryError(code);
            return sessionSpy();
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
              return agentLaunchConfig(`sk_agent_${"a".repeat(43)}`);
            },
            async revokeAgentApiKey() {},
            sendSessionInvalidate(message) {
              invalidations.push(message);
            },
            async sendAgentControlResult() {},
            async reportAgentSession() {},
          }),
        },
        undefined,
        emptyCodeAgentDiscovery,
        stateDirectory,
      );
      const intent = {
        protocolMajor: 1,
        requestId: "retry-start",
        workspaceId: connection.workspaceId,
        computerId: connection.computerId,
        agentId: `retry-agent-${code}`,
        provider: "kiro" as const,
        model: "default",
        modelProvider: "anthropic",
        reasoning: "balanced",
        controlEpoch: 1,
        launchId: "launch-retry-stale",
        sessionId: "stale-session",
        sessionMode: "resume" as const,
      };
      try {
        await runtime.start(connection);
        await runtime.handleAgentStart(intent);
        // Exactly one launch attempt failed with the recovery error before the fresh retry.
        expect(attempts).toBe(2);
        expect(invalidations).toHaveLength(1);
        expect(invalidations[0]).toMatchObject({ sessionId: "stale-session", reason });
        expect(invalidations[0]).not.toHaveProperty("startRequestId");
        expect(invalidations[0]).not.toHaveProperty("controlEpoch");
        expect(
          activities.filter((activity) => activity.detailKind === "runtime_unavailable"),
        ).toHaveLength(1);
      } finally {
        await runtime.stop();
        await rm(stateDirectory, { recursive: true, force: true });
      }
    },
  );

  test("session_in_use retries without reporting any session invalidate or cold-start Activity", async () => {
    const stateDirectory = join(tempRoot, `coforge-retry-invalidate-busy-${crypto.randomUUID()}`);
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const invalidations: import("@lrm/coforge-sdk/internal").AgentSessionInvalidate[] = [];
    const activities: import("@lrm/coforge-sdk/internal").AgentActivity[] = [];
    let attempts = 0;
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "kiro",
        async createAgentSession(options) {
          attempts++;
          if (options.sessionId) throw new AgentSessionRecoveryError("session_in_use");
          return sessionSpy();
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
            return agentLaunchConfig(`sk_agent_${"a".repeat(43)}`);
          },
          async revokeAgentApiKey() {},
          sendSessionInvalidate(message) {
            invalidations.push(message);
          },
          async sendAgentControlResult() {},
          async reportAgentSession() {},
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
      stateDirectory,
    );
    const intent = {
      protocolMajor: 1,
      requestId: "retry-start-busy",
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      agentId: "retry-agent-busy",
      provider: "kiro" as const,
      model: "default",
      modelProvider: "anthropic",
      reasoning: "balanced",
      controlEpoch: 1,
      launchId: "launch-retry-busy",
      sessionId: "busy-session",
      sessionMode: "resume" as const,
    };
    try {
      await runtime.start(connection);
      await runtime.handleAgentStart(intent);
      // The retry still happens (fix 1 must make the carried-over `replaced` harmless, not
      // block the retry) — only the reporting is suppressed.
      expect(attempts).toBe(2);
      expect(invalidations).toHaveLength(0);
      expect(activities.some((activity) => activity.detailKind === "runtime_unavailable")).toBe(
        false,
      );
    } finally {
      await runtime.stop();
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });

  test("reports a safe launch failure and blocks retry when startup cleanup is unresolved", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const lifecycle: string[] = [];
    const activities: import("@lrm/coforge-sdk/internal").AgentActivity[] = [];
    let credentialRequests = 0;
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async createAgentSession() {
          throw new AgentProcessCleanupError();
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {},
          sendAgentStatus(status) {
            lifecycle.push(`status:${status.status}`);
          },
          sendAgentActivity(activity) {
            activities.push(activity);
            lifecycle.push(`activity:${activity.detailKind}`);
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
    expect(lifecycle).toEqual(["status:inactive", "activity:runtime_error"]);
    expect(activities.map(({ detailKind }) => detailKind)).toEqual(["runtime_error"]);
    expect(activities[0]).toMatchObject({
      agentId: "agent-a",
      detailKind: "runtime_error",
      level: "error",
      clientSeq: 1,
      detail: "Agent process cleanup could not be confirmed. Replacement launch is blocked.",
    });
    await expect(runtime.startAgent("agent-a", config)).rejects.toThrow("stopping");
    expect(credentialRequests).toBe(1);
    await runtime.stop().catch(() => undefined);
  });

  test("reports stop failure when process-tree exit cannot be confirmed", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const activities: import("@lrm/coforge-sdk/internal").AgentActivity[] = [];
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async createAgentSession() {
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
    expect(activities.map(({ detailKind }) => detailKind)).toEqual(["starting", "runtime_error"]);
    expect(activities[1]).toMatchObject({
      level: "error",
      clientSeq: 2,
      detail: "Agent process cleanup could not be confirmed. Replacement launch is blocked.",
    });
    await runtime.stop().catch(() => undefined);
  });

  test("does not publish an old session exit after daemon stop and restart", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const activities: import("@lrm/coforge-sdk/internal").AgentActivity[] = [];
    const oldExitListeners: Array<() => void> = [];
    let launches = 0;
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async createAgentSession() {
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

  test("a failed remote revoke at shutdown is attempted once and closes local access first", async () => {
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
        async createAgentSession() {
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
      runtime.agentMessage(
        "proxy-token",
        {
          requestId: "r",
          operation: "check",
          context: "proxy-token",
        },
        `sk_agent_${"a".repeat(43)}`,
      ),
    ).rejects.toThrow("not running");
    releaseStop();
    // Revoke stays best-effort at shutdown (docs/adr/0033) and is never retried (docs/adr/0043):
    // the failed revoke above never fails the overall Stop, and a second stop() sends nothing.
    await expect(stopping).resolves.toBeUndefined();
    await runtime.stop();
    expect(attempts).toBe(1);
  });

  test("shutdown sends one authenticated revoke per running Agent and always recreates the transport", async () => {
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
        return new Response(null, { status: 503 });
      },
      { preconnect: originalFetch.preconnect },
    );
    let transportsCreated = 0;
    const runtime = new DaemonRuntime(
      configuredConnection,
      () => ({ provider: "pi", createAgentSession: async () => sessionSpy() }),
      credentials,
      {
        create: () => {
          transportsCreated++;
          return new DaemonConnection("wss://cloud.example", () => connectedClient());
        },
      },
      undefined,
      emptyCodeAgentDiscovery,
    );
    try {
      await runtime.start(configuredConnection);
      await runtime.startAgent("agent-a", config);
      // Revoke stays best-effort at shutdown (docs/adr/0033): the 503 above never fails the
      // Stop. It is not retried either (docs/adr/0043), so the second stop() sends nothing and
      // the transport is recreated regardless of the revoke outcome.
      await expect(runtime.stop()).resolves.toBeUndefined();
      await runtime.stop();
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(revokeAuthorizations).toEqual(["Bearer daemon-token"]);
    // One transport for start(), one recreated by each of the two stop() calls.
    expect(transportsCreated).toBe(3);
  });

  test("keeps App notices separate from Message state and drains them on normalized idle", async () => {
    const stateDirectory = join(tempRoot, `coforge-inbox-runtime-${crypto.randomUUID()}`);
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const notices: string[] = [];
    let listener: ((event: AgentRuntimeEvent) => void) | undefined;
    const exits = new Set<() => void>();
    let starts = 0;
    let cloudMessageCalls = 0;
    let deliveryAcks = 0;
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        createAgentSession: async () => {
          starts++;
          return {
            ...sessionSpy(),
            notify: async (notice) => {
              notices.push(notice);
            },
            subscribe(next) {
              listener = next;
              return () => {
                listener = undefined;
              };
            },
            onExit(next) {
              exits.add(next);
              return () => exits.delete(next);
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
            return `sk_agent_${"a".repeat(43)}`;
          },
          async revokeAgentApiKey() {},
          async sendAgentDeliveryAck() {
            deliveryAcks++;
          },
          async agentMessage() {
            cloudMessageCalls++;
            throw new Error("must not read cloud");
          },
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
      stateDirectory,
    );
    try {
      await runtime.start(connection);
      const input = {
        appId: "system.reminder",
        notificationClass: "due",
        sourceRef: { kind: "reminder", id: "123e4567-e89b-42d3-a456-426614174000", revision: "1" },
        title: "Due",
        summary: "Now",
      };
      await runtime.mintAppItem("agent-a", input);
      expect(notices).toEqual([]);
      await runtime.startAgent("agent-a", config);
      await Bun.sleep(10);
      expect(notices).toEqual(["New app item available. Run coforge inbox check."]);
      listener?.({
        type: "activity",
        activity: {
          detailKind: "idle",
          level: "info",
          detail: "idle",
          observedAtMs: Date.now(),
        },
      });
      await Bun.sleep(10);
      expect(notices).toEqual(["New app item available. Run coforge inbox check."]);
      for (const exit of exits) exit();
      await runtime.mintAppItem("agent-a", {
        ...input,
        sourceRef: { ...input.sourceRef, revision: "2" },
      });
      expect(starts).toBe(2);
      expect(notices).toHaveLength(2);
      await runtime.handleAgentMessage({
        protocolMajor: 1,
        requestId: "delivery-request",
        messageId: "message-1",
        deliveryId: "delivery-1",
        sequence: 1,
        workspaceId: connection.workspaceId,
        conversationId: "conversation-a",
        agentId: "agent-a",
        body: "private chat body",
        method: "agent:deliver",
        target: "@ada",
      });
      await runtime.drainAppInboxNotices("agent-a");
      expect(notices).toHaveLength(3);
      const context = runtime.issueAgentContext("agent-a");
      const snapshot = await runtime.inbox(context, {
        requestId: "check",
        context,
        operation: "check",
      });
      expect(snapshot.entries.map((entry) => entry.kind).sort()).toEqual([
        "app",
        "app",
        "message_target",
      ]);
      const unchanged = await runtime.inbox(context, {
        requestId: "check-again",
        context,
        operation: "check",
      });
      expect(unchanged.entries.map((entry) => entry.kind).sort()).toEqual([
        "app",
        "app",
        "message_target",
      ]);
      expect(cloudMessageCalls).toBe(0);
      expect(deliveryAcks).toBe(1);
      await runtime.mintAppItem("agent-a", input);
      expect(notices).toHaveLength(3);
      expect(cloudMessageCalls).toBe(0);
      expect(deliveryAcks).toBe(1);
    } finally {
      await runtime.stop();
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });

  test("a reminder-triggered restart waits for the shared notice outcome before becoming terminal", async () => {
    const stateDirectory = join(tempRoot, `coforge-reminder-notice-${crypto.randomUUID()}`);
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const notify = Promise.withResolvers<void>();
    const notifyStarted = Promise.withResolvers<void>();
    const exits = new Set<() => void>();
    let sessions = 0;
    let receiveReminder!: (sync: import("@lrm/coforge-sdk/internal").ReminderSync) => void;
    const reminderId = "123e4567-e89b-42d3-a456-426614174000";
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async createAgentSession() {
          sessions++;
          return {
            ...sessionSpy(),
            ...(sessions === 2
              ? {
                  notify: async () => {
                    notifyStarted.resolve();
                    await notify.promise;
                  },
                }
              : {}),
            onExit(next) {
              exits.add(next);
              return () => exits.delete(next);
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
          onReminderSync(callback) {
            receiveReminder = callback;
            return () => undefined;
          },
          async fireReminder(request) {
            return { ...request, result: "accepted", fired: true, catchup: false } as const;
          },
          async requestAgentLaunchConfig() {
            return agentLaunchConfig(`sk_agent_${"a".repeat(43)}`);
          },
          async revokeAgentApiKey() {},
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
      stateDirectory,
    );
    try {
      await runtime.start(connection);
      await runtime.startAgent("agent-a", config);
      for (const exit of exits) exit();
      receiveReminder({
        protocolMajor: 1,
        requestId: "reminder-snapshot",
        workspaceId: connection.workspaceId,
        computerId: connection.computerId,
        agentId: "agent-a",
        operation: "snapshot",
        messageType: "coforge.rpc.v1.ReminderSync",
        jobs: [
          {
            reminderId,
            ownerAgentId: "agent-a",
            version: 1,
            title: "Retry me",
            target: "@frank",
            messageId: "123e4567-e89b-42d3-a456-426614174001",
            fireAt: new Date(Date.now() - 1_000).toISOString(),
          },
        ],
      });
      await notifyStarted.promise;
      const concurrentDrain = runtime.drainAppInboxNotices("agent-a");
      notify.reject(new Error("notify rejected"));
      await expect(concurrentDrain).rejects.toThrow("notify rejected");

      const receipts = (await Bun.file(
        join(
          stateDirectory,
          "reminder-receipts",
          connection.workspaceId,
          "agent-a",
          "receipts.json",
        ),
      ).json()) as { receipts: Array<{ wakeAccepted: boolean; terminal: boolean }> };
      expect(receipts.receipts[0]).toMatchObject({ wakeAccepted: false, terminal: false });
    } finally {
      notify.resolve();
      await runtime.stop();
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });

  test("projects a long multiline reminder title into the App Inbox without changing its occurrence", async () => {
    const stateDirectory = join(tempRoot, `coforge-reminder-preview-${crypto.randomUUID()}`);
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const notified = Promise.withResolvers<void>();
    let receiveReminder!: (sync: import("@lrm/coforge-sdk/internal").ReminderSync) => void;
    const fullTitle = `  检查\n\t${"中".repeat(115)}😀${"长期项目进度".repeat(30)}  `;
    const reminderId = "123e4567-e89b-42d3-a456-426614174000";
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async createAgentSession() {
          return { ...sessionSpy(), notify: async () => notified.resolve() };
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {},
          onReminderSync(callback) {
            receiveReminder = callback;
            return () => undefined;
          },
          async fireReminder(request) {
            return { ...request, result: "accepted", fired: true, catchup: false } as const;
          },
          async requestAgentLaunchConfig() {
            return agentLaunchConfig(`sk_agent_${"a".repeat(43)}`);
          },
          async revokeAgentApiKey() {},
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
      stateDirectory,
    );
    try {
      await runtime.start(connection);
      await runtime.startAgent("agent-a", config);
      receiveReminder({
        protocolMajor: 1,
        requestId: "reminder-snapshot",
        workspaceId: connection.workspaceId,
        computerId: connection.computerId,
        agentId: "agent-a",
        operation: "snapshot",
        messageType: "coforge.rpc.v1.ReminderSync",
        jobs: [
          {
            reminderId,
            ownerAgentId: "agent-a",
            version: 1,
            title: fullTitle,
            target: "@frank",
            messageId: "123e4567-e89b-42d3-a456-426614174001",
            fireAt: new Date(Date.now() - 1_000).toISOString(),
          },
        ],
      });
      await notified.promise;

      const context = runtime.issueAgentContext("agent-a");
      const inbox = await runtime.inbox(context, {
        requestId: "check-reminder",
        context,
        operation: "check",
      });
      const app = inbox.entries[0]?.kind === "app" ? inbox.entries[0].app : undefined;
      expect(app?.title).toHaveLength(120);
      expect(app?.title).not.toMatch(/[\r\n\t]/);
      expect(app?.title).toStartWith("检查 ");
      expect(app?.title).toEndWith("😀");

      const acknowledgement = await runtime.reminder(
        context,
        { requestId: "ack-reminder", context, operation: "ack", reminderId, revision: 1 },
        `sk_agent_${"a".repeat(43)}`,
      );
      expect(acknowledgement).toMatchObject({ accepted: true, reminderId, revision: 1 });
      expect(
        (await runtime.inbox(context, { requestId: "after-ack", context, operation: "check" }))
          .entries,
      ).toEqual([]);
      const receipts = (await Bun.file(
        join(
          stateDirectory,
          "reminder-receipts",
          connection.workspaceId,
          "agent-a",
          "receipts.json",
        ),
      ).json()) as { receipts: Array<{ job: { title: string } }> };
      expect(receipts.receipts[0]?.job.title).toBe(fullTitle);
    } finally {
      await runtime.stop();
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });

  test("a revoke failure at Stop is logged once and a reconnect never retries it", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    let reconnect: (() => void) | undefined;
    let revokeAttempts = 0;
    const statuses: Array<{ agentId: string; status: string }> = [];
    const activities: Array<{ agentId: string; detailKind: string }> = [];
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async createAgentSession() {
          return sessionSpy();
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {},
          onReconnect(callback) {
            reconnect = callback;
            return () => {
              reconnect = undefined;
            };
          },
          async requestAgentLaunchConfig() {
            return agentLaunchConfig(`sk_agent_${"a".repeat(43)}`);
          },
          async revokeAgentApiKey() {
            revokeAttempts++;
            // The server is mid-deploy, same as the s144 incident.
            throw new Error("remote revoke failed");
          },
          sendAgentStatus({ agentId, status }) {
            statuses.push({ agentId, status });
          },
          async sendAgentActivity(activity) {
            activities.push({ agentId: activity.agentId, detailKind: activity.detailKind });
          },
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
    );
    try {
      await runtime.start(connection);
      await runtime.startAgent("agent-a", config);
      statuses.length = 0;
      activities.length = 0;

      // Stop's outcome depends only on the local process exiting (docs/adr/0033): the process
      // stops cleanly even though the remote revoke above rejects, so stopAgent resolves.
      await expect(runtime.stopAgent("agent-a")).resolves.toBeUndefined();
      expect(revokeAttempts).toBe(1);
      expect(statuses.at(-1)).toEqual({ agentId: "agent-a", status: "inactive" });
      expect(
        activities.some((activity) => activity.detailKind === AGENT_ACTIVITY_DETAIL_KIND.STOPPED),
      ).toBe(true);

      // The daemon never retries a revoke (docs/adr/0043): reconnects leave the failure where it
      // is, and the server invalidates the key at the Agent's next launch instead.
      reconnect?.();
      await Bun.sleep(0);
      reconnect?.();
      await Bun.sleep(0);
      expect(revokeAttempts).toBe(1);
    } finally {
      await runtime.stop();
    }
  });

  test("a reconnect pass never revokes the key a running Agent is still using", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    let reconnect: (() => void) | undefined;
    const revokedKeys: string[] = [];
    const liveKey = `sk_agent_${"a".repeat(43)}`;
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async createAgentSession() {
          return sessionSpy();
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {},
          onReconnect(callback) {
            reconnect = callback;
            return () => {
              reconnect = undefined;
            };
          },
          async requestAgentLaunchConfig() {
            return agentLaunchConfig(liveKey);
          },
          async revokeAgentApiKey(agentApiKey) {
            revokedKeys.push(agentApiKey);
          },
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
    );
    try {
      await runtime.start(connection);
      await runtime.startAgent("agent-a", config);

      // The cloud connection drops and comes back while the Agent keeps running. The pending
      // revoke pass that runs on reconnect is for keys whose revoke is owed, never for the key
      // the running Agent's proxy binding still sends with every request.
      reconnect?.();
      await Bun.sleep(0);
      reconnect?.();
      await Bun.sleep(0);
      expect(revokedKeys).toEqual([]);

      // Stopping the Agent is what revokes its key, exactly once.
      await runtime.stopAgent("agent-a");
      await Bun.sleep(0);
      expect(revokedKeys).toEqual([liveKey]);
    } finally {
      await runtime.stop();
    }
    expect(revokedKeys).toEqual([liveKey]);
  });

  test("a fenced Start failure logs AgentControl's fixed rejection as a control_code", async () => {
    // A dedicated stateDirectory keeps this fenced-control record isolated from every other
    // test's agent-control store, matching the pattern other controlEpoch tests use.
    const stateDirectory = join(
      tempRoot,
      `coforge-start-failure-control-code-${crypto.randomUUID()}`,
    );
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    let listener: ((intent: Parameters<DaemonRuntime["handleAgentStart"]>[0]) => void) | undefined;
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async createAgentSession() {
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
            const base = {
              protocolMajor: 1,
              workspaceId: connection.workspaceId,
              computerId: connection.computerId,
              agentId: "control-code-agent",
              provider: "pi" as const,
              model: "default",
              reasoning: "balanced",
              controlEpoch: 1,
              launchId: "launch-control-code",
            };
            // Same agent, same epoch, different requestId: AgentControl rejects the second one
            // with the fixed "control_request_mismatch" message once the first has a startResult.
            listener?.({ ...base, requestId: "start-1" });
            listener?.({ ...base, requestId: "start-2" });
          },
          async requestAgentLaunchConfig() {
            return agentLaunchConfig(`sk_agent_${"a".repeat(43)}`);
          },
          async sendAgentActivity() {},
          sendAgentStatus() {},
          async sendAgentControlResult() {},
          async stop() {},
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
      stateDirectory,
    );
    try {
      const { records } = await captureLogs(() => runtime.start(connection));
      const failure = records.find(
        (record) => record.properties.event === "agent_runtime:start_failed",
      );
      expect(failure?.properties).toMatchObject({
        agent_id: "control-code-agent",
        control_code: "control_request_mismatch",
      });
      // diagnosticErrorCode alone only ever produces the generic "Error" for this rejection;
      // control_code above is what makes it diagnosable.
      expect(failure?.properties.error_code).toBe("Error");
    } finally {
      await runtime.stop();
      await rm(stateDirectory, { recursive: true, force: true });
    }
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
