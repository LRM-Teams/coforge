import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/client";
import { isAppError, type AppError } from "../src/lib/app-error";
import { admitMemoryEpisode } from "../src/server/group-memory/memory-episodes.server";
import {
  createMemoryInsight,
  reviseMemoryInsight,
} from "../src/server/group-memory/memory-insights.server";
import type { DistillationLlm } from "../src/server/group-memory/distillation-llm.server";
import {
  buildSkillSearchText,
  canonicalJson,
  renderSkillMarkdown,
  skillArtifactDigest,
  validateSkillArtifactBody,
} from "../src/server/group-memory/skill-artifacts.server";
import {
  recordNoActionProposal,
  recentLedgerEntries,
  submitAndAdmitSkillProposal,
} from "../src/server/group-memory/skill-proposals.server";
import { runProposalPass } from "../src/server/group-memory/skill-proposer.server";
import { saveWorkspaceModelConfiguration } from "../src/server/group-memory/workspace-model-configuration.server";

/**
 * LearnedSkill artifacts + canonicalizer + proposer (ADR 0052, slice 3):
 * closed-schema validation with digest identity, all-or-none proposal
 * admission (grounding edges required — ≥1 episode for every kind), the
 * supersedes edge and monotonic versioning on revise, the append-only
 * Proposal Ledger (including rejections and no_action), and the
 * one-proposal-per-pass worker with trigger-count idempotency.
 */

process.env.COFORGE_AGENT_CREDENTIAL_ENCRYPTION_KEY ??=
  "0000000000000000000000000000000000000000000000000000000000000000";

let client: PrismaClient | undefined;

function getDb(): PrismaClient {
  if (client) return client;
  const connectionString = Bun.env.MEMORY_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("MEMORY_TEST_DATABASE_URL must point at local PostgreSQL");
  client = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  return client;
}

const VALID_GUIDANCE = {
  causal_context: {
    facts: [{ fact_id: "f1", statement: "Deploys fail when migrations are skipped" }],
  },
  branches: [
    {
      branch_id: "b1",
      when: { explanation: "a deploy includes schema-touching changes" },
      action: {
        instructions: ["Run migrations before the deploy step"],
        rationale: "state drift breaks releases",
      },
      future: { disposition: "success" as const, critical_steps: ["migrate", "deploy", "verify"] },
    },
    {
      branch_id: "b2",
      when: { explanation: "the deploy already failed on drift" },
      action: {
        instructions: ["Roll back", "Run migrations", "Redeploy"],
        rationale: "recovery path",
      },
      future: { disposition: "failure_risk" as const, critical_steps: ["rollback"] },
    },
  ],
};

const VALID_PROCEDURE = {
  preconditions: ["release branch cut"],
  instructions: ["Run the full test suite", "Tag the release"],
  postconditions: ["tag exists"],
};

class StaticLlm implements DistillationLlm {
  constructor(private readonly payload: unknown) {}
  async completeJson<T>(): Promise<T> {
    return this.payload as T;
  }
}

async function expectAppError(run: () => unknown, errorId: string): Promise<void> {
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
  const user = await db.user.create({ data: { username: `ls-owner-${suffix}` } });
  const workspace = await db.workspace.create({
    data: {
      slug: `ls-${suffix}`,
      name: "LearnedSkill Test",
      members: { create: [{ userId: user.id, role: "owner" }] },
    },
  });
  const conversation = await db.conversation.create({
    data: { workspaceId: workspace.id, channelName: `ls-${suffix}` },
  });
  let window = 0;
  const addDistilledEpisode = async (outcome: "success" | "failure") => {
    window += 3;
    const admitted = await admitMemoryEpisode(db, {
      workspaceId: workspace.id,
      conversationId: conversation.id,
      kind: "quiet_window",
      startSequence: window - 2,
      endSequence: window,
      title: `slice ${window / 3}`,
      body: `slice body ${window}`,
    });
    await db.memoryEpisode.update({
      where: { id: admitted.episodeId },
      data: {
        outcome,
        outcomeReason: outcome === "failure" ? "the release broke" : "shipped fine",
        keySteps: "steps",
        distilledAt: new Date(),
      },
    });
    return admitted.episodeId;
  };
  return { db, workspaceId: workspace.id, ownerUserId: user.id, addDistilledEpisode };
}

