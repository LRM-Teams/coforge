import { expect, test } from "bun:test";
import type { CoforgeMemoryActor } from "../openviking/contract";
import { createOpenVikingPolicyGateway } from "../openviking/policy-gateway.server";
import { createInMemoryOpenVikingBindingStore } from "../openviking/stores";
import { detectAdmittedPublicChannelSegments } from "./detect-segments";
import {
  createAdmissionDispatcher,
  createInMemoryWorkspaceMemoryAdmissionStore,
  type AdmissionSink,
  type AdmissionSinkDelivery,
} from "./dispatch";
import { createWorkspaceMemoryProfiles } from "./profiles";
import {
  createFakeMemoryRuntimeProvisioner,
  createWorkspaceMemoryProfileReconciler,
} from "./reconciler";
import { createInMemoryWorkspaceMemoryProfileStore } from "./stores";
import { createWorkspaceMemorySwitching, observeWorkspaceMemoryAccess } from "./switching";

const now = new Date("2026-09-21T12:00:00.000Z");
const later = new Date("2026-09-21T13:00:00.000Z");
const afterSwitch = new Date("2026-09-21T14:00:00.000Z");
const enabled = { prototypeEnabled: true };
const OWNER: CoforgeMemoryActor = { kind: "owner", userId: "u-1" };
const FIND = {
  workspaceId: "ws-a",
  method: "POST",
  path: "/api/v1/search/find",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ query: "standup", limit: 10 }),
};

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

function liveDetected(workspaceId: string, closedAt: Date, messageId = "m-live") {
  return detectAdmittedPublicChannelSegments({
    conversations: [{ id: "ch-eng", workspaceId, channelName: "eng" }],
    messages: [
      {
        id: messageId,
        conversationId: "ch-eng",
        workspaceId,
        sequence: 1,
        createdAt: closedAt,
        body: "standup note",
        senderKind: "human",
        senderHandle: "ada",
      },
    ],
    tasks: [],
    admittedMessageIds: new Set(),
    now: new Date(closedAt.getTime() + 25 * 60 * 1000),
    quietAfterMs: 15 * 60 * 1000,
  })[0]!;
}

function harness() {
  const store = createInMemoryWorkspaceMemoryProfileStore();
  const bindings = createInMemoryOpenVikingBindingStore();
  const admission = createInMemoryWorkspaceMemoryAdmissionStore();
  const provisioner = createFakeMemoryRuntimeProvisioner();
  const profiles = createWorkspaceMemoryProfiles({ store, gate: enabled });
  const inner = createWorkspaceMemoryProfileReconciler({ store, provisioner });
  const reconciler = {
    async reconcile(workspaceId: string) {
      const result = await inner.reconcile(workspaceId);
      if (result.ok) {
        const snap = provisioner.snapshot(workspaceId);
        if (snap.openviking) {
          const current = await bindings.get(workspaceId);
          await bindings.compareAndSet({
            workspaceId,
            expectedGeneration: current?.generation ?? 0,
            binding: {
              workspaceId,
              accountId: snap.openviking.resourceId,
              serviceIdentityId: `svc-projection-${workspaceId}`,
              credentialRef: `secret:ov-${workspaceId}`,
              generation: snap.openviking.generation,
            },
          });
        }
      }
      return result;
    },
  };
  const openviking = recordingSink();
  const causal = recordingSink();
  const dispatcher = createAdmissionDispatcher({
    admission,
    sinks: { openviking: openviking.sink, causal_openviking: causal.sink },
  });
  const retrieved: string[] = [];
  const switching = createWorkspaceMemorySwitching({
    profiles,
    reconciler,
    dispatcher,
    getBinding: (workspaceId) => bindings.get(workspaceId),
    snapshotRuntimes: (workspaceId) => provisioner.snapshot(workspaceId),
    retrieveCausal: async ({ workspaceId, query }) => {
      retrieved.push(`${workspaceId}:${query}`);
      return { hits: [`tenant-${workspaceId}:${query}`] };
    },
  });
  const runtimeCalls: Array<{ method: string; path: string }> = [];
  const gateway = createOpenVikingPolicyGateway({
    profiles: store,
    bindings,
    runtime: {
      async request(input) {
        runtimeCalls.push({ method: input.method, path: input.path });
        return {
          ok: true as const,
          response: {
            status: 200,
            headers: { "content-type": "application/json" },
            body: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"results":[]}'));
                controller.close();
              },
            }),
          },
        };
      },
    },
    resolveAuthorization: async () => "Bearer server-held-ov-key",
  });
  return {
    store,
    bindings,
    admission,
    provisioner,
    profiles,
    switching,
    gateway,
    openviking,
    causal,
    retrieved,
    runtimeCalls,
  };
}

