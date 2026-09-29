import { expect, test } from "bun:test";
import {
  AGENT_ACTIVITY_DETAIL_KIND,
  decodeAgentActivity,
  type DaemonShutdownReason,
} from "@lrm/coforge-sdk/internal";

import {
  ComputerLifecycleActivity,
  type ComputerLifecycleActivityPorts,
  type ComputerReturn,
} from "#src/server/agents/computer-lifecycle-activity.server";
import type { TrustedAgentActivity } from "#src/server/db/repositories/agent-activity.repositories.server";
import type { AgentVisibility } from "#src/features/agents/agent-visibility";
import { decodeActivityObservation } from "#src/features/agents/agent-activity";

const scope = { workspaceId: "workspace-1", computerId: "computer-1" };

function harness(
  overrides: Partial<ComputerLifecycleActivityPorts> = {},
  agents: { id: string; visibility: AgentVisibility }[] = [
    { id: "agent-public", visibility: "public" },
    { id: "agent-private", visibility: "private" },
  ],
) {
  const batches: TrustedAgentActivity[][] = [];
  const published: { channel: string; data: Uint8Array }[] = [];
  let shutdown: DaemonShutdownReason | undefined;
  let lastInstance: { workerInstanceId: string; computerVersion?: string } | undefined;
  const lifecycle = new ComputerLifecycleActivity({
    agents: async (requested) => {
      expect(requested).toEqual(scope);
      return agents;
    },
    record: async (activities) => void batches.push(activities),
    publish: async (channel, data) => void published.push({ channel, data }),
    memory: {
      rememberShutdown: async (_, reason) => void (shutdown = reason),
      takeShutdown: async () => {
        const reason = shutdown;
        shutdown = undefined;
        return reason;
      },
      claimReturn: async (_, instance) => {
        const previous = lastInstance;
        lastInstance = instance;
        if (previous?.workerInstanceId === instance.workerInstanceId) return { first: false };
        return previous?.computerVersion
          ? { first: true, previousComputerVersion: previous.computerVersion }
          : { first: true };
      },
    },
    upgradeStatus: async () => undefined,
    restartStatus: async () => undefined,
    now: () => 1_700_000_000_000,
    ...overrides,
  });
  const rows = () => batches.flat();
  return { lifecycle, batches, rows, published };
}

const back = (overrides: Partial<ComputerReturn> = {}): ComputerReturn => ({
  requestId: "ready-2",
  workerInstanceId: "worker-2",
  computerVersion: "1.0.0",
  recoveredUpgradeRequestIds: [],
  recoveredRestartRequestIds: [],
  ...overrides,
});

/** A Computer that was already announced as running `version` on `worker-1`. */
async function running(h: ReturnType<typeof harness>, version = "1.0.0") {
  await h.lifecycle.ready(scope, back({ workerInstanceId: "worker-1", computerVersion: version }));
  h.batches.length = 0;
  h.published.length = 0;
}

test("a shutdown notice writes one disconnected row per Agent on that Computer, in one batch", async () => {
  const h = harness();

  await h.lifecycle.shutdown(scope, { requestId: "shutdown-1", reason: "computer_upgrade" });

  expect(h.batches).toHaveLength(1);
  expect(h.rows()).toEqual([
    expect.objectContaining({
      workspaceId: "workspace-1",
      computerId: "computer-1",
      agentId: "agent-public",
      detailKind: AGENT_ACTIVITY_DETAIL_KIND.COMPUTER_DISCONNECTED,
      level: "info",
      detail: "",
      observedAtMs: 1_700_000_000_000,
      launchId: "computer-lifecycle:shutdown-1",
      clientSeq: 1,
    }),
    expect.objectContaining({ agentId: "agent-private" }),
  ]);
});

test("each row goes live on the channel its Agent's visibility allows, in a shape pages accept", async () => {
  const h = harness();

  await h.lifecycle.shutdown(scope, { requestId: "shutdown-1", reason: "computer_stop" });

  expect(h.published.map(({ channel }) => channel)).toEqual([
    "agent:activity:workspace-1",
    "agent:activity:workspace-1:agent-private",
  ]);
  expect(
    decodeActivityObservation(h.published[0]!.data, { workspaceId: "workspace-1" }),
  ).toMatchObject({
    agentId: "agent-public",
    entry: { detailKind: "computer_disconnected", detail: "" },
  });
  expect(decodeAgentActivity(h.published[1]!.data).activityKind).toBeUndefined();
});