test("artifact schema: valid bodies pass, closed-schema violations carry error ids", async () => {
  expect(validateSkillArtifactBody("step_guidance", VALID_GUIDANCE)).toBeTruthy();
  expect(validateSkillArtifactBody("procedure", VALID_PROCEDURE)).toBeTruthy();
  await expectAppError(
    () => validateSkillArtifactBody("composite" as never, {}),
    "ls-artifact-kind",
  );
  await expectAppError(
    () => validateSkillArtifactBody("step_guidance", { branches: [] }),
    "ls-artifact-facts",
  );
  await expectAppError(
    () =>
      validateSkillArtifactBody("step_guidance", {
        ...VALID_GUIDANCE,
        branches: [
          {
            ...VALID_GUIDANCE.branches[0],
            future: { disposition: "maybe", critical_steps: ["x"] },
          },
        ],
      }),
    "ls-artifact-branch-disposition",
  );
  await expectAppError(
    () => validateSkillArtifactBody("procedure", { instructions: [] }),
    "ls-artifact-instructions",
  );
});

test("digest identity is canonical: key order does not matter", () => {
  const a = skillArtifactDigest("procedure", { instructions: ["x", "y"], preconditions: ["p"] });
  const b = skillArtifactDigest("procedure", { preconditions: ["p"], instructions: ["x", "y"] });
  expect(a).toBe(b);
  expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
});

test("search text and markdown render cover both kinds", () => {
  const guidanceText = buildSkillSearchText(
    "Deploy safety",
    "step_guidance",
    VALID_GUIDANCE as never,
  );
  expect(guidanceText).toContain("Run migrations before the deploy step");
  const guidanceMd = renderSkillMarkdown({
    name: "Deploy safety",
    key: "deploy-safety",
    kind: "step_guidance",
    version: 1,
    body: VALID_GUIDANCE as never,
  });
  expect(guidanceMd).toContain("# Deploy safety");
  expect(guidanceMd).toContain("**When:** a deploy includes schema-touching changes");
  const procedureMd = renderSkillMarkdown({
    name: "Release",
    key: "release",
    kind: "procedure",
    version: 2,
    body: VALID_PROCEDURE as never,
  });
  expect(procedureMd).toContain("## Instructions");
  expect(procedureMd).toContain("1. Run the full test suite");
});

