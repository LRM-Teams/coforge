import { expect, test } from "bun:test";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/client";
import { PrismaOpenVikingBindingStore } from "../src/server/db/repositories/openviking-binding.repositories.server";
import { PrismaWorkspaceMemoryAdmissionStore } from "../src/server/db/repositories/workspace-memory-admission.repositories.server";
import { PrismaWorkspaceMemoryIdentityDirectory } from "../src/server/db/repositories/workspace-memory-identity.repositories.server";
import { PrismaWorkspaceMemoryProfileStore } from "../src/server/db/repositories/workspace-memory-profile.repositories.server";
import { createFakeOpenVikingProvisioner } from "../src/server/openviking/stores";
import { detectAdmittedPublicChannelSegments } from "../src/server/workspace-memory/detect-segments";
import {
  createAdmissionDispatcher,
  createOpenVikingNativeSessionSink,
  type AdmissionSinkDelivery,
} from "../src/server/workspace-memory/dispatch";
import {
  applyWorkspaceMemoryCommand,
  createDefaultWorkspaceMemoryProfile,
} from "../src/server/workspace-memory/profile";
import { createWorkspaceMemoryProfiles } from "../src/server/workspace-memory/profiles";
import { createWorkspaceMemoryProfileReconciler } from "../src/server/workspace-memory/reconciler";
import {
  createProductionMemoryRuntimeProvisioner,
  createPrototypeMemoryRuntimeReadiness,
} from "../src/server/workspace-memory/runtime-provisioner";
import { createFakeCausalMemoryProvisioner } from "../src/server/workspace-memory/stores";
import {
  WORKSPACE_MEMORY_PG_URL,
  applyWorkspaceMemoryPgStub,
  warnIfWorkspaceMemoryPgSkipped,
} from "./helpers/workspace-memory-pg";

const connectionString = WORKSPACE_MEMORY_PG_URL;
warnIfWorkspaceMemoryPgSkipped("workspace-memory admission");

const now = new Date("2026-09-21T12:00:00.000Z");
const enabled = { prototypeEnabled: true };

type Harness = {
  db: PrismaClient;
  workspaceA: string;
  profiles: PrismaWorkspaceMemoryProfileStore;
  bindings: PrismaOpenVikingBindingStore;
  admission: PrismaWorkspaceMemoryAdmissionStore;
  identities: PrismaWorkspaceMemoryIdentityDirectory;
};

async function openHarness(): Promise<Harness & { dispose: () => Promise<void> }> {
  const pool = new Pool({ connectionString });
  const schema = `wmp_adm_${crypto.randomUUID().replaceAll("-", "")}`;
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
    identities: new PrismaWorkspaceMemoryIdentityDirectory(db),
    async dispose() {
      await db.$disconnect();
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      client.release();
      await pool.end();
    },
  };
}

function liveDetected(workspaceId: string, closedAt: Date) {
  return detectAdmittedPublicChannelSegments({
    conversations: [{ id: "ch-eng", workspaceId, channelName: "eng" }],
    messages: [
      {
        id: "m-live",
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
    now: new Date("2026-09-21T12:30:00.000Z"),
    quietAfterMs: 15 * 60 * 1000,
  })[0]!;
}

test.skipIf(!connectionString)(
  "production reconciler persists OV binding and mapped identities before observed ready",
  async () => {
    const harness = await openHarness();
    try {
      const provisioner = createProductionMemoryRuntimeProvisioner({
        openviking: createFakeOpenVikingProvisioner(),
        bindings: harness.bindings,
        causal: createFakeCausalMemoryProvisioner(),
        identities: {
          async listActors() {
            return [{ kind: "owner", userId: crypto.randomUUID() }];
          },
        },
        mappedIdentities: harness.identities,
        readiness: createPrototypeMemoryRuntimeReadiness(),
      });
      const profiles = createWorkspaceMemoryProfiles({
        store: harness.profiles,
        gate: enabled,
      });
      const reconciler = createWorkspaceMemoryProfileReconciler({
        store: harness.profiles,
        provisioner,
      });
      const selected = await profiles.selectDesired({
        workspaceId: harness.workspaceA,
        desired: "openviking",
        at: now,
      });
      expect(selected.ok).toBe(true);
      const ready = await reconciler.reconcile(harness.workspaceA);
      expect(ready.ok).toBe(true);
      if (!ready.ok) throw new Error(ready.failure.code);
      expect(ready.profile.observed).toBe("ready");
      expect(await harness.bindings.get(harness.workspaceA)).toMatchObject({
        workspaceId: harness.workspaceA,
        credentialRef: `secret:ov-${harness.workspaceA}`,
        generation: 1,
      });
      const mapped = await harness.db.openVikingMappedIdentity.findMany({
        where: { workspaceId: harness.workspaceA },
      });
      expect(mapped.map((row) => row.actorKind).sort()).toEqual(["owner", "projection_worker"]);
    } finally {
      await harness.dispose();
    }
  },
);

test.skipIf(!connectionString)(
  "Prisma dispatch ledger admits a live segment once and refuses historical backfill",
  async () => {
    const harness = await openHarness();
    try {
      const seed = createDefaultWorkspaceMemoryProfile(harness.workspaceA);
      const selected = applyWorkspaceMemoryCommand(
        seed,
        {
          type: "select_desired",
          desired: "openviking",
          at: now,
          afterMessageId: "msg-boundary",
        },
        enabled,
      );
      if (!selected.ok) throw new Error(selected.failure.code);
      const ready = applyWorkspaceMemoryCommand(selected.profile, {
        type: "observe_ready",
        generation: 1,
      });
      if (!ready.ok) throw new Error(ready.failure.code);
      expect(
        await harness.profiles.compareAndSet({
          workspaceId: harness.workspaceA,
          expectedGeneration: 0,
          profile: ready.profile,
        }),
      ).toBe("saved");

      const deliveries: AdmissionSinkDelivery[] = [];
      const dispatcher = createAdmissionDispatcher({
        admission: harness.admission,
        sinks: {
          openviking: {
            async deliver(input) {
              deliveries.push(input);
              return { outcome: "delivered" };
            },
          },
          causal_openviking: createOpenVikingNativeSessionSink(),
        },
      });
      const historical = liveDetected(harness.workspaceA, new Date("2026-09-21T11:00:00.000Z"));
      const live = liveDetected(harness.workspaceA, new Date("2026-09-21T12:05:00.000Z"));
      const profile = await harness.profiles.get(harness.workspaceA);
      if (!profile) throw new Error("missing profile");
      expect(await dispatcher.dispatch({ profile, detected: historical })).toEqual({
        outcome: "skipped",
        reason: "before_activation_cursor",
      });
      expect(await dispatcher.dispatch({ profile, detected: live })).toMatchObject({
        outcome: "dispatched",
        sinkProfile: "openviking",
      });
      expect(await dispatcher.dispatch({ profile, detected: live })).toEqual({
        outcome: "replayed",
        sinkProfile: "openviking",
      });
      expect(deliveries).toHaveLength(1);
      expect(await harness.admission.getDispatch(harness.workspaceA, live.segmentId)).toMatchObject(
        {
          state: "delivered",
          sinkProfile: "openviking",
          attemptCount: 0,
        },
      );
    } finally {
      await harness.dispose();
    }
  },
);
