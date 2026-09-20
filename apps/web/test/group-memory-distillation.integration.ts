import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/client";
import { isAppError } from "../src/lib/app-error";
import { admitMemoryEpisode } from "../src/server/group-memory/memory-episodes.server";
/** Designation-row stand-in for the enablement lifecycle (ADR 0052-H, slice 4). */
async function enableGroupMemory(
  db: PrismaClient,
  input: { workspaceId: string; ownerId: string },
): Promise<void> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const agent = await db.agent.create({
    data: {
      workspaceId: input.workspaceId,
      name: `memory-${suffix}`,
      displayName: `Memory ${suffix}`,
      ownerId: input.ownerId,
      runtimeConfig: {},
    },
  });
  await db.memoryAgentDesignation.create({
    data: { workspaceId: input.workspaceId, agentId: agent.id },
  });
}
import {
  createMemoryInsight,
  listActiveMemoryInsights,
  liveMemoryScore,
  recordMemoryScoreEvent,
} from "../src/server/group-memory/memory-insights.server";
import {
  distillPendingEpisodes,
  runCritiquePass,
  runMergePass,
  sweepMemoryDistillation,
} from "../src/server/group-memory/memory-distillation.server";
import type { DistillationLlm } from "../src/server/group-memory/distillation-llm.server";
import {
  deleteWorkspaceModelConfiguration,
  reserveModelCall,
  resolveWorkspaceModelCredential,
  saveWorkspaceModelConfiguration,
  workspaceModelConfigurationSummary,
} from "../src/server/group-memory/workspace-model-configuration.server";

/**
 * Group Memory distillation worker against local PostgreSQL (ADR 0053 slice 3
 * + ADR 0052): the outcome pass over admitted episodes, the critique pass's
 * AGREE/REMOVE/EDIT/ADD application over immutable insight storage, the merge
 * pass over similarity-seam pairs, the daily budget gate, the pass-ledger
 * idempotency, and the Workspace model configuration's fencing. All model
 * responses come from a scripted fixture — golden flows, no live model.
 *
 * Runs via `mise run test:memory` with MEMORY_TEST_DATABASE_URL pointing at
 * a scratch database.
 */

process.env.COFORGE_AGENT_CREDENTIAL_ENCRYPTION_KEY ??=
  "5b2f1c9d4e7a8630b1d5f8c2e9a47063d8b6f1c3a5e72904b6d8f1a3c5e79062";

let client: PrismaClient | undefined;

function getDb(): PrismaClient {
  if (client) return client;
  const connectionString = Bun.env.MEMORY_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("MEMORY_TEST_DATABASE_URL must point at local PostgreSQL");
  client = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  return client;
}

const CREDENTIAL = {
  providerId: "lenovo",
  baseUrl: "https://models.example.test/v1",
  model: "test-model",
  reasoning: "",
  apiKey: "test-secret-key-material",
};

/** Routes by prompt shape: outcome verdict, critique operations, or merged rules. */
class RoutingLlm implements DistillationLlm {
  readonly calls: Array<{ system: string; user: string }> = [];
  constructor(
    private readonly outcome: (index: number) => unknown,
    private readonly critique: (call: { system: string; user: string }) => unknown,
    private readonly merge: () => unknown,
  ) {}
  async completeJson<T>(request: {
    messages: Array<{ role: string; content: string }>;
  }): Promise<T> {
    const system = request.messages[0]?.content ?? "";
    const user = request.messages[1]?.content ?? "";
    this.calls.push({ system, user });
    if (system.includes("Skill Proposer")) return { action: "no_action" } as T;
    if (system.includes("reviewing one completed slice"))
      return this.outcome(this.calls.length) as T;
    if (system.includes("add, edit, remove, or agree")) return this.critique({ system, user }) as T;
    if (system.includes("summarizing and distilling insights")) return this.merge() as T;
    throw new Error("unexpected distillation prompt");
  }
}

