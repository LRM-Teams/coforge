import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { prepareDaemonApiKey } from "#src/server/auth/daemon-api-key.server";
import {
  authenticateCentrifugoConnect,
  centrifugoConnectDependencies,
} from "#src/server/centrifugo/connect-proxy.server";
import {
  DAEMON_CREDENTIAL_REVOCATION_RETENTION_MS,
  DaemonCredentialRevocations,
} from "#src/server/db/repositories/daemon-credential-revocation.repositories.server";

/**
 * A deleted Workspace's daemon keys go with it, yet the holder of one must still learn why its
 * key stopped working. Drives the revocation store against local PostgreSQL through a real
 * cascading delete.
 *
 * Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;

async function setup() {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: connectionString! }) });
  const suffix = crypto.randomUUID().slice(0, 8);
  const owner = await db.user.create({ data: { username: `rev-owner-${suffix}` } });
  const workspace = await db.workspace.create({
    data: {
      slug: `rev-${suffix}`,
      name: "Revocations",
      members: { create: { userId: owner.id, role: "owner" } },
    },
  });
  const computer = await db.computer.create({
    data: { ownerId: owner.id, machineId: `machine-${suffix}` },
  });
  await db.workspaceComputer.create({
    data: { workspaceId: workspace.id, computerId: computer.id },
  });
  const issue = async () => {
    const { apiKey, record } = prepareDaemonApiKey({
      principal: { userId: owner.id },
      workspaceId: workspace.id,
      computerId: computer.id,
    });
    await db.daemonApiKey.create({ data: record });
    return { apiKey, hash: record.apiKeyHash };
  };
  return { db, owner, workspace, computer, issue };
}

test.skipIf(!connectionString)(
  "a deleted Workspace's live key keeps answering workspace_deleted after the cascade removed it",
  async () => {
    const { db, owner, workspace, computer, issue } = await setup();
    const hashes: string[] = [];
    try {
      const superseded = await issue();
      await db.daemonApiKey.update({
        where: { apiKeyHash: superseded.hash },
        data: { revokedAt: new Date() },
      });
      const live = await issue();
      hashes.push(live.hash);

      await db.$transaction(async (tx) => {
        expect(await DaemonCredentialRevocations.recordForWorkspace(tx, workspace.id)).toBe(1);
        await tx.workspace.delete({ where: { id: workspace.id } });
      });

      expect(await db.daemonApiKey.count({ where: { workspaceId: workspace.id } })).toBe(0);
      const revocations = new DaemonCredentialRevocations(db);
      expect(await revocations.reasonFor(live.hash)).toBe("workspace_deleted");
      // A key the Computer had already replaced by registering again stays an ordinary failure.
      expect(await revocations.reasonFor(superseded.hash)).toBeUndefined();
    } finally {
      await db.daemonCredentialRevocation
        .deleteMany({ where: { apiKeyHash: { in: hashes } } })
        .catch(() => {});
      await db.computer.delete({ where: { id: computer.id } }).catch(() => {});
      await db.user.delete({ where: { id: owner.id } }).catch(() => {});
      await db.$disconnect();
    }
  },
);

test.skipIf(!connectionString)(
  "a revocation stops answering once it is older than the retention, and the next record prunes it",
  async () => {
    const { db, owner, workspace, computer, issue } = await setup();
    const hashes: string[] = [];
    try {
      const old = await issue();
      hashes.push(old.hash);
      const recordedAt = new Date("2026-01-01T00:00:00.000Z");
      await db.$transaction((tx) =>
        DaemonCredentialRevocations.recordForComputer(
          tx,
          { workspaceId: workspace.id, computerId: computer.id },
          recordedAt,
        ),
      );
      const withinRetention = new DaemonCredentialRevocations(
        db,
        () => new Date(recordedAt.getTime() + DAEMON_CREDENTIAL_REVOCATION_RETENTION_MS - 1),
      );
      expect(await withinRetention.reasonFor(old.hash)).toBe("computer_unlinked");
      const afterRetention = new DaemonCredentialRevocations(
        db,
        () => new Date(recordedAt.getTime() + DAEMON_CREDENTIAL_REVOCATION_RETENTION_MS),
      );
      expect(await afterRetention.reasonFor(old.hash)).toBeUndefined();

      await db.$transaction((tx) =>
        DaemonCredentialRevocations.recordForWorkspace(
          tx,
          workspace.id,
          new Date(recordedAt.getTime() + DAEMON_CREDENTIAL_REVOCATION_RETENTION_MS),
        ),
      );
      expect(await db.daemonCredentialRevocation.count({ where: { revokedAt: recordedAt } })).toBe(
        0,
      );
    } finally {
      await db.daemonCredentialRevocation
        .deleteMany({ where: { apiKeyHash: { in: hashes } } })
        .catch(() => {});
      await db.workspace.delete({ where: { id: workspace.id } }).catch(() => {});
      await db.computer.delete({ where: { id: computer.id } }).catch(() => {});
      await db.user.delete({ where: { id: owner.id } }).catch(() => {});
      await db.$disconnect();
    }
  },
);

test.skipIf(!connectionString)(
  "the connect proxy tells only the holder of a deleted Workspace's or unlinked Computer's key why, from the database",
  async () => {
    const deleted = await setup();
    const unlinked = await setup();
    const hashes: string[] = [];
    const connect = (daemonApiKey: string) =>
      authenticateCentrifugoConnect(
        new Request("http://backend", {
          method: "POST",
          body: JSON.stringify({ data: { daemonApiKey } }),
        }),
        centrifugoConnectDependencies(deleted.db),
      );
    try {
      const deletedKey = await deleted.issue();
      hashes.push(deletedKey.hash);
      await deleted.db.$transaction(async (tx) => {
        await DaemonCredentialRevocations.recordForWorkspace(tx, deleted.workspace.id);
        await tx.workspace.delete({ where: { id: deleted.workspace.id } });
      });
      const unlinkedKey = await unlinked.issue();
      await unlinked.db.workspaceComputer.deleteMany({
        where: { workspaceId: unlinked.workspace.id, computerId: unlinked.computer.id },
      });

      const refusedDeleted = await connect(deletedKey.apiKey);
      expect(await refusedDeleted.json()).toEqual({
        disconnect: { code: 4501, reason: "workspace_deleted" },
      });
      const refusedUnlinked = await connect(unlinkedKey.apiKey);
      expect(await refusedUnlinked.json()).toEqual({
        disconnect: { code: 4502, reason: "computer_unlinked" },
      });
      expect((await connect(`dk_${"b".repeat(43)}`)).status).toBe(401);
    } finally {
      await deleted.db.daemonCredentialRevocation
        .deleteMany({ where: { apiKeyHash: { in: hashes } } })
        .catch(() => {});
      for (const scope of [deleted, unlinked]) {
        await scope.db.workspace.delete({ where: { id: scope.workspace.id } }).catch(() => {});
        await scope.db.computer.delete({ where: { id: scope.computer.id } }).catch(() => {});
        await scope.db.user.delete({ where: { id: scope.owner.id } }).catch(() => {});
        await scope.db.$disconnect();
      }
    }
  },
);
