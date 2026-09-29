import { expect, test } from "bun:test";
import {
  encodeDaemonRuntimeReadyRequest,
  encodeDaemonRuntimeShutdown,
  type DaemonRuntimeShutdown,
} from "@lrm/coforge-sdk/internal";

import {
  createDaemonRuntimeReadyMethod,
  createDaemonRuntimeShutdownMethod,
} from "#src/server/centrifugo/rpc-handler.server";

const principal = () => ({
  userId: "user-1",
  workspaceId: "workspace-1",
  computerId: "computer-1",
});

const notice = (overrides: Partial<DaemonRuntimeShutdown> = {}) =>
  encodeDaemonRuntimeShutdown({
    protocolMajor: 1,
    requestId: "shutdown-1",
    workspaceId: "workspace-1",
    computerId: "computer-1",
    workerInstanceId: "worker-1",
    reason: "computer_upgrade",
    ...overrides,
  });

function recorder() {
  const calls: unknown[][] = [];
  return {
    calls,
    lifecycle: { shutdown: async (...args: unknown[]) => void calls.push(args) },
  };
}

test("records the shutdown of the connection's own Computer", async () => {
  const { calls, lifecycle } = recorder();
  const method = createDaemonRuntimeShutdownMethod(lifecycle, async () => "worker-1");

  expect(await method(notice(), { principal: principal() })).toBeInstanceOf(Uint8Array);
  expect(calls).toEqual([
    [
      { workspaceId: "workspace-1", computerId: "computer-1" },
      { requestId: "shutdown-1", reason: "computer_upgrade" },
    ],
  ]);
});

test("each refusal has its own code: malformed, another Computer's, from a replaced daemon", async () => {
  const { calls, lifecycle } = recorder();
  const method = createDaemonRuntimeShutdownMethod(lifecycle, async () => "worker-2");

  expect(await method(new Uint8Array([1, 2, 3]), { principal: principal() })).toMatchObject({
    code: 400,
  });
  expect(
    await method(notice({ computerId: "computer-2" }), { principal: principal() }),
  ).toMatchObject({ code: 403 });
  expect(await method(notice(), { principal: principal() })).toMatchObject({ code: 409 });
  expect(calls).toEqual([]);
});

test("a notice that could not be recorded answers 503", async () => {
  const method = createDaemonRuntimeShutdownMethod({
    shutdown: async () => {
      throw new Error("redis is down");
    },
  });

  expect(await method(notice(), { principal: principal() })).toEqual({
    code: 503,
    message: "daemon shutdown notice was not recorded",
  });
});

const readyPayload = () =>
  encodeDaemonRuntimeReadyRequest({
    protocolMajor: 1,
    requestId: "ready-1",
    workspaceId: "workspace-1",
    computerId: "computer-1",
    workerInstanceId: "worker-1",
    daemonVersion: "1.2.3",
    computerVersion: "0.1.0-dev.80",
    startedAt: 1,
    runningAgentIds: [],
    recoveredRestartRequestIds: ["restart-1"],
    recoveredUpgradeRequestIds: ["upgrade-1"],
  });

test("a ready hands the Computer's return to lifecycle Activity without waiting for it", async () => {
  const calls: unknown[][] = [];
  const method = createDaemonRuntimeReadyMethod({
    lifecycle: {
      ready: (...args: unknown[]) => {
        calls.push(args);
        return new Promise<void>(() => {});
      },
    },
  });

  expect(await method(readyPayload(), { principal: principal() })).toBeInstanceOf(Uint8Array);
  expect(calls).toEqual([
    [
      { workspaceId: "workspace-1", computerId: "computer-1" },
      {
        requestId: "ready-1",
        workerInstanceId: "worker-1",
        computerVersion: "0.1.0-dev.80",
        recoveredUpgradeRequestIds: ["upgrade-1"],
        recoveredRestartRequestIds: ["restart-1"],
      },
    ],
  ]);
});

test("a ready whose lifecycle rows fail still succeeds", async () => {
  const method = createDaemonRuntimeReadyMethod({
    lifecycle: {
      ready: async () => {
        throw new Error("redis is down");
      },
    },
  });

  expect(await method(readyPayload(), { principal: principal() })).toBeInstanceOf(Uint8Array);
});
