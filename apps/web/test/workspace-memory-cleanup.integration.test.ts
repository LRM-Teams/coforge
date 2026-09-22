import { expect, test } from "bun:test";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/client";
import { PrismaOpenVikingBindingStore } from "../src/server/db/repositories/openviking-binding.repositories.server";
import { PrismaWorkspaceMemoryCleanupStore } from "../src/server/db/repositories/workspace-memory-cleanup.repositories.server";
import { PrismaWorkspaceMemoryProfileStore } from "../src/server/db/repositories/workspace-memory-profile.repositories.server";
import {
  bindTypedAccountDeleteToWorkspace,
  createOpenVikingTypedAccountDelete,
} from "../src/server/openviking/typed-account-delete.server";
import { createOpenVikingRuntimeClient } from "../src/server/openviking/runtime-client.server";
import {
  createFakeWorkspaceMemoryCleanupRemotes,
  createWorkspaceMemoryCleanup,
} from "../src/server/workspace-memory/cleanup.server";
import { createWorkspaceMemoryProfiles } from "../src/server/workspace-memory/profiles";
import {
  createFakeMemoryRuntimeProvisioner,
  createWorkspaceMemoryProfileReconciler,
} from "../src/server/workspace-memory/reconciler";
import {
  WORKSPACE_MEMORY_PG_URL,
  applyWorkspaceMemoryPgStub,
  warnIfWorkspaceMemoryPgSkipped,
} from "./helpers/workspace-memory-pg";

const connectionString = WORKSPACE_MEMORY_PG_URL;
warnIfWorkspaceMemoryPgSkipped("workspace-memory cleanup");

const now = new Date("2026-09-21T12:00:00.000Z");
const later = new Date("2026-09-21T13:00:00.000Z");
const enabled = { prototypeEnabled: true };

type Harness = {
  db: PrismaClient;
  client: import("pg").PoolClient;
  workspaceA: string;
  profiles: PrismaWorkspaceMemoryProfileStore;
  bindings: PrismaOpenVikingBindingStore;
  cleanupStore: PrismaWorkspaceMemoryCleanupStore;
};

async function openHarness(): Promise<Harness & { dispose: () => Promise<void> }> {
  const pool = new Pool({ connectionString });
  const schema = `wmp_cln_${crypto.randomUUID().replaceAll("-", "")}`;
  const client = await pool.connect();
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`SET search_path TO "${schema}"`);
  const workspaceA = crypto.randomUUID();
  await applyWorkspaceMemoryPgStub(client, { workspaceIds: [workspaceA] });
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }, { schema }) });
  return {
    db,
    client,
    workspaceA,
    profiles: new PrismaWorkspaceMemoryProfileStore(db),
    bindings: new PrismaOpenVikingBindingStore(db),
    cleanupStore: new PrismaWorkspaceMemoryCleanupStore(db),
    async dispose() {
      await db.$disconnect();
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      client.release();
      await pool.end();
    },
  };
}

test.skipIf(!connectionString)(
  "remote OpenViking account failure stays visible, is re-leasable, and never blocks as success",
  async () => {
    const harness = await openHarness();
    try {
      await harness.bindings.compareAndSet({
        workspaceId: harness.workspaceA,
        expectedGeneration: 0,
        binding: {
          workspaceId: harness.workspaceA,
          accountId: "acct-ws-a",
          serviceIdentityId: "svc-ws-a",
          credentialRef: "secret:ov-ws-a",
          generation: 1,
        },
      });
      const remotes = createFakeWorkspaceMemoryCleanupRemotes();
      remotes.fail("openviking_account", "Bearer ov-secret");
      const cleanup = createWorkspaceMemoryCleanup({
        store: harness.cleanupStore,
        remotes,
      });
      await cleanup.enqueueWorkspaceDeletion({
        workspaceId: harness.workspaceA,
        operationId: "del-1",
      });
      const failed = await cleanup.run({
        workspaceId: harness.workspaceA,
        operationId: "del-1",
        owner: "worker-1",
        now,
        ttlMs: 60_000,
      });
      expect(failed).toMatchObject({
        status: "retryable_failure",
        failedTarget: "openviking_account",
      });
      if (failed.status !== "retryable_failure") throw new Error("expected retryable_failure");
      expect(failed.work).toMatchObject({
        state: "retryable_failure",
        sanitizedError: "openviking account delete failed",
      });
      expect(
        await harness.cleanupStore.get(harness.workspaceA, "del-1", "openviking_account"),
      ).toEqual(failed.work);
      expect(
        await harness.cleanupStore.get(harness.workspaceA, "del-1", "openviking_binding"),
      ).toMatchObject({ state: "pending" });

      const retried = await cleanup.lease({
        workspaceId: harness.workspaceA,
        operationId: "del-1",
        target: "openviking_account",
        owner: "worker-2",
        now: later,
        ttlMs: 60_000,
      });
      expect(retried).toMatchObject({
        state: "leased",
        leaseOwner: "worker-2",
        attemptCount: 2,
      });
    } finally {
      await harness.dispose();
    }
  },
);

