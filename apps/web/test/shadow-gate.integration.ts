import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/client";
import {
  admitMemoryEpisode,
  type EpisodeParticipant,
} from "../src/server/group-memory/memory-episodes.server";
import { enableGroupMemory } from "../src/server/group-memory/memory-agent.server";
import { publishMemoryOffer } from "../src/server/group-memory/memory-offer.server";
import { submitAndAdmitSkillProposal } from "../src/server/group-memory/skill-proposals.server";
import { runShadowGateSweep } from "../src/server/group-memory/shadow-gate.server";

/**
 * The shadow gate (ADR 0052-D, slice 5): delivered skill offers turn into
 * signed score events when the receiving Agent participates in later
 * distilled episodes (+1 success / −1 failure), signals are idempotent per
 * (delivery, episode) pair, non-participation produces nothing, and a
 * revision whose live score falls to <= 0 retires — the lineage head falls
 * back to the parent when one is active, and the retirement lands in the
 * Proposal Ledger.
 */

let client: PrismaClient | undefined;

function getDb(): PrismaClient {
  if (client) return client;
  const connectionString = Bun.env.MEMORY_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("MEMORY_TEST_DATABASE_URL must point at local PostgreSQL");
  client = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  return client;
}

async function setup() {
  const db = getDb();
  const suffix = crypto.randomUUID().slice(0, 8);
  const user = await db.user.create({ data: { username: `sg-owner-${suffix}` } });
  const workspace = await db.workspace.create({
    data: {
      slug: `sg-${suffix}`,
      name: "Shadow Gate Test",
      members: { create: [{ userId: user.id, role: "owner" }] },
    },
  });
  const channel = await db.conversation.create({
    data: { workspaceId: workspace.id, channelName: `sg-${suffix}` },
  });
  const enabled = await enableGroupMemory(db, { workspaceId: workspace.id, ownerId: user.id });
  const worker = await db.agent.create({
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
    data: { conversationId: channel.id, workspaceId: workspace.id, agentId: worker.id },
  });
  const participants: EpisodeParticipant[] = [
    { kind: "human", id: user.id, handle: user.username },
    { kind: "agent", id: worker.id, handle: worker.name },
  ];
  let window = 0;
  const addOutcomeEpisode = async (outcome: "success" | "failure", who: EpisodeParticipant[]) => {
    window += 3;
    const admitted = await admitMemoryEpisode(db, {
      workspaceId: workspace.id,
      conversationId: channel.id,
      kind: "quiet_window",
      startSequence: window - 2,
      endSequence: window,
      title: `${outcome} slice`,
      body: `${outcome} window body ${window}`,
      participants: who,
    });
    await db.memoryEpisode.update({
      where: { id: admitted.episodeId },
      data: {
        outcome,
        outcomeReason: `${outcome} reason`,
        keySteps: "steps",
        distilledAt: new Date(),
      },
    });
    return admitted.episodeId;
  };
  return {
    db,
    workspaceId: workspace.id,
    memoryAgentId: enabled.agentId,
    conversationId: channel.id,
    worker,
    participants,
    addOutcomeEpisode,
  };
}

const PROCEDURE_BODY = {
  instructions: ["Run the checklist", "Verify the output"],
  postconditions: ["output verified"],
};

