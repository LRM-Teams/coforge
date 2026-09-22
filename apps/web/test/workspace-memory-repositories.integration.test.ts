import { expect, test } from "bun:test";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/client";
import {
  applyWorkspaceMemoryCommand,
  createDefaultWorkspaceMemoryProfile,
  type WorkspaceMemoryProfile,
} from "../src/server/workspace-memory/profile";
import {
  createInMemoryWorkspaceMemoryProfileStore,
  saveProfileTransition,
} from "../src/server/workspace-memory/stores";
import {
  createFakeOpenVikingProvisioner,
  createInMemoryOpenVikingBindingStore,
} from "../src/server/openviking/stores";
import { PrismaWorkspaceMemoryProfileStore } from "../src/server/db/repositories/workspace-memory-profile.repositories.server";
import { PrismaOpenVikingBindingStore } from "../src/server/db/repositories/openviking-binding.repositories.server";
import { PrismaWorkspaceMemoryAdmissionStore } from "../src/server/db/repositories/workspace-memory-admission.repositories.server";
import { PrismaWorkspaceMemoryCitationStore } from "../src/server/db/repositories/workspace-memory-citation.repositories.server";
import { PrismaWorkspaceMemoryCleanupStore } from "../src/server/db/repositories/workspace-memory-cleanup.repositories.server";
import {
  WorkspaceMemoryBindingError,
  WorkspaceMemoryCitationKindError,
  WorkspaceMemoryReplayConflictError,
  WorkspaceMemoryScopeError,
} from "../src/server/db/repositories/workspace-memory-errors.server";
import type { AdmittedPublicChannelSegment } from "../src/server/workspace-memory/admission";

const connectionString =
  Bun.env.MIGRATION_TEST_DATABASE_URL ?? Bun.env.CHANNEL_TEST_DATABASE_URL ?? Bun.env.DATABASE_URL;
const migration = await Bun.file(
  new URL(
    "../prisma/migrations/20260921120000_workspace_memory_profiles/migration.sql",
    import.meta.url,
  ),
).text();

if (!connectionString) {
  console.warn(
    "workspace-memory repository PostgreSQL tests not run: set MIGRATION_TEST_DATABASE_URL, CHANNEL_TEST_DATABASE_URL, or DATABASE_URL",
  );
}

const now = new Date("2026-09-21T12:00:00.000Z");
const later = new Date("2026-09-21T13:00:00.000Z");
const enabled = { prototypeEnabled: true };

function unwrap(result: ReturnType<typeof applyWorkspaceMemoryCommand>): WorkspaceMemoryProfile {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.failure.code);
  return result.profile;
}

function segment(
  workspaceId: string,
  overrides: Partial<AdmittedPublicChannelSegment> & {
    channelId?: string;
    sourceMessageIds?: readonly string[];
  } = {},
): AdmittedPublicChannelSegment {
  const { channelId, sourceMessageIds, ...rest } = overrides;
  return {
    segmentId: "seg-1",
    sourceMessageIds: sourceMessageIds ?? ["m-1", "m-2"],
    workspace: { workspaceId, channelId: channelId ?? "ch-eng" },
    kind: "quiet_window",
    conversationKind: "public_channel",
    sourcePayloadHash: "sha256:abc",
    profileGeneration: 1,
    closedAt: "2026-09-21T12:05:00.000Z",
    ...rest,
  };
}

type Harness = {
  db: PrismaClient;
  client: import("pg").PoolClient;
  workspaceA: string;
  workspaceB: string;
  profiles: PrismaWorkspaceMemoryProfileStore;
  bindings: PrismaOpenVikingBindingStore;
  admission: PrismaWorkspaceMemoryAdmissionStore;
  citations: PrismaWorkspaceMemoryCitationStore;
  cleanup: PrismaWorkspaceMemoryCleanupStore;
};