async function unwrap<T extends { ok: boolean }>(result: T): Promise<Extract<T, { ok: true }>> {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("expected ok result");
  return result as Extract<T, { ok: true }>;
}

test("observeWorkspaceMemoryAccess closes every surface while switching, erroring, or off", () => {
  const off = observeWorkspaceMemoryAccess({
    profile: {
      workspaceId: "ws-a",
      desired: "off",
      observed: "ready",
      generation: 0,
      activationCursor: null,
      reconcileKind: null,
      sanitizedFailure: null,
    },
    binding: { workspaceId: "ws-a", generation: 0 },
  });
  expect(off).toMatchObject({
    desired: "off",
    observed: "ready",
    surfaces: {
      admission: { open: false, reason: "profile_off" },
      openvikingGateway: { open: false, reason: "profile_off" },
      causalRetrieval: { open: false, reason: "profile_off" },
    },
  });

  const switching = observeWorkspaceMemoryAccess({
    profile: {
      workspaceId: "ws-a",
      desired: "causal_openviking",
      observed: "switching",
      generation: 2,
      activationCursor: { kind: "time", occurredAt: later.toISOString() },
      reconcileKind: "switch",
      sanitizedFailure: null,
    },
    binding: { workspaceId: "ws-a", generation: 1 },
  });
  expect(switching.observed).toBe("switching");
  expect(switching.surfaces.admission).toEqual({ open: false, reason: "not_ready" });
  expect(switching.surfaces.openvikingGateway).toEqual({ open: false, reason: "not_ready" });
  expect(switching.surfaces.causalRetrieval).toEqual({ open: false, reason: "not_ready" });

  const errored = observeWorkspaceMemoryAccess({
    profile: {
      workspaceId: "ws-a",
      desired: "causal_openviking",
      observed: "error",
      generation: 2,
      activationCursor: { kind: "time", occurredAt: later.toISOString() },
      reconcileKind: "switch",
      sanitizedFailure: {
        code: "provisioning_failed",
        message: "memory runtime provisioning failed",
      },
    },
    binding: { workspaceId: "ws-a", generation: 1 },
  });
  expect(errored.observed).toBe("error");
  expect(errored.sanitizedFailure).toEqual({
    code: "provisioning_failed",
    message: "memory runtime provisioning failed",
  });
  expect(errored.surfaces.admission.open).toBe(false);
  expect(errored.surfaces.openvikingGateway.open).toBe(false);
  expect(errored.surfaces.causalRetrieval.open).toBe(false);
});

test("degraded keeps admission and causal retrieval open but closes the ready gateway", () => {
  const degraded = observeWorkspaceMemoryAccess({
    profile: {
      workspaceId: "ws-a",
      desired: "causal_openviking",
      observed: "degraded",
      generation: 2,
      activationCursor: { kind: "time", occurredAt: later.toISOString() },
      reconcileKind: null,
      sanitizedFailure: null,
    },
    binding: { workspaceId: "ws-a", generation: 2 },
  });
  expect(degraded.surfaces.admission).toEqual({ open: true });
  expect(degraded.surfaces.causalRetrieval).toEqual({ open: true });
  expect(degraded.surfaces.openvikingGateway).toEqual({ open: false, reason: "not_ready" });
});

