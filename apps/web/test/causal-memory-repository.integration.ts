import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/client";
import {
  CausalReplayConflictError,
  PrismaCausalMemoryRepository,
} from "../src/server/db/repositories/causal-memory.repositories.server";

test("ledger replay is stable, isolation holds, and workspace delete cascades", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString) return;
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID();
  const user = await db.user.create({ data: { username: `cm-${suffix}` } });
  const workspaceA = await db.workspace.create({
    data: { slug: `a-${suffix}`, name: "A", members: { create: [{ userId: user.id }] } },
  });
  const workspaceB = await db.workspace.create({
    data: { slug: `b-${suffix}`, name: "B", members: { create: [{ userId: user.id }] } },
  });
  const repo = new PrismaCausalMemoryRepository(db);
  try {
    await repo.putTenant({ workspaceId: workspaceA.id, tenantId: "tenant-a", enabled: true });
    const pending = await repo.putPendingLedger({
      workspaceId: workspaceA.id,
      admittedSegmentId: "seg-1",
      operationId: "op-1",
      kind: "completed_task",
      sourceMessageIds: ["m1"],
      sourcePayloadHash: "hash",
      state: "pending",
      attemptCount: 0,
    });
    expect(pending.state).toBe("pending");
    const replay = await repo.putPendingLedger({ ...pending, state: "distilling" });
    expect(replay.state).toBe("pending");
    expect(
      repo.putPendingLedger({ ...pending, sourcePayloadHash: "other" }),
    ).rejects.toBeInstanceOf(CausalReplayConflictError);
    await repo.putCitation({
      workspaceId: workspaceA.id,
      citationId: "item:1",
      causalItemId: "1",
      admittedSegmentId: "seg-1",
      sourceMessageIds: ["m1"],
      boundOperationId: "op-1",
    });
    expect(await repo.getCitation(workspaceB.id, "item:1")).toBeUndefined();
    await repo.markLedgerState(
      workspaceA.id,
      "op-1",
      "temporary_failure",
      "runtime temporarily unavailable",
    );
    await db.workspace.delete({ where: { id: workspaceA.id } });
    expect(
      await db.admittedSegmentIngestLedger.count({ where: { workspaceId: workspaceA.id } }),
    ).toBe(0);
  } finally {
    await db.workspace.deleteMany({ where: { id: { in: [workspaceA.id, workspaceB.id] } } });
    await db.user.delete({ where: { id: user.id } }).catch(() => undefined);
    await db.$disconnect();
  }
});
