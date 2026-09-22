import { expect, test } from "bun:test";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/client";
import { PrismaOpenVikingBindingStore } from "../src/server/db/repositories/openviking-binding.repositories.server";
import { PrismaWorkspaceMemoryAdmissionStore } from "../src/server/db/repositories/workspace-memory-admission.repositories.server";
import { PrismaWorkspaceMemoryProfileStore } from "../src/server/db/repositories/workspace-memory-profile.repositories.server";
import type { CoforgeMemoryActor } from "../src/server/openviking/contract";
import { createOpenVikingPolicyGateway } from "../src/server/openviking/policy-gateway.server";
import { detectAdmittedPublicChannelSegments } from "../src/server/workspace-memory/detect-segments";
import {
  createAdmissionDispatcher,
  type AdmissionSink,
  type AdmissionSinkDelivery,
} from "../src/server/workspace-memory/dispatch";
import { createWorkspaceMemoryProfiles } from "../src/server/workspace-memory/profiles";
import {
  createFakeMemoryRuntimeProvisioner,
  createWorkspaceMemoryProfileReconciler,
} from "../src/server/workspace-memory/reconciler";
import { createWorkspaceMemorySwitching } from "../src/server/workspace-memory/switching";
import {
  WORKSPACE_MEMORY_PG_URL,
  applyWorkspaceMemoryPgStub,
  warnIfWorkspaceMemoryPgSkipped,
} from "./helpers/workspace-memory-pg";

const connectionString = WORKSPACE_MEMORY_PG_URL;
warnIfWorkspaceMemoryPgSkipped("workspace-memory switching");

const now = new Date("2026-09-21T12:00:00.000Z");
const later = new Date("2026-09-21T13:00:00.000Z");
const enabled = { prototypeEnabled: true };
const OWNER: CoforgeMemoryActor = { kind: "owner", userId: "u-1" };
const FIND = {
  method: "POST",
  path: "/api/v1/search/find",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ query: "standup", limit: 10 }),
};

type Harness = {
  db: PrismaClient;
  workspaceA: string;
  profiles: PrismaWorkspaceMemoryProfileStore;
  bindings: PrismaOpenVikingBindingStore;
  admission: PrismaWorkspaceMemoryAdmissionStore;
};

async function openHarness(): Promise<Harness & { dispose: () => Promise<void> }> {
  const pool = new Pool({ connectionString });
  const schema = `wmp_sw_${crypto.randomUUID().replaceAll("-", "")}`;
  const client = await pool.connect();
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`SET search_path TO "${schema}"`);
  const workspaceA = crypto.randomUUID();
  await applyWorkspaceMemoryPgStub(client, { workspaceIds: [workspaceA] });
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }, { schema }) });
  return {
    db,
    workspaceA,
    profiles: new PrismaWorkspaceMemoryProfileStore(db),
    bindings: new PrismaOpenVikingBindingStore(db),
    admission: new PrismaWorkspaceMemoryAdmissionStore(db),
    async dispose() {
      await db.$disconnect();
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      client.release();
      await pool.end();
    },
  };
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

