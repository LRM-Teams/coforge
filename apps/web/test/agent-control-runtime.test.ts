import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentControl,
  type AgentControlAgent,
  type AgentControlStore,
} from "#src/server/agents/agent-control.server";
import { AgentSessionReceiver } from "#src/server/agents/agent-session.server";
import {
  AgentSessions,
  type RuntimeSessionReference,
} from "#src/server/agents/agent-sessions.server";
import { DaemonRuntime } from "@lrm/coforge-daemon";
import { InMemoryDaemonCredentialStore } from "@lrm/coforge-daemon";
import { AgentSessionRecoveryError } from "@lrm/coforge-daemon/src/code-agent/contract";
import {
  decodeAgentStartIntent,
  decodeAgentStopIntent,
  decodeAgentWorkspaceResetRequest,
  type AgentSessionReport,
  type AgentStartIntent,
} from "@lrm/coforge-sdk/internal";
import type { AgentSessionOptions } from "@coforge/agent";

test("cloud and daemon preserve Restart identity, reset sessions, fence Full Reset replay and report recovery", async () => {
  // macOS resolves os.tmpdir() through the /var -> /private/var symlink, which the
  // store's symlinked-ancestor guard rightly rejects; anchor the fixture on the real path.
  const root = await mkdtemp(join(await realpath(tmpdir()), "control-roundtrip-"));
  const connection = { workspaceId: "w", computerId: "c", workspaceRoot: join(root, "workspaces") };
  let agent: AgentControlAgent = {
    id: "a",
    ownerId: "owner",
    visibility: "public",
    workspaceId: "w",
    computerId: "c",
    runtimeConfig: {
      runtime: "pi",
      provider: { kind: "default" },
      model: "",
      modelProvider: "",
      reasoning: "",
    },
    state: null,
  };
  const store: AgentControlStore = {
    async get() {
      return structuredClone(agent);
    },
    async replace(before, state) {
      if (JSON.stringify(before.state) !== JSON.stringify(agent.state)) return false;
      agent = { ...agent, state: structuredClone(state) };
      return true;
    },
    async memberRole() {
      return "owner";
    },
  };
  let runtime: DaemonRuntime;
  const deliveries = new Set<Promise<unknown>>();
  const sent: Uint8Array[] = [];
  const control = new AgentControl(
    store,
    {
      async publish(_channel, bytes) {
        sent.push(bytes);
        let delivery: Promise<unknown> | undefined;
        try {
          delivery = runtime.handleAgentStop(decodeAgentStopIntent(bytes));
        } catch {}
        if (!delivery) {
          try {
            delivery = runtime.handleAgentWorkspaceReset(decodeAgentWorkspaceResetRequest(bytes));
          } catch {}
        }
        delivery ??= runtime.handleAgentStart(decodeAgentStartIntent(bytes));
        deliveries.add(delivery);
        const pending = delivery;
        void pending.finally(() => deliveries.delete(pending)).catch(() => {});
      },
    },
    { run: async (_id, work) => work() },
  );
  const sessions = new AgentSessionReceiver(store, async () => "daemon");
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save("w", "c", "daemon-token");
  const launches: AgentSessionOptions[] = [];
  let rejectResume = false;
  const createRuntime = () =>
    new DaemonRuntime(
      connection,
      (provider) => ({
        provider,
        async createAgentSession(options) {
          launches.push(options);
          if (rejectResume && options.sessionId) {
            rejectResume = false;
            throw new AgentSessionRecoveryError("session_missing");
          }
          const identity = {
            sessionId: options.sessionId ?? `native-${launches.length}`,
            state: "resumable" as const,
          };
          return {
            readSessionIdentity: async () => identity,
            sendMessage: async () => {},
            notify: async () => {},
            subscribe: () => () => {},
            onExit: () => () => {},
            interrupt: async () => {},
            dispose: async () => {},
          };
        },
      }),
      credentials,
      {
        create: () => ({
          start: async () => {},
          ready: async () => {},
          stop: async () => {},
          async requestAgentLaunchConfig(input) {
            await control.authorizeLaunch({ ...input, computerId: "c" });
            return { agentApiKey: `sk_agent_${"x".repeat(43)}` };
          },
          revokeAgentApiKey: async () => {},
          sendAgentControlResult: (result) => control.result(connection, result),
          async reportAgentSession(report) {
            await sessions.authorize(connection, report);
            if (report.sequence !== undefined && report.controlEpoch && report.sessionState)
              await sessions.accept(connection, {
                ...report,
                requestId: report.startRequestId,
                epoch: report.controlEpoch,
                sequence: report.sequence,
                identity: { sessionId: report.sessionId, state: report.sessionState },
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
      join(root, "state"),
    );
  runtime = createRuntime();
  const execute = (action: "restart" | "reset-session" | "full-reset") =>
    control.execute({
      action,
      agentId: "a",
      workspaceId: "w",
      userId: "owner",
      requestId: crypto.randomUUID(),
      confirmed: true,
    });
  try {
    await runtime.start(connection);
    expect((await execute("restart")).phase).toBe("completed");
    const firstId = agent.state?.identity?.sessionId;
    const marker = join(connection.workspaceRoot, "w", "agents", "a", "keep.txt");
    await Bun.write(marker, "workspace content");
    let sentBefore = sent.length;
    let launchesBefore = launches.length;
    expect((await execute("restart")).phase).toBe("completed");
    expect(logicalControlSteps(sent.slice(sentBefore))).toEqual(["stop", "start"]);
    expect(launches.length).toBe(launchesBefore + 1);
    expect(launches.at(-1)?.sessionId).toBe(firstId);
    sentBefore = sent.length;
    launchesBefore = launches.length;
    expect((await execute("reset-session")).phase).toBe("completed");
    expect(logicalControlSteps(sent.slice(sentBefore))).toEqual(["stop", "start"]);
    expect(launches.length).toBe(launchesBefore + 1);
    expect(decodeAgentStartIntent(sent.at(-1)!).sessionId).toBeUndefined();
    expect(launches.at(-1)?.sessionId).toBeUndefined();
    expect(await Bun.file(marker).text()).toBe("workspace content");
    sentBefore = sent.length;
    launchesBefore = launches.length;
    expect((await execute("full-reset")).phase).toBe("completed");
    expect(logicalControlSteps(sent.slice(sentBefore))).toEqual([
      "stop",
      "workspace-reset",
      "start",
    ]);
    expect(launches.length).toBe(launchesBefore + 1);
    expect(decodeAgentStartIntent(sent.at(-1)!).sessionId).toBeUndefined();
    expect(await Bun.file(marker).exists()).toBe(false);
    const reset = sent
      .map((bytes) => {
        try {
          return decodeAgentWorkspaceResetRequest(bytes);
        } catch {
          return undefined;
        }
      })
      .reverse()
      .find((request) => request !== undefined)!;
    await Bun.write(marker, "new files");
    await runtime.handleAgentWorkspaceReset(reset);
    expect(await Bun.file(marker).text()).toBe("new files");
    rejectResume = true;
    expect(await execute("restart")).toMatchObject({ phase: "completed", recovered: true });
    const resumedId = agent.state?.identity?.sessionId;
    await runtime.stop();
    runtime = createRuntime();
    await runtime.start(connection);
    expect((await execute("restart")).phase).toBe("completed");
    expect(launches.at(-1)?.sessionId).toBe(resumedId);
    expect(await Bun.file(marker).text()).toBe("new files");
    await control.publishStop(
      { agentId: "a", workspaceId: "w", requestId: crypto.randomUUID() },
      "owner",
    );
    agent.runtimeConfig.runtime = "codex";
    const intent: AgentStartIntent = {
      protocolMajor: 1,
      requestId: crypto.randomUUID(),
      workspaceId: "w",
      computerId: "c",
      agentId: "a",
      provider: "codex",
      model: "",
      reasoning: "",
    };
    await control.publishStart(intent, "owner");
    await Promise.all(deliveries);
    expect(launches.at(-1)?.sessionId).toBeUndefined();
    expect(launches.at(-1)?.runtime?.provider).toBe("codex");
    expect(await Bun.file(marker).text()).toBe("new files");
  } finally {
    await Promise.allSettled(deliveries);
    await runtime.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("a Start that meets an already-running process rebinds it: one process, prepare/verify/accept intact, wake delivered", async () => {
  // macOS resolves os.tmpdir() through the /var -> /private/var symlink, which the
  // store's symlinked-ancestor guard rightly rejects; anchor the fixture on the real path.
  const root = await mkdtemp(join(await realpath(tmpdir()), "control-rebind-"));
  const connection = { workspaceId: "w", computerId: "c", workspaceRoot: join(root, "workspaces") };
  let agent: AgentControlAgent = {
    id: "a",
    ownerId: "owner",
    visibility: "public",
    workspaceId: "w",
    computerId: "c",
    runtimeConfig: {
      runtime: "pi",
      provider: { kind: "default" },
      model: "",
      modelProvider: "",
      reasoning: "",
    },
    state: null,
  };
  const store: AgentControlStore = {
    async get() {
      return structuredClone(agent);
    },
    async replace(before, state) {
      if (JSON.stringify(before.state) !== JSON.stringify(agent.state)) return false;
      agent = { ...agent, state: structuredClone(state) };
      return true;
    },
    async memberRole() {
      return "owner";
    },
  };
  // The real `AgentSessions` (`agent-sessions.server.ts`) `prepare`/`verify`/`accept` seam, not
  // just `AgentSessionReceiver` — this is what proves the `prepare()` fix: the
  // server-supplied launchId is carried into `RuntimeSessionReference` ahead of the Daemon's own
  // report, so a rebind's later Session report is accepted by exact launchId match.
  let sessionRef: RuntimeSessionReference | null = null;
  let daemonInstanceId: string | undefined;
  const sessions = new AgentSessions(
    {
      async read() {
        return { workspaceId: "w", computerId: "c", provider: "pi", reference: sessionRef };
      },
      async replace(_agentId, previous, next) {
        if (JSON.stringify(previous) !== JSON.stringify(sessionRef)) return false;
        sessionRef = next;
        return true;
      },
    },
    async () => daemonInstanceId,
  );
  const sessionReceiver = new AgentSessionReceiver(store, async () => daemonInstanceId);
  const reports: AgentSessionReport[] = [];
  const reportAgentSession = async (report: AgentSessionReport) => {
    reports.push(report);
    await sessionReceiver.authorize(connection, report);
    if (report.sequence !== undefined && report.controlEpoch !== undefined && report.sessionState) {
      await sessions.verify(report);
      await sessionReceiver.accept(connection, {
        ...report,
        requestId: report.startRequestId,
        epoch: report.controlEpoch,
        sequence: report.sequence,
        identity: { sessionId: report.sessionId, state: report.sessionState },
      });
    } else {
      await sessions.accept(report);
    }
  };
  let runtime: DaemonRuntime;
  const deliveries = new Set<Promise<unknown>>();
  const sent: Uint8Array[] = [];
  const control = new AgentControl(
    store,
    {
      async publish(_channel, bytes) {
        sent.push(bytes);
        let delivery: Promise<unknown> | undefined;
        try {
          delivery = runtime.handleAgentStop(decodeAgentStopIntent(bytes));
        } catch {}
        if (!delivery) {
          try {
            delivery = runtime.handleAgentWorkspaceReset(decodeAgentWorkspaceResetRequest(bytes));
          } catch {}
        }
        delivery ??= runtime.handleAgentStart(decodeAgentStartIntent(bytes));
        deliveries.add(delivery);
        const pending = delivery;
        void pending.finally(() => deliveries.delete(pending)).catch(() => {});
      },
    },
    { run: async (_id, work) => work() },
    { timeoutMs: 5_000, fallbackMs: 200 },
    sessions,
    undefined,
    // The recovery-context seam: a user-initiated Start's wake message.
    {
      async readAgentRecoveryContext() {
        return {
          wakeMessage: {
            messageId: "wake-1",
            deliveryId: "delivery-1",
            conversationId: "conversation-1",
            sequence: 1,
            target: "@a",
            latestSenderKind: "human",
            latestSenderHandle: "owner",
            latestSenderDescription: "",
            body: "hello again",
          },
        };
      },
    },
  );
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save("w", "c", "daemon-token");
  const launches: AgentSessionOptions[] = [];
  const notices: string[] = [];
  runtime = new DaemonRuntime(
    connection,
    (provider) => ({
      provider,
      async createAgentSession(options) {
        launches.push(options);
        const identity = {
          sessionId: options.sessionId ?? `native-${launches.length}`,
          state: "resumable" as const,
        };
        return {
          readSessionIdentity: async () => identity,
          sendMessage: async () => {},
          notify: async (notice: string) => {
            notices.push(notice);
          },
          subscribe: () => () => {},
          onExit: () => () => {},
          interrupt: async () => {},
          dispose: async () => {},
        };
      },
    }),
    credentials,
    {
      create: () => ({
        start: async () => {},
        async ready(get) {
          daemonInstanceId = get().workerInstanceId;
        },
        stop: async () => {},
        async requestAgentLaunchConfig(input) {
          await control.authorizeLaunch({ ...input, computerId: "c" });
          return { agentApiKey: `sk_agent_${"x".repeat(43)}` };
        },
        revokeAgentApiKey: async () => {},
        sendAgentControlResult: (result) => control.result(connection, result),
        reportAgentSession,
      }),
    },
    undefined,
    {
      runtimes: async () => [],
      cachedCatalogs: async () => ({ catalogs: [], needsRefresh: false }),
      catalogs: async () => [],
    },
    join(root, "state"),
  );
  try {
    await runtime.start(connection);
    const first = await control.execute({
      action: "start",
      agentId: "a",
      workspaceId: "w",
      userId: "owner",
      requestId: crypto.randomUUID(),
    });
    await Promise.all(deliveries);
    expect(first.phase).toBe("completed");
    expect(launches.length).toBe(1);
    const firstEpoch = agent.state?.epoch;
    const firstLaunchId = agent.state?.launchId;
    expect(firstLaunchId).toBeTruthy();

    // A second Start — a new requestId — reaches the Daemon while the first Start's process is
    // still running. It must rebind that process, never launch a second one.
    const second = await control.execute({
      action: "start",
      agentId: "a",
      workspaceId: "w",
      userId: "owner",
      requestId: crypto.randomUUID(),
    });
    await Promise.all(deliveries);
    expect(second.phase).toBe("completed");
    expect(launches.length).toBe(1);
    expect(agent.state?.epoch).toBe((firstEpoch ?? 0) + 1);
    expect(agent.state?.launchId).toBeTruthy();
    expect(agent.state?.launchId).not.toBe(firstLaunchId);

    // The Start's wake message was delivered to the running process as a body-free recovery
    // notice, exactly like the existing equal-epoch replay branch already delivers one.
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("[CoForge inbox notice (restart recovery):");
    expect(notices[0]).toContain("@a  new: 1 message");
    expect(notices[0]).not.toContain("hello again");

    // A later sequenced Session snapshot from the SAME (rebound) process — the shape
    // AgentSessions.capture/replay build on the Daemon side — is accepted, not rejected as
    // stale, because `AgentSessions.prepare` already carried the server-supplied launchId into
    // `RuntimeSessionReference` ahead of the Daemon's own report.
    const rebound = agent.state!;
    await reportAgentSession({
      protocolMajor: 1,
      requestId: crypto.randomUUID(),
      workspaceId: "w",
      computerId: "c",
      agentId: "a",
      provider: "pi",
      sessionId: rebound.identity!.sessionId,
      startRequestId: rebound.requestId,
      daemonInstanceId: daemonInstanceId!,
      launchId: rebound.launchId!,
      controlEpoch: rebound.epoch,
      sequence: 99,
      sessionState: "resumable",
    });
    expect(agent.state?.sessionSequence).toBe(99);

    // The fence stays tight, not vacuous: a snapshot claiming a launchId that is neither the
    // current one nor the one it replaced is still rejected by both collaborators the RPC method
    // consults (`AgentSessionReceiver.authorize` here; `AgentSessions.verify` would reject it
    // too — proven separately below by calling it directly — proving `prepare()` recorded a real
    // launchId for this request rather than leaving `RuntimeSessionReference.launchId` unset,
    // which would make its comparison a no-op instead of an exact match).
    await expect(
      reportAgentSession({
        protocolMajor: 1,
        requestId: crypto.randomUUID(),
        workspaceId: "w",
        computerId: "c",
        agentId: "a",
        provider: "pi",
        sessionId: rebound.identity!.sessionId,
        startRequestId: rebound.requestId,
        daemonInstanceId: daemonInstanceId!,
        launchId: "unrelated-launch-id",
        controlEpoch: rebound.epoch,
        sequence: 100,
        sessionState: "resumable",
      }),
    ).rejects.toThrow("Session launch is not current");
    expect(agent.state?.sessionSequence).toBe(99);
    await expect(
      sessions.verify({
        protocolMajor: 1,
        requestId: crypto.randomUUID(),
        workspaceId: "w",
        computerId: "c",
        agentId: "a",
        provider: "pi",
        sessionId: rebound.identity!.sessionId,
        startRequestId: rebound.requestId,
        daemonInstanceId: daemonInstanceId!,
        launchId: "unrelated-launch-id",
        controlEpoch: rebound.epoch,
        sequence: 101,
        sessionState: "resumable",
      }),
    ).rejects.toThrow("Agent session report is stale or unauthorized");
  } finally {
    await Promise.allSettled(deliveries);
    await runtime.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("Full Reset completes, not fails, when the workspace clear cannot finish", async () => {
  // macOS resolves os.tmpdir() through the /var -> /private/var symlink, which the
  // store's symlinked-ancestor guard rightly rejects; anchor the fixture on the real path.
  const root = await mkdtemp(join(await realpath(tmpdir()), "control-roundtrip-clear-failure-"));
  const connection = { workspaceId: "w", computerId: "c", workspaceRoot: join(root, "workspaces") };
  let agent: AgentControlAgent = {
    id: "a",
    ownerId: "owner",
    visibility: "public",
    workspaceId: "w",
    computerId: "c",
    runtimeConfig: {
      runtime: "pi",
      provider: { kind: "default" },
      model: "",
      modelProvider: "",
      reasoning: "",
    },
    state: null,
  };
  const store: AgentControlStore = {
    async memberRole() {
      return "owner" as const;
    },
    async get() {
      return structuredClone(agent);
    },
    async replace(before, state) {
      if (JSON.stringify(before.state) !== JSON.stringify(agent.state)) return false;
      agent = { ...agent, state: structuredClone(state) };
      return true;
    },
  };
  let runtime: DaemonRuntime;
  const deliveries = new Set<Promise<unknown>>();
  const control = new AgentControl(
    store,
    {
      async publish(_channel, bytes) {
        let delivery: Promise<unknown> | undefined;
        try {
          delivery = runtime.handleAgentStop(decodeAgentStopIntent(bytes));
        } catch {}
        if (!delivery) {
          try {
            delivery = runtime.handleAgentWorkspaceReset(decodeAgentWorkspaceResetRequest(bytes));
          } catch {}
        }
        delivery ??= runtime.handleAgentStart(decodeAgentStartIntent(bytes));
        deliveries.add(delivery);
        const pending = delivery;
        void pending.finally(() => deliveries.delete(pending)).catch(() => {});
      },
    },
    { run: async (_id, work) => work() },
  );
  const sessions = new AgentSessionReceiver(store, async () => "daemon");
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save("w", "c", "daemon-token");
  let launches = 0;
  runtime = new DaemonRuntime(
    connection,
    (provider) => ({
      provider,
      async createAgentSession(options) {
        launches++;
        const identity = {
          sessionId: options.sessionId ?? `native-${launches}`,
          state: "resumable" as const,
        };
        return {
          readSessionIdentity: async () => identity,
          sendMessage: async () => {},
          notify: async () => {},
          subscribe: () => () => {},
          onExit: () => () => {},
          interrupt: async () => {},
          dispose: async () => {},
        };
      },
    }),
    credentials,
    {
      create: () => ({
        start: async () => {},
        ready: async () => {},
        stop: async () => {},
        async requestAgentLaunchConfig(input) {
          await control.authorizeLaunch({ ...input, computerId: "c" });
          return { agentApiKey: `sk_agent_${"x".repeat(43)}` };
        },
        revokeAgentApiKey: async () => {},
        sendAgentControlResult: (result) => control.result(connection, result),
        async reportAgentSession(report) {
          await sessions.authorize(connection, report);
          if (report.sequence !== undefined && report.controlEpoch && report.sessionState)
            await sessions.accept(connection, {
              ...report,
              requestId: report.startRequestId,
              epoch: report.controlEpoch,
              sequence: report.sequence,
              identity: { sessionId: report.sessionId, state: report.sessionState },
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
    join(root, "state"),
  );
  const execute = (action: "restart" | "full-reset") =>
    control.execute({
      action,
      agentId: "a",
      workspaceId: "w",
      userId: "owner",
      requestId: crypto.randomUUID(),
      confirmed: true,
    });
  const workspace = join(connection.workspaceRoot, "w", "agents", "a");
  const blocked = join(workspace, "blocked-dir");
  try {
    await runtime.start(connection);
    expect((await execute("restart")).phase).toBe("completed");
    await mkdir(blocked, { recursive: true });
    await Bun.write(join(blocked, "stuck"), "cannot delete me");
    await Bun.write(join(workspace, "keep.txt"), "deletable");
    // No write permission on `blocked`: the daemon's clear cannot remove its contents.
    await chmod(blocked, 0o500);
    const result = await execute("full-reset");
    expect(result).toMatchObject({ phase: "completed" });
    expect(result).not.toHaveProperty("warning");
    expect(await Bun.file(join(workspace, "keep.txt")).exists()).toBe(false);
    expect(await Bun.file(join(blocked, "stuck")).exists()).toBe(true);
    // The chain still reached Start: a fresh session launched despite the clear failure.
    expect(agent.state?.identity?.sessionId).toBeDefined();
  } finally {
    await chmod(blocked, 0o700).catch(() => {});
    await Promise.allSettled(deliveries);
    await runtime.stop();
    await rm(root, { recursive: true, force: true });
  }
});

function decodePrimitive(bytes: Uint8Array) {
  try {
    decodeAgentStopIntent(bytes);
    return "stop";
  } catch {}
  try {
    decodeAgentWorkspaceResetRequest(bytes);
    return "workspace-reset";
  } catch {}
  decodeAgentStartIntent(bytes);
  return "start";
}

function logicalControlSteps(publications: Uint8Array[]) {
  // Control transport is at-least-once; duplicate publications must preserve
  // the stable request and payload, while Daemon performs the operation once.
  const seen = new Map<string, string>();
  return publications.flatMap((bytes) => {
    const step = decodePrimitive(bytes);
    const requestId = decodeControlRequestId(bytes);
    const key = `${step}:${requestId}`;
    const encoded = bytes.toBase64();
    const previous = seen.get(key);
    if (previous !== undefined) {
      expect(encoded).toBe(previous);
      return [];
    }
    seen.set(key, encoded);
    return [step];
  });
}

function decodeControlRequestId(bytes: Uint8Array) {
  for (const decode of [
    decodeAgentStopIntent,
    decodeAgentWorkspaceResetRequest,
    decodeAgentStartIntent,
  ]) {
    try {
      return decode(bytes).requestId;
    } catch {}
  }
  throw new Error("Unknown control publication");
}
