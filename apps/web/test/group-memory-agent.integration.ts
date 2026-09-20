import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/client";
import { isAppError, type AppError } from "../src/lib/app-error";
import { admitMemoryEpisode } from "../src/server/group-memory/memory-episodes.server";
import { createMemoryInsight } from "../src/server/group-memory/memory-insights.server";
import {
  disableGroupMemory,
  enableGroupMemory,
  reconcileMemoryAgentMemberships,
} from "../src/server/group-memory/memory-agent.server";
import {
  MEMORY_OFFER_COOLDOWN_MS,
  publishMemoryOffer,
} from "../src/server/group-memory/memory-offer.server";
import { submitAndAdmitSkillProposal } from "../src/server/group-memory/skill-proposals.server";

/**
 * Memory Agent lifecycle + offer disciplines (ADR 0052-E/H, slice 4):
 * enablement as the designation row (managed identity, fenced tool profile,
 * auto-enrollment in every PublicChannel, revive-after-disable), idempotent
 * membership reconciliation, and offer publication — structured routing,
 * per-target cooldown with explicit-ask bypass, operation replay-vs-drift,
 * insight and LearnedSkill-head targets, all-or-none delivery rows.
 */

let client: PrismaClient | undefined;

function getDb(): PrismaClient {
  if (client) return client;
  const connectionString = Bun.env.MEMORY_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("MEMORY_TEST_DATABASE_URL must point at local PostgreSQL");
  client = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  return client;
}

async function expectAppError(run: () => Promise<unknown>, errorId: string): Promise<void> {
  try {
    await run();
    throw new Error(`expected AppError ${errorId}`);
  } catch (error) {
    expect(isAppError(error)).toBe(true);
    expect((error as AppError).errorId).toBe(errorId);
  }
}

async function setup() {
  const db = getDb();
  const suffix = crypto.randomUUID().slice(0, 8);
  const user = await db.user.create({ data: { username: `ag-owner-${suffix}` } });
  const workspace = await db.workspace.create({
    data: {
      slug: `ag-${suffix}`,
      name: "Agent Test",
      members: { create: [{ userId: user.id, role: "owner" }] },
    },
  });
  const channel = await db.conversation.create({
    data: { workspaceId: workspace.id, channelName: `ag-${suffix}` },
  });
  const target = await db.agent.create({
    data: {
      workspaceId: workspace.id,
      ownerId: user.id,
      name: `worker-${suffix}`,
      displayName: "Worker",
      runtimeConfig: {},
    },
    select: { id: true, name: true },
  });
  await db.conversationMember.create({
    data: { conversationId: channel.id, workspaceId: workspace.id, agentId: target.id },
  });
  return { db, workspaceId: workspace.id, ownerId: user.id, conversationId: channel.id, target };
}

test("enablement is the designation row: managed identity, fenced profile, enrollment, revive", async () => {
  const s = await setup();
  const enabled = await enableGroupMemory(s.db, { workspaceId: s.workspaceId, ownerId: s.ownerId });
  expect(enabled.agentId).toBeTruthy();
  const agent = await s.db.agent.findUniqueOrThrow({
    where: { id: enabled.agentId },
    select: { name: true, deletedAt: true, runtimeConfig: true },
  });
  expect(agent.deletedAt).toBeNull();
  expect((agent.runtimeConfig as { toolProfile?: { kind: string } }).toolProfile?.kind).toBe(
    "memory-explorer",
  );
  const designation = await s.db.memoryAgentDesignation.findUnique({
    where: { workspaceId: s.workspaceId },
  });
  expect(designation?.agentId).toBe(enabled.agentId);
  const membership = await s.db.conversationMember.findFirst({
    where: {
      workspaceId: s.workspaceId,
      agentId: enabled.agentId,
      conversationId: s.conversationId,
    },
  });
  expect(membership).toBeTruthy();

  // Idempotent re-enable.
  const again = await enableGroupMemory(s.db, { workspaceId: s.workspaceId, ownerId: s.ownerId });
  expect(again.agentId).toBe(enabled.agentId);
  expect(await s.db.agent.count({ where: { workspaceId: s.workspaceId, name: "memory" } })).toBe(1);

  // Disable soft-deletes the identity and removes the switch.
  await disableGroupMemory(s.db, { workspaceId: s.workspaceId });
  expect(
    await s.db.memoryAgentDesignation.findUnique({ where: { workspaceId: s.workspaceId } }),
  ).toBeNull();
  expect(
    (await s.db.agent.findUniqueOrThrow({ where: { id: enabled.agentId } })).deletedAt,
  ).not.toBeNull();

  // Re-enable revives the same identity (name uniqueness held the row).
  const revived = await enableGroupMemory(s.db, { workspaceId: s.workspaceId, ownerId: s.ownerId });
  expect(revived.agentId).toBe(enabled.agentId);
});

test("reconciliation enrolls new channels idempotently", async () => {
  const s = await setup();
  const enabled = await enableGroupMemory(s.db, { workspaceId: s.workspaceId, ownerId: s.ownerId });
  const fresh = await s.db.conversation.create({
    data: { workspaceId: s.workspaceId, channelName: `later-${crypto.randomUUID().slice(0, 6)}` },
  });
  const first = await reconcileMemoryAgentMemberships(s.db);
  expect(first.enrolled).toBeGreaterThanOrEqual(1);
  expect(
    await s.db.conversationMember.findFirst({
      where: { workspaceId: s.workspaceId, agentId: enabled.agentId, conversationId: fresh.id },
    }),
  ).toBeTruthy();
  const second = await reconcileMemoryAgentMemberships(s.db);
  expect(second.enrolled).toBe(0);
});