test("deliveries become signed, idempotent signals only for participating agents", async () => {
  const s = await setup();
  const groundingEpisode = await s.addOutcomeEpisode("success", s.participants);
  const bound = await submitAndAdmitSkillProposal(s.db, {
    workspaceId: s.workspaceId,
    draft: {
      action: "create",
      key: "checklist-flow",
      name: "Checklist flow",
      kind: "procedure",
      body: PROCEDURE_BODY,
      groundingEpisodes: [groundingEpisode],
    },
  });
  expect(bound.outcome).toBe("bound");
  if (bound.outcome !== "bound") return;
  const published = await publishMemoryOffer(s.db, {
    workspaceId: s.workspaceId,
    memoryAgentId: s.memoryAgentId,
    conversationId: s.conversationId,
    targetAgentId: s.worker.id,
    targets: [{ kind: "skill", id: bound.revisionId }],
    body: `@${s.worker.name} use the checklist flow`,
    operationKey: "sg-offer-1",
  });
  expect(published.published).toBe(true);

  // One success and one failure episode with the worker participating.
  const successEpisode = await s.addOutcomeEpisode("success", s.participants);
  const failureEpisode = await s.addOutcomeEpisode("failure", s.participants);
  // An episode without the worker must produce nothing.
  const bystander = await s.addOutcomeEpisode("success", [
    { kind: "human", id: s.participants[0]!.id, handle: "human" },
  ]);

  const first = await runShadowGateSweep(s.db, { workspaceId: s.workspaceId });
  expect(first.signalsApplied).toBe(2);
  void successEpisode;
  void failureEpisode;
  void bystander;

  const events = await s.db.learnedSkillScoreEvent.findMany({
    where: { workspaceId: s.workspaceId, revisionId: bound.revisionId },
  });
  const signalEvents = events.filter((event) => event.reason.startsWith("offer_signal"));
  expect(signalEvents.map((event) => event.delta).sort()).toEqual([-1, 1]);
  expect(signalEvents.every((event) => event.offerDeliveryId !== null)).toBe(true);

  // Replays never double-count.
  const replay = await runShadowGateSweep(s.db, { workspaceId: s.workspaceId });
  expect(replay.signalsApplied).toBe(0);
  const ledgerSignals = await s.db.skillProposalLedgerEntry.count({
    where: { workspaceId: s.workspaceId, kind: "signal" },
  });
  expect(ledgerSignals).toBe(2);
});

test("a revision whose live score falls to <= 0 retires and the head falls back", async () => {
  const s = await setup();
  const groundingEpisode = await s.addOutcomeEpisode("success", s.participants);
  const create = await submitAndAdmitSkillProposal(s.db, {
    workspaceId: s.workspaceId,
    draft: {
      action: "create",
      key: "doomed-flow",
      name: "Doomed flow",
      kind: "procedure",
      body: PROCEDURE_BODY,
      groundingEpisodes: [groundingEpisode],
    },
  });
  expect(create.outcome).toBe("bound");
  if (create.outcome !== "bound") return;
  const revise = await submitAndAdmitSkillProposal(s.db, {
    workspaceId: s.workspaceId,
    draft: {
      action: "revise",
      targetSkillKey: "doomed-flow",
      body: {
        instructions: ["Run the checklist", "Verify twice"],
        postconditions: ["output verified"],
      },
      groundingEpisodes: [groundingEpisode],
    },
  });
  expect(revise.outcome).toBe("bound");
  if (revise.outcome !== "bound") return;

  await publishMemoryOffer(s.db, {
    workspaceId: s.workspaceId,
    memoryAgentId: s.memoryAgentId,
    conversationId: s.conversationId,
    targetAgentId: s.worker.id,
    targets: [{ kind: "skill", id: revise.revisionId }],
    body: `@${s.worker.name} try the revised flow`,
    operationKey: "sg-offer-2",
  });

  // Seed (+2); three failure signals drive v2 to −1 → retire, head falls to v1.
  await s.addOutcomeEpisode("failure", s.participants);
  await s.addOutcomeEpisode("failure", s.participants);
  await s.addOutcomeEpisode("failure", s.participants);
  const result = await runShadowGateSweep(s.db, { workspaceId: s.workspaceId });
  expect(result.signalsApplied).toBe(3);
  expect(result.retired).toBe(1);

  const v2 = await s.db.learnedSkillRevision.findUniqueOrThrow({
    where: { id: revise.revisionId },
  });
  expect(v2.state).toBe("retired");
  const skill = await s.db.learnedSkill.findUniqueOrThrow({
    where: { workspaceId_key: { workspaceId: s.workspaceId, key: "doomed-flow" } },
  });
  expect(skill.currentRevisionId).toBe(create.revisionId);
  const retiredEntry = await s.db.skillProposalLedgerEntry.findFirst({
    where: { workspaceId: s.workspaceId, kind: "retired", revisionId: revise.revisionId },
  });
  expect(retiredEntry).toBeTruthy();

  // The retired head is no longer offerable — explicit ask bypasses the
  // cooldown, never the target check.
  try {
    await publishMemoryOffer(s.db, {
      workspaceId: s.workspaceId,
      memoryAgentId: s.memoryAgentId,
      conversationId: s.conversationId,
      targetAgentId: s.worker.id,
      targets: [{ kind: "skill", id: revise.revisionId }],
      body: "stale",
      operationKey: "sg-offer-3",
      explicitAsk: true,
    });
    throw new Error("expected gm-offer-skill-missing");
  } catch (error) {
    expect((error as { errorId?: string }).errorId).toBe("gm-offer-skill-missing");
  }
});
