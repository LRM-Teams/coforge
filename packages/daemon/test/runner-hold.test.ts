import { afterAll, afterEach, expect, jest, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { DaemonRuntime, type WorkspaceConfig } from "../src/daemon-runtime/runtime";
import type { AgentRuntimeConfig, AgentSession } from "../src/code-agent/contract";
import { InMemoryDaemonCredentialStore } from "../src/credentials/credential-store";
import {
  AGENT_ACTIVITY_DETAIL_KIND,
  type AgentActivityDetailKind,
} from "@lrm/coforge-sdk/internal";

// macOS tmpdir lives under /var, a symlink; the state store rejects linked ancestors.
const tempRoot = realpathSync(tmpdir());
const workspaceRoot = join(tempRoot, `coforge-runner-hold-${crypto.randomUUID()}`);
const connection: WorkspaceConfig = {
  computerId: "computer-a",
  workspaceId: "workspace-a",
  workspaceRoot,
};

afterAll(() => rm(workspaceRoot, { recursive: true, force: true }));
afterEach(() => jest.useRealTimers());

const config: AgentRuntimeConfig = {
  provider: "pi",
  model: "default",
  modelProvider: "anthropic",
  reasoning: "balanced",
};

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

/**
 * Boots a runtime with one live Agent session, and hands the test the two things a runner hold
 * has to reason about: the delivery ACK (`acknowledgements`, the observable proof that a delivery
 * was handed on) and the Activity stream (`emit`, which drives the busy predicate).
 */
async function harness() {
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");
  const notices: string[] = [];
  const acknowledgements: string[] = [];
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
          async notify(notice: string) {
            notices.push(notice);
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
          return { agentApiKey: `sk_agent_${"a".repeat(43)}` };
        },
        async revokeAgentApiKey() {},
        sendAgentActivity() {},
        async sendAgentDeliveryAck(ack) {
          acknowledgements.push(ack.deliveryId);
        },
      }),
    },
  );
  await runtime.start(connection);
  await runtime.startAgent("agent-a", config);
  return {
    runtime,
    notices,
    acknowledgements,
    emit(detailKind: AgentActivityDetailKind) {
      listener({
        type: "activity",
        activity: { detailKind, level: "info", detail: detailKind, observedAtMs: Date.now() },
      });
    },
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

test("a held delivery is queued and never acknowledged, and release resumes it", async () => {
  const { runtime, acknowledgements, delivery } = await harness();

  runtime.holdRunners("upgrade");
  await delivery(1);

  // Not acked is the whole point: the server's AgentMessageDelivery.receivedAt stays null, so the
  // ready handshake after the restart republishes it. Nothing is lost and nothing is double-run.
  expect(acknowledgements).toEqual([]);

  runtime.releaseRunners();
  await Bun.sleep(10);
  expect(acknowledgements).toEqual(["delivery-1"]);
  await runtime.stop();
});

test("deliveries queued behind a hold resume in arrival order", async () => {
  const { runtime, acknowledgements, delivery } = await harness();

  runtime.holdRunners("upgrade");
  await delivery(1);
  await delivery(2);
  await delivery(3);
  expect(acknowledgements).toEqual([]);

  runtime.releaseRunners();
  await Bun.sleep(20);
  expect(acknowledgements).toEqual(["delivery-1", "delivery-2", "delivery-3"]);
  await runtime.stop();
});

test("hold is idempotent and re-reports the busy set on every call", async () => {
  const { runtime, emit } = await harness();

  emit(AGENT_ACTIVITY_DETAIL_KIND.TOOL_STARTED);
  const first = runtime.holdRunners("upgrade");
  const second = runtime.holdRunners("upgrade");

  expect(runtime.runnerHeld).toBe(true);
  expect(first).toHaveLength(1);
  expect(first[0]?.agentId).toBe("agent-a");
  expect(first[0]?.detailKind).toBe(AGENT_ACTIVITY_DETAIL_KIND.TOOL_STARTED);
  expect(second).toEqual(first);
  await runtime.stop();
});

test("the busy query follows BUSY and TERMINAL activity detail kinds", async () => {
  const { runtime, emit } = await harness();

  expect(runtime.busyAgents()).toEqual([]);

  emit(AGENT_ACTIVITY_DETAIL_KIND.RUNNING_COMMAND);
  expect(runtime.busyAgents().map((agent) => agent.detailKind)).toEqual([
    AGENT_ACTIVITY_DETAIL_KIND.RUNNING_COMMAND,
  ]);
  expect(runtime.busyAgents()[0]?.busySinceMs).toBeGreaterThan(0);

  emit(AGENT_ACTIVITY_DETAIL_KIND.IDLE);
  expect(runtime.busyAgents()).toEqual([]);
  await runtime.stop();
});

test("a hold refuses a brand-new Agent launch", async () => {
  const { runtime } = await harness();
  runtime.holdRunners("upgrade");
  await expect(runtime.startAgent("agent-b", config)).rejects.toThrow(/Agent launches are held/);
  await runtime.stop();
});

test("a restart clears the hold; nothing about it is persisted", async () => {
  const second = await harness();
  expect(second.runtime.runnerHeld).toBe(false);
  expect(second.runtime.busyAgents()).toEqual([]);
  await second.delivery(1);
  await Bun.sleep(10);
  expect(second.acknowledgements).toEqual(["delivery-1"]);
  await second.runtime.stop();
});