async function setup(options?: { configure?: boolean; dailyBudget?: number }) {
  const db = getDb();
  const suffix = crypto.randomUUID().slice(0, 8);
  const user = await db.user.create({ data: { username: `dist-owner-${suffix}` } });
  const member = await db.user.create({ data: { username: `dist-member-${suffix}` } });
  const workspace = await db.workspace.create({
    data: {
      slug: `dist-${suffix}`,
      name: "Distillation Test",
      members: {
        create: [
          { userId: user.id, role: "owner" },
          { userId: member.id, role: "member" },
        ],
      },
    },
  });
  // Distillation sweeps run only where Group Memory is enabled (ADR 0052-H).
  await enableGroupMemory(db, { workspaceId: workspace.id, ownerId: user.id });
  if (options?.configure !== false) {
    await saveWorkspaceModelConfiguration(
      db,
      { workspaceId: workspace.id, userId: user.id },
      {
        providerId: CREDENTIAL.providerId,
        baseUrl: CREDENTIAL.baseUrl,
        model: CREDENTIAL.model,
        apiKey: CREDENTIAL.apiKey,
        dailyBudget: options?.dailyBudget,
      },
    );
  }
  const conversation = await db.conversation.create({
    data: { workspaceId: workspace.id, channelName: `dist-${suffix}` },
  });
  let sequence = 0;
  const admit = async (body: string) => {
    sequence += 3;
    return admitMemoryEpisode(db, {
      workspaceId: workspace.id,
      conversationId: conversation.id,
      kind: "quiet_window",
      startSequence: sequence - 2,
      endSequence: sequence,
      title: `slice ${sequence / 3}`,
      body,
    });
  };
  return {
    db,
    workspaceId: workspace.id,
    ownerUserId: user.id,
    memberUserId: member.id,
    admit,
  };
}

test("Workspace model configuration: owner saves, member is refused, resolution is purpose-fenced", async () => {
  const s = await setup({ configure: false });
  try {
    await saveWorkspaceModelConfiguration(
      s.db,
      { workspaceId: s.workspaceId, userId: s.memberUserId },
      {
        providerId: CREDENTIAL.providerId,
        baseUrl: CREDENTIAL.baseUrl,
        model: CREDENTIAL.model,
        apiKey: CREDENTIAL.apiKey,
      },
    );
    throw new Error("expected ACCESS_DENIED");
  } catch (error) {
    expect(isAppError(error)).toBe(true);
    expect((error as { code: string }).code).toBe("ACCESS_DENIED");
  }
  await saveWorkspaceModelConfiguration(
    s.db,
    { workspaceId: s.workspaceId, userId: s.ownerUserId },
    {
      providerId: CREDENTIAL.providerId,
      baseUrl: CREDENTIAL.baseUrl,
      model: CREDENTIAL.model,
      reasoning: "high",
      apiKey: CREDENTIAL.apiKey,
      dailyBudget: 7,
    },
  );
  const summary = await workspaceModelConfigurationSummary(s.db, s.workspaceId);
  expect(summary?.model).toBe(CREDENTIAL.model);
  expect(summary?.apiKeyHint).toBe(`••••${CREDENTIAL.apiKey.slice(-4)}`);
  expect(summary?.apiKeyHint).not.toContain(CREDENTIAL.apiKey);
  const resolved = await resolveWorkspaceModelCredential(
    s.db,
    s.workspaceId,
    "group_memory_distillation",
  );
  expect(resolved?.apiKey).toBe(CREDENTIAL.apiKey);
  expect(resolved?.model).toBe(CREDENTIAL.model);
  const raw = await s.db.workspaceModelConfiguration.findUnique({
    where: { workspaceId: s.workspaceId },
  });
  expect(JSON.stringify(raw?.apiKey)).not.toContain(CREDENTIAL.apiKey);
  await deleteWorkspaceModelConfiguration(s.db, {
    workspaceId: s.workspaceId,
    userId: s.ownerUserId,
  });
  expect(
    await resolveWorkspaceModelCredential(s.db, s.workspaceId, "group_memory_distillation"),
  ).toBeUndefined();
});