test("canonicalizer: create binds v1 with grounding edges, seed score, and ledger; invalid input is rejected and kept in the ledger", async () => {
  const s = await setup();
  const episodeId = await s.addDistilledEpisode("failure");
  const { insightId } = await createMemoryInsight(s.db, {
    workspaceId: s.workspaceId,
    statement: "Migrations before deploys, because drift breaks releases",
  });

  const bound = await submitAndAdmitSkillProposal(s.db, {
    workspaceId: s.workspaceId,
    draft: {
      action: "create",
      key: "deploy-safety",
      name: "Deploy safety",
      kind: "step_guidance",
      body: VALID_GUIDANCE,
      groundingEpisodes: [episodeId],
      groundingInsights: [insightId],
    },
  });
  expect(bound.outcome).toBe("bound");
  if (bound.outcome !== "bound") return;
  expect(bound.version).toBe(1);
  const skill = await s.db.learnedSkill.findUniqueOrThrow({
    where: { workspaceId_key: { workspaceId: s.workspaceId, key: "deploy-safety" } },
    include: { currentRevision: true },
  });
  expect(skill.currentRevisionId).toBe(bound.revisionId);
  const currentRevision = skill.currentRevision!;
  expect(currentRevision.contentDigest).toMatch(/^sha256:/);
  expect(currentRevision.parentRevisionId).toBeNull();
  const groundings = await s.db.skillProposalGrounding.findMany({
    where: { proposalId: bound.proposalId },
    select: { kind: true, targetKey: true },
  });
  expect(groundings.map((g) => g.kind).sort()).toEqual(["episode", "insight"]);
  const seed = await s.db.learnedSkillScoreEvent.findUniqueOrThrow({
    where: {
      workspaceId_operationKey: {
        workspaceId: s.workspaceId,
        operationKey: `seed:${bound.revisionId}`,
      },
    },
  });
  expect(seed.delta).toBe(2);
  const ledger = await recentLedgerEntries(s.db, { workspaceId: s.workspaceId, limit: 10 });
  expect(ledger.map((e) => e.kind)).toContain("proposed");
  expect(ledger.map((e) => e.kind)).toContain("bound");

  // Same key again → rejected, ledger keeps the rejection.
  const dup = await submitAndAdmitSkillProposal(s.db, {
    workspaceId: s.workspaceId,
    draft: {
      action: "create",
      key: "deploy-safety",
      name: "Dup",
      kind: "procedure",
      body: VALID_PROCEDURE,
      groundingEpisodes: [episodeId],
    },
  });
  expect(dup.outcome).toBe("rejected");
  if (dup.outcome === "rejected") expect(dup.reason).toBe("ls-proposal-key-exists");

  // No episode grounding → rejected regardless of kind (procedure included).
  const noGrounding = await submitAndAdmitSkillProposal(s.db, {
    workspaceId: s.workspaceId,
    draft: {
      action: "create",
      key: "no-ground",
      name: "No ground",
      kind: "procedure",
      body: VALID_PROCEDURE,
      groundingInsights: [insightId],
    },
  });
  expect(noGrounding.outcome).toBe("rejected");

  // Schema violation → rejected with the artifact error id.
  const badBody = await submitAndAdmitSkillProposal(s.db, {
    workspaceId: s.workspaceId,
    draft: {
      action: "create",
      key: "bad-body",
      name: "Bad",
      kind: "procedure",
      body: { instructions: [] },
      groundingEpisodes: [episodeId],
    },
  });
  expect(badBody.outcome).toBe("rejected");
  if (badBody.outcome === "rejected") expect(badBody.reason).toBe("ls-artifact-instructions");

  // Superseded (non-head) insight grounding → rejected.
  const { revisionId } = await reviseMemoryInsight(s.db, {
    workspaceId: s.workspaceId,
    insightId,
    statement: "Migrations before deploys v2, because drift breaks releases",
  });
  const staleInsight = await submitAndAdmitSkillProposal(s.db, {
    workspaceId: s.workspaceId,
    draft: {
      action: "create",
      key: "stale-ground",
      name: "Stale",
      kind: "procedure",
      body: VALID_PROCEDURE,
      groundingEpisodes: [episodeId],
      groundingInsights: [insightId],
    },
  });
  expect(staleInsight.outcome).toBe("rejected");
  expect(revisionId).not.toBe(insightId);
});

test("canonicalizer: revise supersedes the head, versions stay monotonic, stale parents are refused", async () => {
  const s = await setup();
  const episodeId = await s.addDistilledEpisode("success");
  const first = await submitAndAdmitSkillProposal(s.db, {
    workspaceId: s.workspaceId,
    draft: {
      action: "create",
      key: "release-flow",
      name: "Release flow",
      kind: "procedure",
      body: VALID_PROCEDURE,
      groundingEpisodes: [episodeId],
    },
  });
  expect(first.outcome).toBe("bound");
  if (first.outcome !== "bound") return;

  const revised = await submitAndAdmitSkillProposal(s.db, {
    workspaceId: s.workspaceId,
    draft: {
      action: "revise",
      targetSkillKey: "release-flow",
      body: { instructions: ["Run the full suite", "Tag", "Announce"] },
      groundingEpisodes: [episodeId],
    },
  });
  expect(revised.outcome).toBe("bound");
  if (revised.outcome !== "bound") return;
  expect(revised.version).toBe(2);
  const v2 = await s.db.learnedSkillRevision.findUniqueOrThrow({
    where: { id: revised.revisionId },
  });
  expect(v2.parentRevisionId).toBe(first.revisionId);
  const skill = await s.db.learnedSkill.findUniqueOrThrow({
    where: { workspaceId_key: { workspaceId: s.workspaceId, key: "release-flow" } },
  });
  expect(skill.currentRevisionId).toBe(revised.revisionId);

  // A stale explicit parent (v1, no longer head) is refused.
  const stale = await submitAndAdmitSkillProposal(s.db, {
    workspaceId: s.workspaceId,
    draft: {
      action: "revise",
      targetSkillKey: "release-flow",
      parentRevisionId: first.revisionId,
      body: VALID_PROCEDURE,
      groundingEpisodes: [episodeId],
    },
  });
  expect(stale.outcome).toBe("rejected");
  if (stale.outcome === "rejected") expect(stale.reason).toBe("ls-proposal-parent-not-head");
});