async function openHarness(): Promise<Harness & { dispose: () => Promise<void> }> {
  const pool = new Pool({ connectionString });
  const schema = `wmp_repo_${crypto.randomUUID().replaceAll("-", "")}`;
  const client = await pool.connect();
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`SET search_path TO "${schema}"`);
  await client.query(`
    CREATE TABLE "workspaces" ("id" UUID PRIMARY KEY);
    CREATE TABLE "causal_citation_records" (
      "id" UUID PRIMARY KEY,
      "workspace_id" UUID NOT NULL,
      "citation_id" TEXT NOT NULL
    );
    CREATE UNIQUE INDEX "causal_citation_records_workspace_id_citation_id_key"
      ON "causal_citation_records"("workspace_id", "citation_id");
  `);
  await client.query(migration);
  const workspaceA = crypto.randomUUID();
  const workspaceB = crypto.randomUUID();
  await client.query(`INSERT INTO "workspaces" VALUES ($1), ($2)`, [workspaceA, workspaceB]);
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }, { schema }) });
  return {
    db,
    client,
    workspaceA,
    workspaceB,
    profiles: new PrismaWorkspaceMemoryProfileStore(db),
    bindings: new PrismaOpenVikingBindingStore(db),
    admission: new PrismaWorkspaceMemoryAdmissionStore(db),
    citations: new PrismaWorkspaceMemoryCitationStore(db),
    cleanup: new PrismaWorkspaceMemoryCleanupStore(db),
    async dispose() {
      await db.$disconnect();
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      client.release();
      await pool.end();
    },
  };
}

test.skipIf(!connectionString)(
  "profile store matches in-memory CAS, persists activation cursor, and rejects stale or foreign writes",
  async () => {
    const harness = await openHarness();
    try {
      const seedA = createDefaultWorkspaceMemoryProfile(harness.workspaceA);
      const selected = unwrap(
        applyWorkspaceMemoryCommand(
          seedA,
          { type: "select_desired", desired: "openviking", at: now },
          enabled,
        ),
      );
      const memory = createInMemoryWorkspaceMemoryProfileStore();
      expect(await saveProfileTransition(memory, seedA, selected)).toBe("saved");
      expect(await saveProfileTransition(harness.profiles, seedA, selected)).toBe("saved");

      const stored = await harness.profiles.get(harness.workspaceA);
      expect(stored).toMatchObject({
        workspaceId: harness.workspaceA,
        desired: "openviking",
        observed: "provisioning",
        generation: 1,
        reconcileKind: "provision",
        activationCursor: { kind: "time", occurredAt: now.toISOString() },
      });
      expect(await memory.get(harness.workspaceA)).toMatchObject({
        desired: "openviking",
        generation: 1,
      });

      const ready = unwrap(
        applyWorkspaceMemoryCommand(selected, { type: "observe_ready", generation: 1 }),
      );
      const switched = unwrap(
        applyWorkspaceMemoryCommand(
          ready,
          {
            type: "select_desired",
            desired: "causal_openviking",
            at: later,
            afterMessageId: "msg-activate",
          },
          enabled,
        ),
      );
      expect(await saveProfileTransition(harness.profiles, selected, switched)).toBe("saved");
      expect(await harness.profiles.get(harness.workspaceA)).toMatchObject({
        desired: "causal_openviking",
        observed: "switching",
        generation: 2,
        activationCursor: {
          kind: "message",
          occurredAt: later.toISOString(),
          messageId: "msg-activate",
        },
      });

      expect(
        await saveProfileTransition(harness.profiles, selected, { ...selected, observed: "ready" }),
      ).toBe("stale_generation");
      expect(await harness.profiles.get(harness.workspaceA)).toMatchObject({
        desired: "causal_openviking",
        generation: 2,
      });
      expect(await harness.profiles.get(harness.workspaceB)).toBeNull();
      expect(
        harness.profiles.compareAndSet({
          workspaceId: harness.workspaceB,
          expectedGeneration: 0,
          profile: switched,
        }),
      ).rejects.toBeInstanceOf(WorkspaceMemoryScopeError);
    } finally {
      await harness.dispose();
    }
  },
);