test("the daily budget gate counts per UTC day and refuses beyond the cap", async () => {
  const s = await setup({ dailyBudget: 2 });
  const now = new Date("2026-09-20T22:30:00Z");
  const first = await reserveModelCall(s.db, {
    workspaceId: s.workspaceId,
    purpose: "group_memory_distillation",
    now,
  });
  const second = await reserveModelCall(s.db, {
    workspaceId: s.workspaceId,
    purpose: "group_memory_distillation",
    now,
  });
  const third = await reserveModelCall(s.db, {
    workspaceId: s.workspaceId,
    purpose: "group_memory_distillation",
    now,
  });
  expect(first.allowed).toBe(true);
  expect(second.allowed).toBe(true);
  expect(third.allowed).toBe(false);
  if (third.allowed === false) expect(third.budget).toBe(2);
  const nextDay = await reserveModelCall(s.db, {
    workspaceId: s.workspaceId,
    purpose: "group_memory_distillation",
    now: new Date("2026-09-21T00:30:00Z"),
  });
  expect(nextDay.allowed).toBe(true);
});

test("the outcome pass stamps success and failure episodes with reason and key steps", async () => {
  const s = await setup();
  const first = await s.admit("alice: the pipeline is green\nbob: merged the release");
  const second = await s.admit("alice: the deploy failed\nbob: rolled back");
  const llm = new RoutingLlm(
    (index) =>
      index === 1
        ? {
            outcome: "success",
            reason: "release merged and verified",
            keySteps: "build, test, merge",
          }
        : {
            outcome: "failure",
            reason: "deploy crashed and was rolled back",
            keySteps: "deploy, rollback",
          },
    () => ({ operations: [] }),
    () => ({ merged: [] }),
  );
  const credential = (await resolveWorkspaceModelCredential(
    s.db,
    s.workspaceId,
    "group_memory_distillation",
  ))!;
  const result = await distillPendingEpisodes(s.db, llm, {
    workspaceId: s.workspaceId,
    credential,
  });
  expect(result).toEqual({ distilled: 2, budgetExhausted: false });
  const successRow = await s.db.memoryEpisode.findUniqueOrThrow({ where: { id: first.episodeId } });
  const failureRow = await s.db.memoryEpisode.findUniqueOrThrow({
    where: { id: second.episodeId },
  });
  expect(successRow.outcome).toBe("success");
  expect(successRow.outcomeReason).toBe("release merged and verified");
  expect(successRow.keySteps).toBe("build, test, merge");
  expect(failureRow.outcome).toBe("failure");
  expect(failureRow.outcomeReason).toBe("deploy crashed and was rolled back");

  const again = await distillPendingEpisodes(s.db, llm, { workspaceId: s.workspaceId, credential });
  expect(again).toEqual({ distilled: 0, budgetExhausted: false });
  expect(llm.calls.length).toBe(2);
});