test("a first ready of a new daemon instance with no notice before it is a start", async () => {
  const h = harness();
  await running(h);

  await h.lifecycle.ready(scope, back());

  expect(h.rows()).toEqual([
    expect.objectContaining({
      agentId: "agent-public",
      detailKind: AGENT_ACTIVITY_DETAIL_KIND.COMPUTER_STARTED,
      level: "info",
      detail: "",
      launchId: "computer-lifecycle:ready-2",
    }),
    expect.objectContaining({ agentId: "agent-private" }),
  ]);
});

test("later readies of the same daemon instance write nothing", async () => {
  const h = harness();
  await running(h);

  await h.lifecycle.ready(scope, back());
  await h.lifecycle.ready(scope, back({ requestId: "ready-3" }));

  expect(h.batches).toHaveLength(1);
});

test("a restart the Computer announced comes back as restarted", async () => {
  const h = harness();
  await running(h);
  await h.lifecycle.shutdown(scope, { requestId: "shutdown-1", reason: "computer_restart" });
  h.batches.length = 0;

  await h.lifecycle.ready(scope, back());

  expect(h.rows()[0]).toMatchObject({ detailKind: "computer_restarted", detail: "" });
});

test("a restart the server recorded as completed by this instance comes back as restarted", async () => {
  const h = harness({
    restartStatus: async (_, requestId) =>
      requestId === "restart-1" ? { status: "completed", workerInstanceId: "worker-2" } : undefined,
  });
  await running(h);

  await h.lifecycle.ready(scope, back({ recoveredRestartRequestIds: ["restart-1"] }));

  expect(h.rows()[0]).toMatchObject({ detailKind: "computer_restarted" });
});

test("an upgrade the server verified comes back as upgraded", async () => {
  const h = harness({
    upgradeStatus: async () => ({ status: "completed", workerInstanceId: "worker-2" }),
  });
  await running(h);
  await h.lifecycle.shutdown(scope, { requestId: "shutdown-1", reason: "computer_upgrade" });
  h.batches.length = 0;

  await h.lifecycle.ready(
    scope,
    back({ computerVersion: "1.1.0", recoveredUpgradeRequestIds: ["upgrade-1"] }),
  );

  expect(h.rows()[0]).toMatchObject({
    detailKind: "computer_upgraded",
    level: "info",
    detail: "",
  });
});

test("an upgrade that failed and rolled back is one failed operation, saying what runs and what to do", async () => {
  const h = harness({ upgradeStatus: async () => ({ status: "failed" }) });
  await running(h);
  await h.lifecycle.shutdown(scope, { requestId: "shutdown-1", reason: "computer_upgrade" });
  h.batches.length = 0;

  await h.lifecycle.ready(scope, back({ recoveredUpgradeRequestIds: ["upgrade-1"] }));

  expect(h.rows()).toEqual([
    expect.objectContaining({
      agentId: "agent-public",
      detailKind: AGENT_ACTIVITY_DETAIL_KIND.COMPUTER_OPERATION_FAILED,
      level: "error",
      detail:
        "The upgrade did not complete; still running 1.0.0. Run `coforge-computer upgrade` to try again.",
    }),
    expect.objectContaining({ agentId: "agent-private", level: "error" }),
  ]);
});

test("without an upgrade record, the version decides: a changed version is an upgrade", async () => {
  const h = harness();
  await running(h, "1.0.0");
  await h.lifecycle.shutdown(scope, { requestId: "shutdown-1", reason: "computer_upgrade" });
  h.batches.length = 0;

  await h.lifecycle.ready(scope, back({ computerVersion: "1.1.0" }));

  expect(h.rows()[0]).toMatchObject({ detailKind: "computer_upgraded" });
});

test("without an upgrade record, an announced upgrade that kept the old version did not complete", async () => {
  const h = harness();
  await running(h, "1.0.0");
  await h.lifecycle.shutdown(scope, { requestId: "shutdown-1", reason: "computer_upgrade" });
  h.batches.length = 0;

  await h.lifecycle.ready(scope, back({ computerVersion: "1.0.0" }));

  expect(h.rows()[0]).toMatchObject({
    detailKind: "computer_operation_failed",
    level: "error",
    detail: expect.stringContaining("The upgrade did not complete"),
  });
});

test("one Agent's failed publish does not keep the others from theirs", async () => {
  const published: string[] = [];
  const h = harness({
    publish: async (channel) => {
      if (channel === "agent:activity:workspace-1") throw new Error("Centrifugo is down");
      published.push(channel);
    },
  });

  await h.lifecycle.shutdown(scope, { requestId: "shutdown-1", reason: "computer_stop" });

  expect(published).toEqual(["agent:activity:workspace-1:agent-private"]);
});