test("no_action and the proposer pass: one atomic proposal per trigger, idempotent by run row", async () => {
  const s = await setup();
  const failId = await s.addDistilledEpisode("failure");
  const okId = await s.addDistilledEpisode("success");

  const credential = {
    providerId: "lenovo",
    baseUrl: "https://models.example.test/v1",
    model: "test-model",
    reasoning: "",
    apiKey: "test-secret-key-material",
  };
  await saveWorkspaceModelConfiguration(
    s.db,
    { workspaceId: s.workspaceId, userId: s.ownerUserId },
    {
      providerId: credential.providerId,
      baseUrl: credential.baseUrl,
      model: credential.model,
      apiKey: credential.apiKey,
      dailyBudget: 50,
    },
  );

  // Pass 1: propose a create grounded in the failure trace.
  const createPayload = {
    action: "create",
    reason: "failure trace shows the recovery pattern",
    key: "ci-recovery",
    name: "CI recovery",
    kind: "step_guidance",
    body: VALID_GUIDANCE,
    grounding_episodes: [failId],
  };
  const first = await runProposalPass(s.db, new StaticLlm(createPayload), {
    workspaceId: s.workspaceId,
    triggerCount: 2,
    credential,
  });
  expect(first.ran).toBe(true);
  expect(first.outcome).toBe("bound");

  // Same trigger again: the run row says this pass already landed.
  const replay = await runProposalPass(s.db, new StaticLlm(createPayload), {
    workspaceId: s.workspaceId,
    triggerCount: 2,
    credential,
  });
  expect(replay.ran).toBe(false);

  // Pass 2 (new trigger): propose a revision grounded in the success trace.
  const revisePayload = {
    action: "revise",
    reason: "success trace confirms the fast path",
    target_skill_key: "ci-recovery",
    body: VALID_GUIDANCE,
    grounding_episodes: [okId],
  };
  const second = await runProposalPass(s.db, new StaticLlm(revisePayload), {
    workspaceId: s.workspaceId,
    triggerCount: 4,
    credential,
  });
  expect(second.outcome).toBe("bound");
  const skill = await s.db.learnedSkill.findUniqueOrThrow({
    where: { workspaceId_key: { workspaceId: s.workspaceId, key: "ci-recovery" } },
  });
  const versions = await s.db.learnedSkillRevision.findMany({
    where: { skillId: skill.id },
    orderBy: { version: "asc" },
  });
  expect(versions.map((r) => r.version)).toEqual([1, 2]);
  expect(versions[1]!.parentRevisionId).toBe(versions[0]!.id);

  // Pass 3: no_action lands in the ledger.
  const third = await runProposalPass(
    s.db,
    new StaticLlm({ action: "no_action", reason: "nothing new" }),
    { workspaceId: s.workspaceId, triggerCount: 6, credential },
  );
  expect(third.outcome).toBe("no_action");
  const ledger = await recentLedgerEntries(s.db, { workspaceId: s.workspaceId, limit: 5 });
  expect(ledger.some((entry) => entry.kind === "no_action")).toBe(true);

  // A proposer garbage payload degrades to a recorded no_action, never a crash.
  const garbage = await runProposalPass(s.db, new StaticLlm("not json"), {
    workspaceId: s.workspaceId,
    triggerCount: 8,
    credential,
  });
  expect(garbage.outcome).toBe("no_action");

  // The ledger helper is directly callable too.
  await recordNoActionProposal(s.db, { workspaceId: s.workspaceId });
  expect(true).toBe(true);
});