test("off→openviking→causal_openviking→openviking→off retains runtimes and never backfills", async () => {
  const ctx = harness();
  const historical = liveDetected("ws-a", new Date("2026-09-21T11:00:00.000Z"), "m-old");
  const ovLive = liveDetected("ws-a", new Date("2026-09-21T12:05:00.000Z"), "m-ov");
  const causalLive = liveDetected("ws-a", new Date("2026-09-21T13:05:00.000Z"), "m-cm");

  const selectedOv = await unwrap(
    await ctx.switching.selectDesired({ workspaceId: "ws-a", desired: "openviking", at: now }),
  );
  expect(selectedOv.observation.observed).toBe("provisioning");
  expect(selectedOv.observation.surfaces.admission.open).toBe(false);
  expect(await ctx.gateway.forward(OWNER, FIND)).toMatchObject({
    ok: false,
    failure: { code: "workspace_not_ready", observed: "provisioning", sanitizedFailure: null },
  });
  expect(ctx.runtimeCalls).toEqual([]);

  const readyOv = await unwrap(await ctx.switching.reconcile("ws-a"));
  expect(readyOv.observation).toMatchObject({
    desired: "openviking",
    observed: "ready",
    surfaces: {
      admission: { open: true },
      openvikingGateway: { open: true },
      causalRetrieval: { open: false, reason: "not_causal" },
    },
  });
  expect(readyOv.retained.openviking?.resourceId).toBe("acct-ws-a");
  expect(readyOv.retained.causalTenant).toBeNull();
  expect((await ctx.gateway.forward(OWNER, FIND)).ok).toBe(true);
  expect(await ctx.switching.retrieveCausal({ workspaceId: "ws-a", query: "old ov" })).toEqual({
    allowed: false,
    observation: readyOv.observation,
  });
  expect(ctx.retrieved).toEqual([]);
  expect(await ctx.switching.dispatch({ workspaceId: "ws-a", detected: historical })).toMatchObject(
    {
      outcome: { outcome: "skipped", reason: "before_activation_cursor" },
    },
  );
  expect(await ctx.switching.dispatch({ workspaceId: "ws-a", detected: ovLive })).toMatchObject({
    outcome: { outcome: "dispatched", sinkProfile: "openviking" },
  });
  expect(ctx.openviking.deliveries.map((row) => row.segment.sourceMessageIds)).toEqual([["m-ov"]]);

  const switchingToCausal = await unwrap(
    await ctx.switching.selectDesired({
      workspaceId: "ws-a",
      desired: "causal_openviking",
      at: later,
      afterMessageId: "msg-100",
    }),
  );
  expect(switchingToCausal.observation).toMatchObject({
    desired: "causal_openviking",
    observed: "switching",
    generation: 2,
    surfaces: {
      admission: { open: false, reason: "not_ready" },
      openvikingGateway: { open: false, reason: "not_ready" },
      causalRetrieval: { open: false, reason: "not_ready" },
    },
  });
  expect(await ctx.switching.dispatch({ workspaceId: "ws-a", detected: causalLive })).toMatchObject(
    {
      outcome: { outcome: "skipped", reason: "not_ready" },
    },
  );
  expect(await ctx.gateway.forward(OWNER, FIND)).toMatchObject({
    ok: false,
    failure: { code: "workspace_not_ready", observed: "switching", sanitizedFailure: null },
  });
  expect(
    await ctx.switching.retrieveCausal({ workspaceId: "ws-a", query: "during switch" }),
  ).toMatchObject({
    allowed: false,
  });
  expect(ctx.causal.deliveries).toEqual([]);

  const readyCausal = await unwrap(await ctx.switching.reconcile("ws-a"));
  expect(readyCausal.observation).toMatchObject({
    desired: "causal_openviking",
    observed: "ready",
    activationCursor: { kind: "message", occurredAt: later.toISOString(), messageId: "msg-100" },
    surfaces: {
      admission: { open: true },
      openvikingGateway: { open: true },
      causalRetrieval: { open: true },
    },
  });
  expect(readyCausal.retained).toMatchObject({
    openviking: { resourceId: "acct-ws-a" },
    causalTenant: { resourceId: "tenant-ws-a" },
  });
  expect(await ctx.switching.dispatch({ workspaceId: "ws-a", detected: ovLive })).toMatchObject({
    outcome: { outcome: "skipped", reason: "before_activation_cursor" },
  });
  expect(await ctx.switching.dispatch({ workspaceId: "ws-a", detected: historical })).toMatchObject(
    {
      outcome: { outcome: "skipped", reason: "before_activation_cursor" },
    },
  );
  expect(await ctx.switching.dispatch({ workspaceId: "ws-a", detected: causalLive })).toMatchObject(
    {
      outcome: { outcome: "dispatched", sinkProfile: "causal_openviking" },
    },
  );
  expect(ctx.openviking.deliveries).toHaveLength(1);
  expect(ctx.causal.deliveries.map((row) => row.segment.sourceMessageIds)).toEqual([["m-cm"]]);
  expect(await ctx.switching.retrieveCausal({ workspaceId: "ws-a", query: "new facts" })).toEqual({
    allowed: true,
    observation: readyCausal.observation,
    result: { hits: ["tenant-ws-a:new facts"] },
  });

  const switchingBack = await unwrap(
    await ctx.switching.selectDesired({
      workspaceId: "ws-a",
      desired: "openviking",
      at: afterSwitch,
    }),
  );
  expect(switchingBack.observation.observed).toBe("switching");
  expect(switchingBack.observation.surfaces.causalRetrieval.open).toBe(false);
  const back = await unwrap(await ctx.switching.reconcile("ws-a"));
  expect(back.observation.surfaces.causalRetrieval).toEqual({ open: false, reason: "not_causal" });
  expect(back.retained.causalTenant?.resourceId).toBe("tenant-ws-a");
  expect(back.retained.openviking?.resourceId).toBe("acct-ws-a");
  expect(
    await ctx.switching.retrieveCausal({ workspaceId: "ws-a", query: "after off causal" }),
  ).toMatchObject({
    allowed: false,
  });
  expect(ctx.retrieved).toEqual(["ws-a:new facts"]);
  expect(ctx.provisioner.deleted).toEqual([]);

  const offSelected = await unwrap(
    await ctx.switching.selectDesired({
      workspaceId: "ws-a",
      desired: "off",
      at: new Date("2026-09-21T15:00:00.000Z"),
    }),
  );
  expect(offSelected.observation.observed).toBe("switching");
  const off = await unwrap(await ctx.switching.reconcile("ws-a"));
  expect(off.observation).toMatchObject({
    desired: "off",
    observed: "ready",
    surfaces: {
      admission: { open: false, reason: "profile_off" },
      openvikingGateway: { open: false, reason: "profile_off" },
      causalRetrieval: { open: false, reason: "profile_off" },
    },
  });
  expect(off.retained).toMatchObject({
    openviking: { resourceId: "acct-ws-a" },
    causalTenant: { resourceId: "tenant-ws-a" },
  });
  expect(off.observation.activationCursor).toEqual({
    kind: "time",
    occurredAt: afterSwitch.toISOString(),
  });
  expect(ctx.provisioner.deleted).toEqual([]);
  expect(ctx.openviking.deliveries).toHaveLength(1);
  expect(ctx.causal.deliveries).toHaveLength(1);
});