test.skipIf(!connectionString)(
  "OpenViking binding store fences generations, stores only credential_ref, and rejects cross-workspace writes",
  async () => {
    const harness = await openHarness();
    try {
      const provisioner = createFakeOpenVikingProvisioner();
      const memory = createInMemoryOpenVikingBindingStore();
      const binding = await provisioner.provisionBinding({
        workspaceId: harness.workspaceA,
        generation: 1,
      });
      expect(binding.credentialRef.startsWith("secret:")).toBe(true);
      expect(JSON.stringify(binding)).not.toContain("plaintext");

      expect(
        await memory.compareAndSet({
          workspaceId: harness.workspaceA,
          expectedGeneration: 0,
          binding,
        }),
      ).toBe("saved");
      expect(
        await harness.bindings.compareAndSet({
          workspaceId: harness.workspaceA,
          expectedGeneration: 0,
          binding,
        }),
      ).toBe("saved");
      expect(await harness.bindings.get(harness.workspaceA)).toEqual(binding);

      const newer = await provisioner.provisionBinding({
        workspaceId: harness.workspaceA,
        generation: 2,
      });
      expect(
        await harness.bindings.compareAndSet({
          workspaceId: harness.workspaceA,
          expectedGeneration: 1,
          binding: newer,
        }),
      ).toBe("saved");
      expect(
        await harness.bindings.compareAndSet({
          workspaceId: harness.workspaceA,
          expectedGeneration: 1,
          binding,
        }),
      ).toBe("stale_generation");
      expect(await harness.bindings.get(harness.workspaceA)).toMatchObject({ generation: 2 });
      expect(await harness.bindings.get(harness.workspaceB)).toBeNull();

      expect(
        harness.bindings.compareAndSet({
          workspaceId: harness.workspaceB,
          expectedGeneration: 0,
          binding: { ...newer, workspaceId: harness.workspaceA },
        }),
      ).rejects.toBeInstanceOf(WorkspaceMemoryScopeError);
      expect(
        harness.bindings.compareAndSet({
          workspaceId: harness.workspaceA,
          expectedGeneration: 2,
          binding: { ...newer, credentialRef: "not-a-secret", generation: 3 },
        }),
      ).rejects.toBeInstanceOf(WorkspaceMemoryBindingError);

      const foreign = {
        workspaceId: harness.workspaceB,
        accountId: newer.accountId,
        serviceIdentityId: "svc-b",
        credentialRef: "secret:ov-b",
        generation: 1,
      };
      expect(
        harness.bindings.compareAndSet({
          workspaceId: harness.workspaceB,
          expectedGeneration: 0,
          binding: foreign,
        }),
      ).rejects.toBeInstanceOf(WorkspaceMemoryScopeError);
    } finally {
      await harness.dispose();
    }
  },
);

