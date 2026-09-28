import { expect, test } from "bun:test";

import { encodeDaemonRuntimeReadyRequest } from "@lrm/coforge-sdk/internal";

import { createDaemonRuntimeReadyMethod } from "#src/server/centrifugo/rpc-handler.server";

const principal = () => ({
  userId: "user-1",
  workspaceId: "workspace-1",
  computerId: "computer-1",
});

const readyPayload = () =>
  encodeDaemonRuntimeReadyRequest({
    protocolMajor: 1,
    requestId: "ready-1",
    workspaceId: "workspace-1",
    computerId: "computer-1",
    workerInstanceId: "worker-1",
    daemonVersion: "1.2.3",
    computerVersion: "4.5.6",
    platform: "linux",
    osVersion: "6.8.0",
    startedAt: 1,
    runningAgentIds: ["agent-running"],
    recoveredRestartRequestIds: [],
    recoveredUpgradeRequestIds: [],
    capabilities: ["reminder:v1"],
  });

/**
 * A daemon whose ready keeps failing can only report what it was told. Until this, every stage
 * answered with one fixed sentence about Agent start recovery, so the 13-hour outage on
 * 2026-09-18 — which failed inside Agent recovery — was indistinguishable from a reminder or
 * upgrade failure, and the `stage` this server logged was wrong too, because it only advanced
 * before the last two steps.
 */
test("a failing ready names the stage that failed", async () => {
  const cases: { stage: string; method: ReturnType<typeof createDaemonRuntimeReadyMethod> }[] = [
    {
      stage: "restart_recovery",
      method: createDaemonRuntimeReadyMethod(undefined, {
        ready: async () => {
          throw new Error("restart store is down");
        },
      } as never),
    },
    {
      stage: "capability_record",
      method: createDaemonRuntimeReadyMethod(undefined, undefined, {
        record: async () => {
          throw new Error("capability store is down");
        },
      }),
    },
    {
      stage: "agent_recovery",
      method: createDaemonRuntimeReadyMethod({
        recoverWorkspace: async () => {
          throw new Error("a pending delivery could not be projected");
        },
      }),
    },
    {
      stage: "reminder_recovery",
      method: createDaemonRuntimeReadyMethod(undefined, undefined, undefined, {
        snapshotAssigned: async () => {
          throw new Error("reminder mirror is down");
        },
      }),
    },
  ];

  for (const { stage, method } of cases)
    expect(await method(readyPayload(), { principal: principal() }), stage).toEqual({
      code: 503,
      message: `daemon ready failed at ${stage}`,
    });
});

test("a ready that completes still answers with bytes, not a stage", async () => {
  const method = createDaemonRuntimeReadyMethod({ recoverWorkspace: async () => {} });
  expect(await method(readyPayload(), { principal: principal() })).toBeInstanceOf(Uint8Array);
});