test("the critique pass applies AGREE/REMOVE/EDIT/ADD and is idempotent by trigger count", async () => {
  const s = await setup({ dailyBudget: 50 });
  const episodes: string[] = [];
  for (let index = 0; index < 3; index += 1) {
    const admitted = await s.admit(`slice ${index} body text`);
    await s.db.memoryEpisode.update({
      where: { id: admitted.episodeId },
      data: {
        outcome: index === 1 ? "failure" : "success",
        outcomeReason: index === 1 ? "the release broke" : "shipped fine",
        keySteps: `steps ${index}`,
        distilledAt: new Date(),
      },
    });
    episodes.push(admitted.episodeId);
  }
  const first = await createMemoryInsight(s.db, {
    workspaceId: s.workspaceId,
    statement: "Always run migrations before deploys, because state drift breaks releases",
  });
  const second = await createMemoryInsight(s.db, {
    workspaceId: s.workspaceId,
    statement: "Never hotfix production, because audit trails are lost",
  });
  const third = await createMemoryInsight(s.db, {
    workspaceId: s.workspaceId,
    statement: "Duplicate rule that should be removed, because it overlaps another",
  });
  const llm = new RoutingLlm(
    () => ({}),
    (call) =>
      call.user.includes("Failed reason")
        ? {
            operations: [
              {
                op: "ADD",
                statement: "Pin the deploy window to mornings, because fewer people are online",
              },
              { op: "AGREE", index: 1 },
              {
                op: "EDIT",
                index: 2,
                statement:
                  "Never hotfix production directly, because audit trails are lost and rollbacks get messy",
              },
              { op: "REMOVE", index: 3 },
              { op: "AGREE", index: 3 },
            ],
          }
        : { operations: [] },
    () => ({ merged: [] }),
  );
  const credential = (await resolveWorkspaceModelCredential(
    s.db,
    s.workspaceId,
    "group_memory_distillation",
  ))!;
  const pass = await runCritiquePass(s.db, llm, {
    workspaceId: s.workspaceId,
    triggerCount: 1,
    credential,
  });
  expect(pass.ran).toBe(true);

  // Active insights are ordered score DESC, statement ASC — the same order the
  // prompt numbers them by. So: 1 = "Always run migrations…" (first),
  // 2 = "Duplicate rule…" (third), 3 = "Never hotfix…" (second).
  expect(
    await liveMemoryScore(s.db, { workspaceId: s.workspaceId, insightId: first.insightId }),
  ).toBe(2);
  const edited = await s.db.memoryInsight.findUniqueOrThrow({ where: { id: third.insightId } });
  expect(edited.supersededById).not.toBeNull();
  const revision = await s.db.memoryInsight.findUniqueOrThrow({
    where: { id: edited.supersededById! },
  });
  expect(revision.statement).toContain("rollbacks get messy");
  expect(await liveMemoryScore(s.db, { workspaceId: s.workspaceId, insightId: revision.id })).toBe(
    2,
  );
  expect(
    await liveMemoryScore(s.db, { workspaceId: s.workspaceId, insightId: second.insightId }),
  ).toBe(0);
  const active = await listActiveMemoryInsights(s.db, { workspaceId: s.workspaceId });
  expect(active.map((insight) => insight.statement)).toContain(
    "Pin the deploy window to mornings, because fewer people are online",
  );
  expect(active.find((insight) => insight.id === second.insightId)).toBeUndefined();

  const runRow = await s.db.memoryDistillationRun.findUnique({
    where: {
      workspaceId_kind_triggerCount: {
        workspaceId: s.workspaceId,
        kind: "critique",
        triggerCount: 1,
      },
    },
  });
  expect(runRow).not.toBeNull();

  const scoreEventsBefore = await s.db.memoryScoreEvent.count({
    where: { workspaceId: s.workspaceId },
  });
  const replay = await runCritiquePass(s.db, llm, {
    workspaceId: s.workspaceId,
    triggerCount: 1,
    credential,
  });
  expect(replay.ran).toBe(false);
  expect(await s.db.memoryScoreEvent.count({ where: { workspaceId: s.workspaceId } })).toBe(
    scoreEventsBefore,
  );
  expect(
    llm.calls.filter((call) => call.system.includes("add, edit, remove, or agree")).length,
  ).toBeGreaterThan(0);
  expect(episodes.length).toBe(3);
});

