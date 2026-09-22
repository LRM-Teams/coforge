import { expect, test } from "bun:test";
import { createInMemoryWorkspaceMemoryCatalog } from "./catalog";
import {
  createAdmissionDispatcher,
  createInMemoryWorkspaceMemoryAdmissionStore,
  type AdmissionSink,
  type AdmissionSinkDelivery,
} from "./dispatch";
import { createDefaultWorkspaceMemoryProfile } from "./profile";
import { createWorkspaceMemoryProfiles } from "./profiles";
import {
  createFakeMemoryRuntimeProvisioner,
  createWorkspaceMemoryProfileReconciler,
  type WorkspaceMemoryProfileReconciler,
} from "./reconciler";
import { createInMemoryWorkspaceMemoryProfileStore } from "./stores";
import { createWorkspaceMemoryAdmissionSweep, type WorkspaceMemorySweepLock } from "./sweep";

const activatedAt = new Date("2026-09-21T12:00:00.000Z");
const sweepNow = new Date("2026-09-21T12:30:00.000Z");
const enabled = { prototypeEnabled: true };

function exclusiveLock(): WorkspaceMemorySweepLock & { heldBy?: string } {
  const lock: WorkspaceMemorySweepLock & { heldBy?: string } = {
    async acquire(instanceId) {
      if (lock.heldBy) return false;
      lock.heldBy = instanceId;
      return true;
    },
  };
  return lock;
}

function recordingSink() {
  const deliveries: AdmissionSinkDelivery[] = [];
  const sink: AdmissionSink = {
    async deliver(input) {
      deliveries.push(input);
      return { outcome: "delivered" };
    },
  };
  return { sink, deliveries };
}

async function readyHarness(desired: "openviking" | "causal_openviking" = "causal_openviking") {
  const store = createInMemoryWorkspaceMemoryProfileStore();
  const admission = createInMemoryWorkspaceMemoryAdmissionStore();
  const catalog = createInMemoryWorkspaceMemoryCatalog(admission);
  const profiles = createWorkspaceMemoryProfiles({ store, gate: enabled });
  const provisioner = createFakeMemoryRuntimeProvisioner();
  const reconciler = createWorkspaceMemoryProfileReconciler({ store, provisioner });
  const openviking = recordingSink();
  const causal = recordingSink();
  const dispatcher = createAdmissionDispatcher({
    admission,
    sinks: { openviking: openviking.sink, causal_openviking: causal.sink },
  });
  await profiles.selectDesired({
    workspaceId: "ws-a",
    desired,
    at: activatedAt,
    afterMessageId: "msg-boundary",
  });
  const settled = await reconciler.reconcile("ws-a");
  expect(settled.ok).toBe(true);
  const profile = await store.get("ws-a");
  if (!profile) throw new Error("profile missing");
  catalog.seedProfile(profile);
  return {
    store,
    admission,
    catalog,
    reconciler,
    dispatcher,
    openviking,
    causal,
    profile,
  };
}

test("sweep does not backfill pre-activation PublicChannel history", async () => {
  const harness = await readyHarness();
  harness.catalog.seedConversation({ id: "ch-eng", workspaceId: "ws-a", channelName: "eng" });
  harness.catalog.seedMessages([
    {
      id: "m-old",
      conversationId: "ch-eng",
      workspaceId: "ws-a",
      sequence: 1,
      createdAt: new Date("2026-09-21T11:00:00.000Z"),
      body: "history",
      senderKind: "human",
      senderHandle: "ada",
    },
    {
      id: "m-live",
      conversationId: "ch-eng",
      workspaceId: "ws-a",
      sequence: 2,
      createdAt: new Date("2026-09-21T12:05:00.000Z"),
      body: "live",
      senderKind: "human",
      senderHandle: "ada",
    },
  ]);
  const sweep = createWorkspaceMemoryAdmissionSweep({
    profiles: harness.store,
    catalog: harness.catalog,
    admission: harness.admission,
    dispatcher: harness.dispatcher,
    reconciler: harness.reconciler,
    lock: exclusiveLock(),
    now: () => sweepNow,
    quietAfterMs: 15 * 60 * 1000,
  });
  await sweep.tick();
  expect(harness.causal.deliveries.map((row) => row.segment.sourceMessageIds)).toEqual([
    ["m-live"],
  ]);
  expect(harness.openviking.deliveries).toEqual([]);
});

