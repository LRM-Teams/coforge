import { expect, test } from "bun:test";
import type {
  OpenVikingAdmittedSessionWrite,
  OpenVikingTypedSessionExtract,
} from "../openviking/typed-session-extract.server";
import { createInMemoryWorkspaceMemoryCatalog } from "./catalog";
import { detectAdmittedPublicChannelSegments, ingestOperationId } from "./detect-segments";
import {
  createAdmissionDispatcher,
  createInMemoryWorkspaceMemoryAdmissionStore,
  type AdmissionSink,
  type AdmissionSinkDelivery,
} from "./dispatch";
import { createOpenVikingAdmittedDeliverySink } from "./ov-sink.server";
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

async function readyHarness(
  desired: "openviking" = "openviking",
  options: { now?: () => Date } = {},
) {
  const store = createInMemoryWorkspaceMemoryProfileStore();
  const admission = createInMemoryWorkspaceMemoryAdmissionStore(
    options.now ? { now: options.now } : {},
  );
  const catalog = createInMemoryWorkspaceMemoryCatalog(admission);
  const profiles = createWorkspaceMemoryProfiles({ store, gate: enabled });
  const provisioner = createFakeMemoryRuntimeProvisioner();
  const reconciler = createWorkspaceMemoryProfileReconciler({ store, provisioner });
  const openviking = recordingSink();
  const dispatcher = createAdmissionDispatcher({
    admission,
    sinks: { openviking: openviking.sink },
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
  expect(harness.openviking.deliveries.map((row) => row.segment.sourceMessageIds)).toEqual([
    ["m-live"],
  ]);
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
    sinks: { openviking: openviking.sink },
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
  expect(harness.openviking.deliveries).toHaveLength(1);
  expect(await harness.admission.getDispatch("ws-a", "quiet-ch-eng-m-live")).toMatchObject({
    state: "delivered",
    sinkProfile: "openviking",
  });
});

test("a hung memory sink does not block Message persistence", async () => {
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
    sinks: { openviking: hung },
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
      throw new Error("sink down");
    },
  };
  const dispatcher = createAdmissionDispatcher({
    admission: harness.admission,
    sinks: { openviking: failing },
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

test("a pending dispatch older than ten minutes is redriven by the next sweep", async () => {
  let now = new Date("2026-09-21T12:30:00.000Z");
  const harness = await readyHarness("openviking", { now: () => now });
  const createdAt = new Date("2026-09-21T12:05:00.000Z");
  harness.catalog.seedConversation({ id: "ch-eng", workspaceId: "ws-a", channelName: "eng" });
  harness.catalog.seedMessages([
    {
      id: "m-stuck",
      conversationId: "ch-eng",
      workspaceId: "ws-a",
      sequence: 1,
      createdAt,
      body: "stuck pending",
      senderKind: "human",
      senderHandle: "ada",
    },
  ]);
  const detected = detectAdmittedPublicChannelSegments({
    conversations: [{ id: "ch-eng", workspaceId: "ws-a", channelName: "eng" }],
    messages: [
      {
        id: "m-stuck",
        conversationId: "ch-eng",
        workspaceId: "ws-a",
        sequence: 1,
        createdAt,
        body: "stuck pending",
        senderKind: "human",
        senderHandle: "ada",
      },
    ],
    tasks: [],
    admittedMessageIds: new Set(),
    now,
    quietAfterMs: 1,
  })[0]!;
  expect(
    await harness.admission.putSegment({
      segmentId: detected.segmentId,
      sourceMessageIds: detected.sourceMessageIds,
      workspace: detected.workspace,
      kind: detected.kind,
      conversationKind: detected.conversationKind,
      sourcePayloadHash: detected.sourcePayloadHash,
      profileGeneration: harness.profile.generation,
      closedAt: detected.closedAt,
    }),
  ).toMatchObject({ outcome: "saved" });
  expect(
    await harness.admission.consumeDispatch({
      workspaceId: "ws-a",
      segmentId: detected.segmentId,
      operationId: ingestOperationId(detected.segmentId),
      sinkProfile: "openviking",
      profileGeneration: harness.profile.generation,
    }),
  ).toMatchObject({ outcome: "accepted", dispatch: { state: "pending" } });

  const sweep = createWorkspaceMemoryAdmissionSweep({
    profiles: harness.store,
    catalog: harness.catalog,
    admission: harness.admission,
    dispatcher: harness.dispatcher,
    reconciler: harness.reconciler,
    lock: {
      async acquire() {
        return true;
      },
    },
    now: () => now,
    quietAfterMs: 1,
    pendingRedrainAfterMs: 10 * 60 * 1000,
  });
  await sweep.tick();
  expect(harness.openviking.deliveries).toEqual([]);
  expect(await harness.admission.getDispatch("ws-a", detected.segmentId)).toMatchObject({
    state: "pending",
  });

  now = new Date(now.getTime() + 10 * 60 * 1000 + 1);
  await sweep.tick();
  expect(harness.openviking.deliveries.map((row) => row.segment.segmentId)).toEqual([
    detected.segmentId,
  ]);
  expect(await harness.admission.getDispatch("ws-a", detected.segmentId)).toMatchObject({
    state: "delivered",
    sinkProfile: "openviking",
  });
});

test("an offer message is written without its citation text and the human message stays verbatim", async () => {
  const harness = await readyHarness();
  const citation = "the last skip-tests deploy rolled back";
  harness.catalog.seedConversation({ id: "ch-eng", workspaceId: "ws-a", channelName: "eng" });
  harness.catalog.seedMessages([
    {
      id: "m-human",
      conversationId: "ch-eng",
      workspaceId: "ws-a",
      sequence: 1,
      createdAt: new Date("2026-09-21T12:05:00.000Z"),
      body: "we skipped tests on the rollout",
      senderKind: "human",
      senderHandle: "ada",
    },
    {
      id: "m-offer",
      conversationId: "ch-eng",
      workspaceId: "ws-a",
      sequence: 2,
      createdAt: new Date("2026-09-21T12:06:00.000Z"),
      body: `Deploy rolled back after skipped tests.\n\nviking://resources/docs/deploy.md\n${citation}`,
      senderKind: "agent",
      senderHandle: "memory",
    },
  ]);
  harness.catalog.seedOfferMessageIds("ws-a", ["m-offer"]);
  const writes: OpenVikingAdmittedSessionWrite[] = [];
  const sessions: OpenVikingTypedSessionExtract = {
    async writeCommitAndExtract(input) {
      writes.push(input.write);
      return { ok: true, sessionId: input.write.sessionId };
    },
  };
  const dispatcher = createAdmissionDispatcher({
    admission: harness.admission,
    sinks: {
      openviking: createOpenVikingAdmittedDeliverySink({
        sessions,
        owner: "sink-owner",
      }),
    },
  });
  const sweep = createWorkspaceMemoryAdmissionSweep({
    profiles: harness.store,
    catalog: harness.catalog,
    admission: harness.admission,
    dispatcher,
    reconciler: harness.reconciler,
    lock: {
      async acquire() {
        return true;
      },
    },
    now: () => sweepNow,
    quietAfterMs: 1,
  });
  await sweep.tick();
  expect(writes).toHaveLength(1);
  expect(writes[0]?.messages).toEqual([
    {
      role: "user",
      content: "we skipped tests on the rollout",
      createdAt: "2026-09-21T12:05:00.000Z",
      sourceMessageIds: ["m-human"],
    },
    {
      role: "assistant",
      content: "Deploy rolled back after skipped tests.",
      createdAt: "2026-09-21T12:06:00.000Z",
      sourceMessageIds: ["m-offer"],
      peerId: "coforge__memory",
      derived: true,
    },
  ]);
  expect(JSON.stringify(writes[0]?.messages)).not.toContain(citation);
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