test.skipIf(!connectionString)(
  "admission store writes immutable lineage and consumes dispatch uniquely with replay",
  async () => {
    const harness = await openHarness();
    try {
      const admitted = segment(harness.workspaceA);
      const saved = await harness.admission.putSegment(admitted);
      expect(saved.outcome).toBe("saved");
      expect(saved.segment.sourceMessageIds).toEqual(["m-1", "m-2"]);
      expect(await harness.admission.getSegment(harness.workspaceA, "seg-1")).toEqual(
        saved.segment,
      );
      expect(await harness.admission.getSegment(harness.workspaceB, "seg-1")).toBeNull();

      const replay = await harness.admission.putSegment(admitted);
      expect(replay).toEqual({ outcome: "replay", segment: saved.segment });
      expect(
        harness.admission.putSegment(
          segment(harness.workspaceA, { sourcePayloadHash: "sha256:other" }),
        ),
      ).rejects.toBeInstanceOf(WorkspaceMemoryReplayConflictError);

      const other = await harness.admission.putSegment(
        segment(harness.workspaceB, { sourcePayloadHash: "sha256:b", channelId: "ch-b" }),
      );
      expect(other.outcome).toBe("saved");
      expect(other.segment.workspace.workspaceId).toBe(harness.workspaceB);

      const accepted = await harness.admission.consumeDispatch({
        workspaceId: harness.workspaceA,
        segmentId: "seg-1",
        operationId: "op-1",
        sinkProfile: "openviking",
        profileGeneration: 1,
      });
      expect(accepted.outcome).toBe("accepted");
      expect(accepted.dispatch.state).toBe("pending");
      const replayed = await harness.admission.consumeDispatch({
        workspaceId: harness.workspaceA,
        segmentId: "seg-1",
        operationId: "op-1",
        sinkProfile: "openviking",
        profileGeneration: 1,
      });
      expect(replayed.outcome).toBe("replay");
      expect(replayed.dispatch.operationId).toBe("op-1");
      expect(
        harness.admission.consumeDispatch({
          workspaceId: harness.workspaceA,
          segmentId: "seg-1",
          operationId: "op-2",
          sinkProfile: "causal_openviking",
          profileGeneration: 1,
        }),
      ).rejects.toBeInstanceOf(WorkspaceMemoryReplayConflictError);
      expect(
        harness.admission.consumeDispatch({
          workspaceId: harness.workspaceB,
          segmentId: "seg-missing",
          operationId: "op-foreign",
          sinkProfile: "openviking",
          profileGeneration: 1,
        }),
      ).rejects.toBeInstanceOf(WorkspaceMemoryScopeError);

      const failed = await harness.admission.markDispatchState({
        workspaceId: harness.workspaceA,
        operationId: "op-1",
        state: "retryable_failure",
        sanitizedError: "openviking sink unavailable",
      });
      expect(failed).toMatchObject({
        state: "retryable_failure",
        attemptCount: 1,
        sanitizedError: "openviking sink unavailable",
      });
      expect(
        harness.admission.markDispatchState({
          workspaceId: harness.workspaceB,
          operationId: "op-1",
          state: "delivered",
        }),
      ).rejects.toBeInstanceOf(WorkspaceMemoryScopeError);
    } finally {
      await harness.dispose();
    }
  },
);

test.skipIf(!connectionString)(
  "citation store enforces typed kind integrity and Workspace isolation",
  async () => {
    const harness = await openHarness();
    try {
      const ov = await harness.citations.putOpenVikingCitation({
        workspaceId: harness.workspaceA,
        citationId: "ov-1",
        accountId: "acct-a",
        uri: "viking://fact/1",
        contentHash: "hash-ov",
        matchedLevel: "L2",
        title: "Fact one",
        boundOperationId: "read-1",
      });
      expect(ov.citationId).toBe("ov-1");
      expect(await harness.citations.getOpenVikingCitation(harness.workspaceB, "ov-1")).toBeNull();

      await harness.client.query(
        `INSERT INTO "causal_citation_records" ("id", "workspace_id", "citation_id") VALUES ($1, $2, 'cm-1')`,
        [crypto.randomUUID(), harness.workspaceA],
      );

      const offer = await harness.citations.putOffer({
        workspaceId: harness.workspaceA,
        operationId: "offer-1",
        conversationId: "conv-1",
        recipientAgentId: "agent-1",
        recipientRationale: "owns the task",
        messageId: "msg-offer",
        citations: [
          { kind: "openviking", citationId: "ov-1" },
          { kind: "causal_memory", citationId: "cm-1" },
        ],
      });
      expect(offer.outcome).toBe("saved");
      expect(offer.offer.citations).toEqual([
        { kind: "causal_memory", citationId: "cm-1" },
        { kind: "openviking", citationId: "ov-1" },
      ]);
      expect(await harness.citations.putOffer(offer.offer)).toEqual({
        outcome: "replay",
        offer: offer.offer,
      });

      expect(
        harness.citations.putOffer({
          ...offer.offer,
          citations: [{ kind: "causal_memory", citationId: "ov-1" }],
        }),
      ).rejects.toBeInstanceOf(WorkspaceMemoryCitationKindError);
      expect(
        harness.citations.putOffer({
          ...offer.offer,
          operationId: "offer-2",
          citations: [
            { kind: "openviking", citationId: "ov-1" },
            { kind: "causal_memory", citationId: "ov-1" },
          ],
        }),
      ).rejects.toBeInstanceOf(WorkspaceMemoryCitationKindError);
      expect(
        harness.citations.putOffer({
          ...offer.offer,
          workspaceId: harness.workspaceB,
          operationId: "offer-b",
          citations: [{ kind: "openviking", citationId: "ov-1" }],
        }),
      ).rejects.toBeInstanceOf(WorkspaceMemoryCitationKindError);
      expect(await harness.citations.getOffer(harness.workspaceB, "offer-1")).toBeNull();
    } finally {
      await harness.dispose();
    }
  },
);