test("off and provisioning workspaces do not ingest", async () => {
  const store = createInMemoryWorkspaceMemoryProfileStore();
  const admission = createInMemoryWorkspaceMemoryAdmissionStore();
  const catalog = createInMemoryWorkspaceMemoryCatalog(admission);
  const profiles = createWorkspaceMemoryProfiles({ store, gate: enabled });
  const reconciler: WorkspaceMemoryProfileReconciler = {
    async reconcile() {
      return {
        ok: true,
        profile: createDefaultWorkspaceMemoryProfile("ws-off"),
        effects: { ensured: [], processing: "stopped" },
      };
    },
  };
  const openviking = recordingSink();
  const dispatcher = createAdmissionDispatcher({
    admission,
    sinks: { openviking: openviking.sink, causal_openviking: recordingSink().sink },
  });
  catalog.seedProfile(createDefaultWorkspaceMemoryProfile("ws-off"));
  await profiles.selectDesired({
    workspaceId: "ws-provisioning",
    desired: "openviking",
    at: activatedAt,
  });
  const provisioning = await store.get("ws-provisioning");
  if (!provisioning) throw new Error("missing");
  catalog.seedProfile(provisioning);
  catalog.seedConversation({ id: "ch-off", workspaceId: "ws-off", channelName: "eng" });
  catalog.seedConversation({ id: "ch-p", workspaceId: "ws-provisioning", channelName: "eng" });
  catalog.seedMessages([
    {
      id: "m-off",
      conversationId: "ch-off",
      workspaceId: "ws-off",
      sequence: 1,
      createdAt: new Date("2026-09-21T11:00:00.000Z"),
      body: "off",
      senderKind: "human",
      senderHandle: "ada",
    },
    {
      id: "m-p",
      conversationId: "ch-p",
      workspaceId: "ws-provisioning",
      sequence: 1,
      createdAt: new Date("2026-09-21T12:05:00.000Z"),
      body: "provisioning",
      senderKind: "human",
      senderHandle: "ada",
    },
  ]);
  const sweep = createWorkspaceMemoryAdmissionSweep({
    profiles: store,
    catalog,
    admission,
    dispatcher,
    reconciler,
    lock: exclusiveLock(),
    now: () => sweepNow,
    quietAfterMs: 1,
  });
  await sweep.tick();
  expect(openviking.deliveries).toEqual([]);
});

test("DirectConversation never enters the common dispatcher", async () => {
  const harness = await readyHarness();
  harness.catalog.seedConversation({ id: "dm-1", workspaceId: "ws-a", channelName: null });
  harness.catalog.seedMessages([
    {
      id: "m-dm",
      conversationId: "dm-1",
      workspaceId: "ws-a",
      sequence: 1,
      createdAt: new Date("2026-09-21T12:05:00.000Z"),
      body: "private",
      senderKind: "human",
      senderHandle: "ada",
    },
  ]);
  const sweep = createWorkspaceMemoryAdmissionSweep({
    profiles: harness.store,
    catalog: harness.catalog,
    admission: harness.admission,
    dispatcher: harness.dispatcher,
    reconciler: harness.reconciler,
    lock: exclusiveLock(),
    now: () => sweepNow,
    quietAfterMs: 1,
  });
  await sweep.tick();
  expect(harness.causal.deliveries).toEqual([]);
  expect(harness.openviking.deliveries).toEqual([]);
});