test("the merge pass consolidates similar insight pairs through the similarity seam", async () => {
  const s = await setup({ dailyBudget: 50 });
  const left = await createMemoryInsight(s.db, {
    workspaceId: s.workspaceId,
    statement: "Back up the database nightly before cleanup",
  });
  const right = await createMemoryInsight(s.db, {
    workspaceId: s.workspaceId,
    statement: "Back up the database nightly after cleanup",
  });
  await createMemoryInsight(s.db, {
    workspaceId: s.workspaceId,
    statement: "Rotate the API keys quarterly",
  });
  await recordMemoryScoreEvent(s.db, {
    workspaceId: s.workspaceId,
    insightId: right.insightId,
    delta: 2,
    reason: "critique_agree",
    operationKey: "setup:agree",
  });
  const llm = new RoutingLlm(
    () => ({}),
    () => ({ operations: [] }),
    () => ({
      merged: [
        "Back up the database nightly around the cleanup window, because both timings protect against data loss",
      ],
    }),
  );
  const credential = (await resolveWorkspaceModelCredential(
    s.db,
    s.workspaceId,
    "group_memory_distillation",
  ))!;
  const pass = await runMergePass(s.db, llm, {
    workspaceId: s.workspaceId,
    triggerCount: 1,
    credential,
  });
  expect(pass.ran).toBe(true);
  const leftRow = await s.db.memoryInsight.findUniqueOrThrow({ where: { id: left.insightId } });
  expect(leftRow.supersededById).not.toBeNull();
  const mergedRow = await s.db.memoryInsight.findUniqueOrThrow({ where: { id: right.insightId } });
  expect(mergedRow.supersededById).not.toBeNull();
  const head = await s.db.memoryInsight.findUniqueOrThrow({
    where: { id: mergedRow.supersededById! },
  });
  expect(head.statement).toContain("around the cleanup window");
  expect(leftRow.supersededById).toBe(head.id);
  expect(await liveMemoryScore(s.db, { workspaceId: s.workspaceId, insightId: head.id })).toBe(4);
  const replay = await runMergePass(s.db, llm, {
    workspaceId: s.workspaceId,
    triggerCount: 1,
    credential,
  });
  expect(replay.ran).toBe(false);
  expect(
    llm.calls.filter((call) => call.system.includes("summarizing and distilling")).length,
  ).toBe(1);
});

test("a full sweep distills episodes, trips the critique cadence, and survives a re-run", async () => {
  const s = await setup({ dailyBudget: 50 });
  for (let index = 0; index < 5; index += 1) await s.admit(`team slice ${index}`);
  const llm = new RoutingLlm(
    () => ({ outcome: "success", reason: "work completed", keySteps: "did the thing" }),
    () => ({
      operations: [{ op: "ADD", statement: "Prefer morning deploys, because staging is quiet" }],
    }),
    () => ({ merged: [] }),
  );
  await sweepMemoryDistillation(s.db, llm);
  expect(
    await s.db.memoryEpisode.count({ where: { workspaceId: s.workspaceId, distilledAt: null } }),
  ).toBe(0);
  const critiqueRun = await s.db.memoryDistillationRun.findUnique({
    where: {
      workspaceId_kind_triggerCount: {
        workspaceId: s.workspaceId,
        kind: "critique",
        triggerCount: 1,
      },
    },
  });
  expect(critiqueRun).not.toBeNull();
  const active = await listActiveMemoryInsights(s.db, { workspaceId: s.workspaceId });
  expect(active.map((insight) => insight.statement)).toContain(
    "Prefer morning deploys, because staging is quiet",
  );

  const llmCallsBefore = llm.calls.length;
  await sweepMemoryDistillation(s.db, llm);
  expect(llm.calls.length).toBe(llmCallsBefore);
});

test("budget exhaustion pauses distillation for the day without failing the sweep", async () => {
  const s = await setup({ dailyBudget: 3 });
  await s.admit("slice one");
  await s.admit("slice two");
  await s.admit("slice three");
  await s.admit("slice four");
  const llm = new RoutingLlm(
    () => ({ outcome: "success", reason: "done", keySteps: "steps" }),
    () => ({ operations: [] }),
    () => ({ merged: [] }),
  );
  await sweepMemoryDistillation(s.db, llm);
  const distilled = await s.db.memoryEpisode.count({
    where: { workspaceId: s.workspaceId, distilledAt: { not: null } },
  });
  expect(distilled).toBe(3);
  const remaining = await s.db.memoryEpisode.count({
    where: { workspaceId: s.workspaceId, distilledAt: null },
  });
  expect(remaining).toBe(1);
});