test.skipIf(!connectionString)(
  "cleanup store leases work and keeps remote failure visible as retryable_failure",
  async () => {
    const harness = await openHarness();
    try {
      const enqueued = await harness.cleanup.enqueue({
        workspaceId: harness.workspaceA,
        operationId: "cleanup-1",
        target: "openviking_account",
      });
      expect(enqueued.state).toBe("pending");
      expect(
        await harness.cleanup.enqueue({
          workspaceId: harness.workspaceA,
          operationId: "cleanup-1",
          target: "openviking_account",
        }),
      ).toMatchObject({ state: "pending", attemptCount: 0 });

      const leased = await harness.cleanup.lease({
        workspaceId: harness.workspaceA,
        operationId: "cleanup-1",
        target: "openviking_account",
        owner: "worker-1",
        now,
        ttlMs: 60_000,
      });
      expect(leased).toMatchObject({
        state: "leased",
        leaseOwner: "worker-1",
        attemptCount: 1,
      });
      expect(
        await harness.cleanup.lease({
          workspaceId: harness.workspaceA,
          operationId: "cleanup-1",
          target: "openviking_account",
          owner: "worker-2",
          now,
          ttlMs: 60_000,
        }),
      ).toBeNull();
      expect(
        harness.cleanup.failRetryable({
          workspaceId: harness.workspaceB,
          operationId: "cleanup-1",
          target: "openviking_account",
          owner: "worker-1",
          sanitizedError: "openviking account delete failed",
        }),
      ).rejects.toBeInstanceOf(WorkspaceMemoryScopeError);

      const failed = await harness.cleanup.failRetryable({
        workspaceId: harness.workspaceA,
        operationId: "cleanup-1",
        target: "openviking_account",
        owner: "worker-1",
        sanitizedError: "openviking account delete failed",
      });
      expect(failed).toMatchObject({
        state: "retryable_failure",
        attemptCount: 1,
        sanitizedError: "openviking account delete failed",
      });
      expect(failed.leaseOwner).toBeUndefined();
      expect(
        await harness.cleanup.get(harness.workspaceA, "cleanup-1", "openviking_account"),
      ).toEqual(failed);
      expect(
        await harness.cleanup.get(harness.workspaceB, "cleanup-1", "openviking_account"),
      ).toBeNull();

      const retried = await harness.cleanup.lease({
        workspaceId: harness.workspaceA,
        operationId: "cleanup-1",
        target: "openviking_account",
        owner: "worker-2",
        now: later,
        ttlMs: 60_000,
      });
      expect(retried).toMatchObject({ state: "leased", leaseOwner: "worker-2", attemptCount: 2 });
      const settled = await harness.cleanup.settle({
        workspaceId: harness.workspaceA,
        operationId: "cleanup-1",
        target: "openviking_account",
        owner: "worker-2",
      });
      expect(settled.state).toBe("settled");
      expect(
        await harness.cleanup.lease({
          workspaceId: harness.workspaceA,
          operationId: "cleanup-1",
          target: "openviking_account",
          owner: "worker-3",
          now: later,
          ttlMs: 60_000,
        }),
      ).toBeNull();
    } finally {
      await harness.dispose();
    }
  },
);