test("a second replica lock holder does not double-dispatch", async () => {
  const harness = await readyHarness();
  harness.catalog.seedConversation({ id: "ch-eng", workspaceId: "ws-a", channelName: "eng" });
  harness.catalog.seedMessages([
    {
      id: "m-live",
      conversationId: "ch-eng",
      workspaceId: "ws-a",
      sequence: 1,
      createdAt: new Date("2026-09-21T12:05:00.000Z"),
      body: "live",
      senderKind: "human",
      senderHandle: "ada",
    },
  ]);
  const lock = exclusiveLock();
  const sweepA = createWorkspaceMemoryAdmissionSweep({
    profiles: harness.store,
    catalog: harness.catalog,
    admission: harness.admission,
    dispatcher: harness.dispatcher,
    reconciler: harness.reconciler,
    lock,
    now: () => sweepNow,
    quietAfterMs: 1,
  });
  const sweepB = createWorkspaceMemoryAdmissionSweep({
    profiles: harness.store,
    catalog: harness.catalog,
    admission: harness.admission,
    dispatcher: harness.dispatcher,
    reconciler: harness.reconciler,
    lock,
    now: () => sweepNow,
    quietAfterMs: 1,
  });
  await sweepA.tick();
  await sweepB.tick();
  expect(harness.causal.deliveries).toHaveLength(1);
  expect(await harness.admission.getDispatch("ws-a", "quiet-ch-eng-m-live")).toMatchObject({
    state: "delivered",
    sinkProfile: "causal_openviking",
  });
});

test("a hung memory sink does not block Message persistence", async () => {
  const harness = await readyHarness("openviking");
  harness.catalog.seedConversation({ id: "ch-eng", workspaceId: "ws-a", channelName: "eng" });
  harness.catalog.seedMessages([
    {
      id: "m-live",
      conversationId: "ch-eng",
      workspaceId: "ws-a",
      sequence: 1,
      createdAt: new Date("2026-09-21T12:05:00.000Z"),
      body: "live",
      senderKind: "human",
      senderHandle: "ada",
    },
  ]);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const hung: AdmissionSink = {
    async deliver() {
      await blocked;
      return { outcome: "delivered" };
    },
  };
  const dispatcher = createAdmissionDispatcher({
    admission: harness.admission,
    sinks: { openviking: hung, causal_openviking: recordingSink().sink },
  });
  const sweep = createWorkspaceMemoryAdmissionSweep({
    profiles: harness.store,
    catalog: harness.catalog,
    admission: harness.admission,
    dispatcher,
    reconciler: harness.reconciler,
    lock: exclusiveLock(),
    now: () => sweepNow,
    quietAfterMs: 1,
  });
  const tick = sweep.tick();
  const persistMessage = async () => ({ id: "m-new", body: "hello" });
  const message = await persistMessage();
  expect(message).toEqual({ id: "m-new", body: "hello" });
  release();
  await tick;
});

test("sweep tick swallows sink failures so the Message path can continue", async () => {
  const harness = await readyHarness();
  harness.catalog.seedConversation({ id: "ch-eng", workspaceId: "ws-a", channelName: "eng" });
  harness.catalog.seedMessages([
    {
      id: "m-live",
      conversationId: "ch-eng",
      workspaceId: "ws-a",
      sequence: 1,
      createdAt: new Date("2026-09-21T12:05:00.000Z"),
      body: "live",
      senderKind: "human",
      senderHandle: "ada",
    },
  ]);
  const failing: AdmissionSink = {
    async deliver() {
      throw new Error("causal down");
    },
  };
  const dispatcher = createAdmissionDispatcher({
    admission: harness.admission,
    sinks: { openviking: recordingSink().sink, causal_openviking: failing },
  });
  const sweep = createWorkspaceMemoryAdmissionSweep({
    profiles: harness.store,
    catalog: harness.catalog,
    admission: harness.admission,
    dispatcher,
    reconciler: harness.reconciler,
    lock: exclusiveLock(),
    now: () => sweepNow,
    quietAfterMs: 1,
  });
  await sweep.tick();
  expect(await harness.admission.getDispatch("ws-a", "quiet-ch-eng-m-live")).toMatchObject({
    state: "retryable_failure",
  });
});

test("public channel and direct conversation writers do not import the memory dispatcher", async () => {
  const channel = await Bun.file(
    new URL("../conversations/public-channels.server.ts", import.meta.url),
  ).text();
  const direct = await Bun.file(
    new URL("../conversations/direct-message.server.ts", import.meta.url),
  ).text();
  expect(channel).not.toMatch(/workspace-memory\/(dispatch|sweep|lifecycle)/);
  expect(direct).not.toMatch(/workspace-memory\/(dispatch|sweep|lifecycle)/);
});
