import { expect, test } from "bun:test";
import { RedisWorkspaceMemorySweepLock } from "../workspace-memory/lifecycle.server";
import {
  createWorkspaceMemoryAdmissionSweep,
  type WorkspaceMemorySweepLock,
} from "../workspace-memory/sweep";
import { createInMemoryWorkspaceMemoryCatalog } from "../workspace-memory/catalog";
import { createInMemoryWorkspaceMemoryAdmissionStore } from "../workspace-memory/dispatch";
import { createInMemoryWorkspaceMemoryProfileStore } from "../workspace-memory/stores";
import {
  createFakeMemoryRuntimeProvisioner,
  createWorkspaceMemoryProfileReconciler,
} from "../workspace-memory/reconciler";
import {
  createAdmissionDispatcher,
  createOpenVikingNativeSessionSink,
} from "../workspace-memory/dispatch";

test("the Redis lock keeps a second sweeper from ingesting in the same window", async () => {
  let held = false;
  const lock: WorkspaceMemorySweepLock = {
    async acquire() {
      if (held) return false;
      held = true;
      return true;
    },
  };
  let calls = 0;
  const catalog = createInMemoryWorkspaceMemoryCatalog({
    async listAdmittedMessageIds() {
      return new Set();
    },
    async listRetryableDispatches() {
      return [];
    },
  });
  const listKnown = catalog.listKnownWorkspaceIds.bind(catalog);
  catalog.listKnownWorkspaceIds = async () => {
    calls += 1;
    return listKnown();
  };
  const store = createInMemoryWorkspaceMemoryProfileStore();
  const admission = createInMemoryWorkspaceMemoryAdmissionStore();
  const reconciler = createWorkspaceMemoryProfileReconciler({
    store,
    provisioner: createFakeMemoryRuntimeProvisioner(),
  });
  const dispatcher = createAdmissionDispatcher({
    admission,
    sinks: {
      openviking: createOpenVikingNativeSessionSink(),
      causal_openviking: createOpenVikingNativeSessionSink(),
    },
  });
  const sweepA = createWorkspaceMemoryAdmissionSweep({
    profiles: store,
    catalog,
    admission,
    dispatcher,
    reconciler,
    lock,
  });
  const sweepB = createWorkspaceMemoryAdmissionSweep({
    profiles: store,
    catalog,
    admission,
    dispatcher,
    reconciler,
    lock,
  });
  await sweepA.tick();
  await sweepB.tick();
  expect(calls).toBe(1);
});

test("Redis NX lock adapter reports acquisition from the SET result", async () => {
  const calls: Array<Array<string | number>> = [];
  const redis = {
    async set(...args: Array<string | number>) {
      calls.push(args);
      return "OK";
    },
  };
  const lock = new RedisWorkspaceMemorySweepLock(redis);
  expect(await lock.acquire("replica-a")).toBe(true);
  expect(calls[0]?.[0]).toBe("coforge:workspace-memory:admission-sweep:lock");
});