function liveDetected(workspaceId: string, closedAt: Date, messageId: string) {
  return detectAdmittedPublicChannelSegments({
    conversations: [{ id: "ch-eng", workspaceId, channelName: "eng" }],
    messages: [
      {
        id: messageId,
        conversationId: "ch-eng",
        workspaceId,
        sequence: 1,
        createdAt: closedAt,
        body: "standup",
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

async function unwrap<T extends { ok: boolean }>(result: T): Promise<Extract<T, { ok: true }>> {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("expected ok result");
  return result as Extract<T, { ok: true }>;
}

test.skipIf(!connectionString)(
  "Prisma switching retains the OV binding and CM tenant receipt, fences dispatcher/gateway, and never backfills",
  async () => {
    const harness = await openHarness();
    try {
      const provisioner = createFakeMemoryRuntimeProvisioner();
      const profileApi = createWorkspaceMemoryProfiles({
        store: harness.profiles,
        gate: enabled,
      });
      const inner = createWorkspaceMemoryProfileReconciler({
        store: harness.profiles,
        provisioner,
      });
      const reconciler = {
        async reconcile(workspaceId: string) {
          const result = await inner.reconcile(workspaceId);
          if (result.ok) {
            const snap = provisioner.snapshot(workspaceId);
            if (snap.openviking) {
              const current = await harness.bindings.get(workspaceId);
              await harness.bindings.compareAndSet({
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
      const retrieved: string[] = [];
      const switching = createWorkspaceMemorySwitching({
        profiles: profileApi,
        reconciler,
        dispatcher: createAdmissionDispatcher({
          admission: harness.admission,
          sinks: { openviking: openviking.sink, causal_openviking: causal.sink },
        }),
        getBinding: (workspaceId) => harness.bindings.get(workspaceId),
        snapshotRuntimes: (workspaceId) => provisioner.snapshot(workspaceId),
        retrieveCausal: async ({ workspaceId, query }) => {
          retrieved.push(`${workspaceId}:${query}`);
          return { hits: [query] };
        },
      });
      const runtimeCalls: string[] = [];
      const gateway = createOpenVikingPolicyGateway({
        profiles: harness.profiles,
        bindings: harness.bindings,
        runtime: {
          async request(input) {
            runtimeCalls.push(`${input.method} ${input.path}`);
            return {
              ok: true as const,
              response: {
                status: 200,
                headers: { "content-type": "application/json" },
                body: new ReadableStream<Uint8Array>({
                  start(controller) {
                    controller.enqueue(new TextEncoder().encode("{}"));
                    controller.close();
                  },
                }),
              },
            };
          },
        },
        resolveAuthorization: async () => "Bearer server-held-ov-key",
      });

      const ovLive = liveDetected(harness.workspaceA, new Date("2026-09-21T12:05:00.000Z"), "m-ov");
      const historical = liveDetected(
        harness.workspaceA,
        new Date("2026-09-21T11:00:00.000Z"),
        "m-old",
      );
      const causalLive = liveDetected(
        harness.workspaceA,
        new Date("2026-09-21T13:05:00.000Z"),
        "m-cm",
      );

      await unwrap(
        await switching.selectDesired({
          workspaceId: harness.workspaceA,
          desired: "openviking",
          at: now,
        }),
      );
      const readyOv = await unwrap(await switching.reconcile(harness.workspaceA));
      expect(readyOv.observation.surfaces.openvikingGateway.open).toBe(true);
      expect(readyOv.retained.openviking?.resourceId).toBe(`acct-${harness.workspaceA}`);
      expect(
        await switching.dispatch({ workspaceId: harness.workspaceA, detected: ovLive }),
      ).toMatchObject({ outcome: { outcome: "dispatched", sinkProfile: "openviking" } });

      const switchingToCausal = await unwrap(
        await switching.selectDesired({
          workspaceId: harness.workspaceA,
          desired: "causal_openviking",
          at: later,
          afterMessageId: "msg-100",
        }),
      );
      expect(switchingToCausal.observation.observed).toBe("switching");
      expect(
        await switching.dispatch({ workspaceId: harness.workspaceA, detected: causalLive }),
      ).toMatchObject({ outcome: { outcome: "skipped", reason: "not_ready" } });
      expect(
        await gateway.forward(OWNER, { ...FIND, workspaceId: harness.workspaceA }),
      ).toMatchObject({
        ok: false,
        failure: { code: "workspace_not_ready", observed: "switching" },
      });
      expect(runtimeCalls).toEqual([]);

      const readyCausal = await unwrap(await switching.reconcile(harness.workspaceA));
      expect(readyCausal.retained).toMatchObject({
        openviking: { resourceId: `acct-${harness.workspaceA}` },
        causalTenant: { resourceId: `tenant-${harness.workspaceA}` },
      });
      expect(await harness.bindings.get(harness.workspaceA)).toMatchObject({
        accountId: `acct-${harness.workspaceA}`,
        generation: 2,
      });
      expect(
        await switching.dispatch({ workspaceId: harness.workspaceA, detected: historical }),
      ).toMatchObject({ outcome: { outcome: "skipped", reason: "before_activation_cursor" } });
      expect(
        await switching.dispatch({ workspaceId: harness.workspaceA, detected: ovLive }),
      ).toMatchObject({ outcome: { outcome: "skipped", reason: "before_activation_cursor" } });
      expect(
        await switching.dispatch({ workspaceId: harness.workspaceA, detected: causalLive }),
      ).toMatchObject({
        outcome: { outcome: "dispatched", sinkProfile: "causal_openviking" },
      });
      expect(openviking.deliveries).toHaveLength(1);
      expect(causal.deliveries.map((row) => row.segment.sourceMessageIds)).toEqual([["m-cm"]]);
      expect(
        await switching.retrieveCausal({ workspaceId: harness.workspaceA, query: "facts" }),
      ).toMatchObject({ allowed: true });

      await unwrap(
        await switching.selectDesired({
          workspaceId: harness.workspaceA,
          desired: "openviking",
          at: new Date("2026-09-21T14:00:00.000Z"),
        }),
      );
      const back = await unwrap(await switching.reconcile(harness.workspaceA));
      expect(back.retained.causalTenant?.resourceId).toBe(`tenant-${harness.workspaceA}`);
      expect(provisioner.deleted).toEqual([]);
      expect(
        await switching.retrieveCausal({ workspaceId: harness.workspaceA, query: "after" }),
      ).toMatchObject({ allowed: false });
      expect(retrieved).toEqual([`${harness.workspaceA}:facts`]);
      expect(await harness.profiles.get(harness.workspaceA)).toMatchObject({
        desired: "openviking",
        observed: "ready",
        generation: 3,
      });
    } finally {
      await harness.dispose();
    }
  },
);

test.skipIf(!connectionString)(
  "Prisma CAS rejects a stale reconcile and a later retry finishes the switch",
  async () => {
    const harness = await openHarness();
    try {
      const provisioner = createFakeMemoryRuntimeProvisioner();
      const profileApi = createWorkspaceMemoryProfiles({
        store: harness.profiles,
        gate: enabled,
      });
      const inner = createWorkspaceMemoryProfileReconciler({
        store: harness.profiles,
        provisioner,
      });
      const switching = createWorkspaceMemorySwitching({
        profiles: profileApi,
        reconciler: inner,
        dispatcher: createAdmissionDispatcher({
          admission: harness.admission,
          sinks: {
            openviking: recordingSink().sink,
            causal_openviking: recordingSink().sink,
          },
        }),
        getBinding: (workspaceId) => harness.bindings.get(workspaceId),
        snapshotRuntimes: (workspaceId) => provisioner.snapshot(workspaceId),
      });

      await unwrap(
        await switching.selectDesired({
          workspaceId: harness.workspaceA,
          desired: "openviking",
          at: now,
        }),
      );
      const held = provisioner.holdEnsure();
      const first = switching.reconcile(harness.workspaceA);
      await unwrap(
        await switching.selectDesired({
          workspaceId: harness.workspaceA,
          desired: "causal_openviking",
          at: later,
        }),
      );
      held.release();
      expect(await first).toEqual({
        ok: false,
        failure: { code: "stale_generation", message: "profile generation is stale" },
      });
      expect(await harness.profiles.get(harness.workspaceA)).toMatchObject({
        desired: "causal_openviking",
        observed: "switching",
        generation: 2,
      });

      provisioner.failNext("causal_tenant", "token=super-secret");
      const failed = await unwrap(await switching.reconcile(harness.workspaceA));
      expect(failed.observation).toMatchObject({
        observed: "error",
        generation: 2,
        sanitizedFailure: {
          code: "provisioning_failed",
          message: "memory runtime provisioning failed",
        },
      });
      expect(JSON.stringify(failed.observation.sanitizedFailure)).not.toContain("super-secret");
      expect(provisioner.snapshot(harness.workspaceA).openviking?.resourceId).toBe(
        `acct-${harness.workspaceA}`,
      );
      expect(provisioner.deleted).toEqual([]);

      const recovered = await unwrap(await switching.reconcile(harness.workspaceA));
      expect(recovered.observation).toMatchObject({
        desired: "causal_openviking",
        observed: "ready",
        generation: 2,
        sanitizedFailure: null,
      });
      expect(recovered.retained.causalTenant?.resourceId).toBe(`tenant-${harness.workspaceA}`);
    } finally {
      await harness.dispose();
    }
  },
);