test("a failed switch is visible as error, then retry completes without deleting the OV account", async () => {
  const ctx = harness();
  await unwrap(
    await ctx.switching.selectDesired({ workspaceId: "ws-a", desired: "openviking", at: now }),
  );
  await unwrap(await ctx.switching.reconcile("ws-a"));
  ctx.provisioner.failNext("causal_tenant", "Bearer ov-secret at /var/lib/openviking/account.db");
  await unwrap(
    await ctx.switching.selectDesired({
      workspaceId: "ws-a",
      desired: "causal_openviking",
      at: later,
    }),
  );

  const failed = await unwrap(await ctx.switching.reconcile("ws-a"));
  expect(failed.observation).toMatchObject({
    desired: "causal_openviking",
    observed: "error",
    generation: 2,
    sanitizedFailure: {
      code: "provisioning_failed",
      message: "memory runtime provisioning failed",
    },
    surfaces: {
      admission: { open: false, reason: "not_ready" },
      openvikingGateway: { open: false, reason: "not_ready" },
      causalRetrieval: { open: false, reason: "not_ready" },
    },
  });
  expect(JSON.stringify(failed.observation.sanitizedFailure)).not.toContain("Bearer");
  expect(JSON.stringify(failed.observation.sanitizedFailure)).not.toContain("ov-secret");
  expect(await ctx.gateway.forward(OWNER, FIND)).toMatchObject({
    ok: false,
    failure: {
      code: "workspace_not_ready",
      observed: "error",
      sanitizedFailure: {
        code: "provisioning_failed",
        message: "memory runtime provisioning failed",
      },
    },
  });
  expect(failed.retained.openviking?.resourceId).toBe("acct-ws-a");
  expect(ctx.provisioner.deleted).toEqual([]);

  const recovered = await unwrap(await ctx.switching.reconcile("ws-a"));
  expect(recovered.observation).toMatchObject({
    observed: "ready",
    generation: 2,
    sanitizedFailure: null,
    surfaces: { causalRetrieval: { open: true }, openvikingGateway: { open: true } },
  });
  expect(recovered.retained.causalTenant?.resourceId).toBe("tenant-ws-a");
});

test("a stale generation cannot take over the switching composition", async () => {
  const ctx = harness();
  await unwrap(
    await ctx.switching.selectDesired({ workspaceId: "ws-a", desired: "openviking", at: now }),
  );
  const held = ctx.provisioner.holdEnsure();
  const first = ctx.switching.reconcile("ws-a");
  await unwrap(
    await ctx.switching.selectDesired({
      workspaceId: "ws-a",
      desired: "causal_openviking",
      at: later,
    }),
  );
  held.release();

  expect(await first).toEqual({
    ok: false,
    failure: { code: "stale_generation", message: "profile generation is stale" },
  });
  expect(await ctx.store.get("ws-a")).toMatchObject({
    desired: "causal_openviking",
    observed: "switching",
    generation: 2,
  });
  const settled = await unwrap(await ctx.switching.reconcile("ws-a"));
  expect(settled.observation).toMatchObject({
    desired: "causal_openviking",
    observed: "ready",
    generation: 2,
  });
});

test("lifecycle composition wires the switching observer", async () => {
  const text = await Bun.file(new URL("./lifecycle.server.ts", import.meta.url)).text();
  expect(text).toMatch(/createWorkspaceMemorySwitching/);
  expect(text).toMatch(/new WorkspaceMemoryLifecycle\(/);
  expect(text).toMatch(/switching,/);
});