test.skipIf(!connectionString)(
  "settled cleanup is idempotent and profile switch or off never enqueues deletion work",
  async () => {
    const harness = await openHarness();
    try {
      const remotes = createFakeWorkspaceMemoryCleanupRemotes();
      const cleanup = createWorkspaceMemoryCleanup({
        store: harness.cleanupStore,
        remotes,
      });
      const profileApi = createWorkspaceMemoryProfiles({
        store: harness.profiles,
        gate: enabled,
      });
      const provisioner = createFakeMemoryRuntimeProvisioner();
      const reconciler = createWorkspaceMemoryProfileReconciler({
        store: harness.profiles,
        provisioner,
      });
      expect(
        (
          await profileApi.selectDesired({
            workspaceId: harness.workspaceA,
            desired: "openviking",
            at: now,
          })
        ).ok,
      ).toBe(true);
      expect((await reconciler.reconcile(harness.workspaceA)).ok).toBe(true);
      expect(
        (
          await profileApi.selectDesired({
            workspaceId: harness.workspaceA,
            desired: "off",
            at: later,
          })
        ).ok,
      ).toBe(true);
      const off = await reconciler.reconcile(harness.workspaceA);
      expect(off.ok).toBe(true);
      expect(provisioner.deleted).toEqual([]);
      expect(
        await harness.cleanupStore.get(harness.workspaceA, "del-1", "openviking_account"),
      ).toBeNull();
      expect(remotes.calls).toEqual([]);

      await cleanup.enqueueWorkspaceDeletion({
        workspaceId: harness.workspaceA,
        operationId: "del-1",
      });
      const first = await cleanup.run({
        workspaceId: harness.workspaceA,
        operationId: "del-1",
        owner: "worker-1",
        now,
        ttlMs: 60_000,
      });
      expect(first.status).toBe("completed");
      remotes.fail("openviking_account");
      const replay = await cleanup.run({
        workspaceId: harness.workspaceA,
        operationId: "del-1",
        owner: "worker-2",
        now: later,
        ttlMs: 60_000,
      });
      expect(replay.status).toBe("completed");
      expect(remotes.calls).toEqual(["openviking_account", "openviking_binding"]);
      const settled = await cleanup.settle({
        workspaceId: harness.workspaceA,
        operationId: "del-1",
        target: "openviking_binding",
        owner: "worker-9",
      });
      expect(settled.state).toBe("settled");
    } finally {
      await harness.dispose();
    }
  },
);

test.skipIf(!connectionString)(
  "unsettled cleanup RESTRICT-blocks Workspace row delete; typed account delete is the OV channel",
  async () => {
    const harness = await openHarness();
    try {
      await harness.bindings.compareAndSet({
        workspaceId: harness.workspaceA,
        expectedGeneration: 0,
        binding: {
          workspaceId: harness.workspaceA,
          accountId: "acct-ws-a",
          serviceIdentityId: "svc-ws-a",
          credentialRef: "secret:ov-ws-a",
          generation: 1,
        },
      });
      const ovCalls: Array<{ url: string; method?: string }> = [];
      let ovStatus = 500;
      const remotes = createFakeWorkspaceMemoryCleanupRemotes();
      remotes.deleteOpenVikingAccount = bindTypedAccountDeleteToWorkspace({
        bindings: harness.bindings,
        accounts: createOpenVikingTypedAccountDelete({
          runtime: createOpenVikingRuntimeClient({
            baseUrl: "http://ov.internal:1933",
            fetchImpl: async (input, init) => {
              ovCalls.push({ url: String(input), method: init?.method });
              return new Response(null, { status: ovStatus });
            },
          }),
          authorizedOwner: "worker-1",
          adminIdentity: {
            accountId: "root",
            userId: "cleanup-admin",
            role: "admin",
            authorization: "Bearer server-held-admin",
          },
        }),
      });
      remotes.removeBinding = async ({ workspaceId }) => {
        await harness.db.openVikingBinding.deleteMany({ where: { workspaceId } });
        return { ok: true };
      };
      const cleanup = createWorkspaceMemoryCleanup({
        store: harness.cleanupStore,
        remotes,
      });
      await cleanup.enqueueWorkspaceDeletion({
        workspaceId: harness.workspaceA,
        operationId: "del-1",
      });
      await expect(
        harness.client.query(`DELETE FROM "workspaces" WHERE "id" = $1`, [harness.workspaceA]),
      ).rejects.toThrow(/workspace_memory_cleanup_work_workspace_id_fkey/);

      const failed = await cleanup.run({
        workspaceId: harness.workspaceA,
        operationId: "del-1",
        owner: "worker-1",
        now,
        ttlMs: 60_000,
      });
      expect(failed).toMatchObject({
        status: "retryable_failure",
        failedTarget: "openviking_account",
      });
      expect(ovCalls).toEqual([
        {
          url: "http://ov.internal:1933/api/v1/admin/accounts/acct-ws-a",
          method: "DELETE",
        },
      ]);
      await expect(
        harness.client.query(`DELETE FROM "workspaces" WHERE "id" = $1`, [harness.workspaceA]),
      ).rejects.toThrow(/workspace_memory_cleanup_work_workspace_id_fkey/);
      expect(await harness.bindings.get(harness.workspaceA)).not.toBeNull();

      ovStatus = 202;
      const completed = await cleanup.run({
        workspaceId: harness.workspaceA,
        operationId: "del-1",
        owner: "worker-1",
        now: later,
        ttlMs: 60_000,
      });
      expect(completed.status).toBe("completed");
      expect(await harness.bindings.get(harness.workspaceA)).toBeNull();
      expect(ovCalls).toHaveLength(2);
    } finally {
      await harness.dispose();
    }
  },
);
