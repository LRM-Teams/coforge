import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentControl,
  type AgentControlAgent,
  type AgentControlStore,
} from "../src/server/agents/agent-control.server";
import { AgentSessionReceiver } from "../src/server/agents/agent-session.server";
import { DaemonRuntime } from "../../../packages/daemon/src/daemon-runtime/runtime";
import { InMemoryDaemonCredentialStore } from "../../../packages/daemon/src/credentials/credential-store";
import { AgentSessionRecoveryError } from "../../../packages/daemon/src/code-agent/contract";
import {
  decodeAgentStartIntent,
  decodeAgentStopIntent,
  decodeAgentWorkspaceResetRequest,
  type AgentStartIntent,
} from "@coforge/protocol";
import type { AgentSessionOptions } from "../../../packages/agent/src/contract";

test("cloud and daemon preserve Restart identity, reset sessions, fence Full Reset replay and report recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "control-roundtrip-"));
  const connection = { workspaceId: "w", computerId: "c", workspaceRoot: join(root, "workspaces") };
  let agent: AgentControlAgent = {
    id: "a",
    ownerId: "owner",
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
  const sessions = new AgentSessionReceiver(store);
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
      async () => ({ runtimes: [], catalogs: [] }),
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