test("offers: cooldown, explicit-ask bypass, replay-vs-drift, insight and skill targets", async () => {
  const s = await setup();
  const enabled = await enableGroupMemory(s.db, { workspaceId: s.workspaceId, ownerId: s.ownerId });
  const { insightId } = await createMemoryInsight(s.db, {
    workspaceId: s.workspaceId,
    statement: "Back up the database nightly before the cleanup window",
  });
  const episode = await admitMemoryEpisode(s.db, {
    workspaceId: s.workspaceId,
    conversationId: s.conversationId,
    kind: "quiet_window",
    startSequence: 1,
    endSequence: 2,
    title: "backup window",
    body: "we run the backup before the cleanup window every night",
  });
  const bound = await submitAndAdmitSkillProposal(s.db, {
    workspaceId: s.workspaceId,
    draft: {
      action: "create",
      key: "backup-window",
      name: "Backup window",
      kind: "procedure",
      body: {
        instructions: ["Run the backup", "Run the cleanup"],
        postconditions: ["backup verified"],
      },
      groundingEpisodes: [episode.episodeId],
    },
  });
  expect(bound.outcome).toBe("bound");

  const base = {
    workspaceId: s.workspaceId,
    memoryAgentId: enabled.agentId,
    conversationId: s.conversationId,
    targetAgentId: s.target.id,
  };

  // Insight + skill in one offer; both land with delivery rows.
  const published = await publishMemoryOffer(s.db, {
    ...base,
    targets: [
      { kind: "insight", id: insightId },
      { kind: "skill", id: bound.outcome === "bound" ? bound.revisionId : "" },
    ],
    body: `@${s.target.name} the team backs up nightly — see the backup-window skill`,
    operationKey: "offer-1",
  });
  expect(published.published).toBe(true);
  if (!published.published) return;
  const deliveries = await s.db.memoryOfferDelivery.findMany({
    where: { workspaceId: s.workspaceId, operationKey: "offer-1" },
  });
  expect(deliveries.length).toBe(2);
  const mention = await s.db.messageMention.findFirst({
    where: { workspaceId: s.workspaceId, messageId: published.messageId },
  });
  expect(mention?.actorId).toBe(s.target.id);
  const wake = await s.db.agentMessageDelivery.findFirst({
    where: { workspaceId: s.workspaceId, messageId: published.messageId },
  });
  expect(wake?.agentId).toBe(s.target.id);

  // Replay of the same operation is a duplicate.
  const replay = await publishMemoryOffer(s.db, {
    ...base,
    targets: [
      { kind: "insight", id: insightId },
      { kind: "skill", id: bound.outcome === "bound" ? bound.revisionId : "" },
    ],
    body: "same",
    operationKey: "offer-1",
  });
  expect(replay.published && replay.duplicate).toBe(true);
  // Drift under the same operation key is a conflict.
  await expectAppError(
    () =>
      publishMemoryOffer(s.db, {
        ...base,
        targets: [{ kind: "skill", id: bound.outcome === "bound" ? bound.revisionId : "" }],
        body: "different shape",
        operationKey: "offer-1",
      }),
    "gm-offer-operation-drift",
  );

  // Cooldown: the same insight within 7 days is suppressed; explicit ask bypasses.
  const now = new Date();
  const suppressed = await publishMemoryOffer(s.db, {
    ...base,
    targets: [{ kind: "insight", id: insightId }],
    body: "again",
    operationKey: "offer-2",
    now,
  });
  expect(suppressed.published).toBe(false);
  if (!suppressed.published) expect(suppressed.suppressed[0]?.reason).toBe("cooldown");
  const bypass = await publishMemoryOffer(s.db, {
    ...base,
    targets: [{ kind: "insight", id: insightId }],
    body: "you asked",
    operationKey: "offer-3",
    explicitAsk: true,
    now: new Date(now.getTime() + MEMORY_OFFER_COOLDOWN_MS / 2),
  });
  expect(bypass.published).toBe(true);

  // A retired skill revision is not offerable.
  if (bound.outcome === "bound") {
    await s.db.learnedSkillRevision.update({
      where: { id: bound.revisionId },
      data: { state: "retired" },
    });
    await s.db.learnedSkill.update({
      where: { workspaceId_key: { workspaceId: s.workspaceId, key: "backup-window" } },
      data: { currentRevisionId: null },
    });
    await expectAppError(
      () =>
        publishMemoryOffer(s.db, {
          ...base,
          targets: [{ kind: "skill", id: bound.revisionId }],
          body: "stale skill",
          operationKey: "offer-4",
        }),
      "gm-offer-skill-missing",
    );
  }

  // A non-designated sender cannot publish.
  await expectAppError(
    () =>
      publishMemoryOffer(s.db, {
        ...base,
        memoryAgentId: s.target.id,
        targets: [{ kind: "insight", id: insightId }],
        body: "spoof",
        operationKey: "offer-5",
      }),
    "gm-memory-explorer-only",
  );
});
