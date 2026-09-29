import { join } from "node:path";
import { workspaceProfileToToolFence } from "../../../packages/coforge-sdk/src/agent/memory-tool-fences.ts";
import { EVAL_FLAG, evalOptedIn, loadEvalEnv } from "./env";
import { controlAgent, startAgent, startEvalDaemon, type EvalDaemon } from "./eval-daemon";
import { runEpisode } from "./eval-qa";
import { createEvalDispatcher, drainEpisodeToMemory } from "./ingest";
import { episodesForArm, groupFamilies, loadManifest } from "./manifest";
import { profileFor, reminderForEpisode } from "./benchmarks";
import { classifyMechanism } from "./leak";
import { createAttemptWriter, summarizeArm, writeSummary } from "./report";
import { sanitizeDiagnostic } from "../../public-channel-memory/src/sanitize";
import {
  createEvalRuntime,
  deleteDisposableAccount,
  forgetEvalAccountKey,
  provisionDisposableAccount,
  readSecretRootKey,
  rememberEvalAccountKey,
  rootIdentity,
} from "../../public-channel-memory/src/ov";
import {
  connectEvalDb,
  destroyEvalWorkspace,
  provisionEvalWorkspace,
  type EvalWorkspace,
} from "./workspace";
import type { ArmSummary, AttemptRow, EpisodeFamily, ManifestEpisode } from "./types";

if (!evalOptedIn()) {
  console.log(`evolbench collaboration eval skipped: set ${EVAL_FLAG}=1`);
  process.exit(0);
}

const env = loadEvalEnv();
Bun.env.COFORGE_EVAL_DISABLE_HOST_PI_INJECTION = "1";
process.env.COFORGE_EVAL_DISABLE_HOST_PI_INJECTION = "1";
const manifest = await loadManifest(env.manifestPath, env.episodeMod);
const benchmark = env.manifestBenchmark ?? manifest[0]!.benchmark;
const profile = profileFor(benchmark);
const episodeTimeoutMs = env.episodeTimeoutMs ?? profile.episodeTimeoutMs;
const settleMs = env.settleMs ?? profile.settleMs;
const families = groupFamilies(manifest).filter(
  (family) => env.families.length === 0 || env.families.includes(family.familyId),
);
if (families.length === 0) throw new Error("no families selected");
console.log(
  sanitizeDiagnostic(
    `benchmark=${benchmark} manifest=${env.manifestPath} episodes=${manifest.length} mod=${env.episodeMod ?? "-"} families=${families.map((family) => family.familyId).join("|")} arms=${env.arms.join(",")} agents=${env.memoryAgentProvider}/${env.memoryAgentModel}+${env.taskAgentProvider}/${env.taskAgentModel} timeout=${episodeTimeoutMs}ms settle=${settleMs}ms closure=${env.episodeClosure}`,
  ),
);
Bun.env.OPENVIKING_PROTOTYPE_ENABLED = "1";
Bun.env.COFORGE_OPENVIKING_ACCOUNT_KEYS_FILE ??= "/tmp/pcm-eval-ov-keys.json";

const runtime = createEvalRuntime(env.ovUrl);
const rootKey = await readSecretRootKey(env.ovConfPath);
const root = rootIdentity(rootKey);
const db = connectEvalDb(env.databaseUrl);
const writer = await createAttemptWriter(
  env.resultDir,
  env.evaluationId,
  (Bun.env.COFORGE_EVAL_RESUME ?? "0") === "1",
);
if (writer.completedRunIds.size > 0) {
  console.log(sanitizeDiagnostic(`resume: ${writer.completedRunIds.size} episodes already recorded, skipping them`));
}
const summaries: ArmSummary[] = [];

function runIdFor(arm: "warm" | "cold", episodeId: string): string {
  return `${env.evaluationId}:${episodeId}:${env.seed}:${arm}`;
}

function attemptRow(input: {
  arm: "warm" | "cold";
  family: EpisodeFamily;
  episode: ManifestEpisode;
  workDir: string;
  finalOutput: string | null;
  citationCount: number;
  timedOut: boolean;
  elapsedMs: number;
  mechanism: string;
  error: string | null;
}): AttemptRow {
  const { episode } = input;
  return {
    run_id: runIdFor(input.arm, episode.episodeId),
    benchmark: episode.benchmark || benchmark,
    task_id: episode.taskId,
    episode_id: episode.episodeId,
    family_id: episode.familyId,
    domain: episode.domain,
    arm: input.arm,
    memory_policy: input.arm === "warm" ? "read_write" : "no_shared_memory",
    seed: env.seed,
    attempt: 1,
    status: input.finalOutput?.trim() ? "success" : "failure",
    duration_seconds: Number((input.elapsedMs / 1000).toFixed(1)),
    work_dir: input.workDir,
    final_output: input.finalOutput ?? "",
    recall_state: input.citationCount > 0 ? "cited" : input.timedOut ? "empty" : "offered",
    recall_citations: input.citationCount,
    mechanism: input.mechanism,
    task_message_count: 0,
    memory_leak_count: 0,
    error: input.error,
  };
}

type FamilyWorkspace = {
  accountId: string;
  workspace: EvalWorkspace;
  daemon: EvalDaemon;
  agentWorkspaceDir: string;
  dispatcher: ReturnType<typeof createEvalDispatcher>;
};

async function provisionFamily(
  arm: "warm" | "cold",
  family: EpisodeFamily,
): Promise<FamilyWorkspace> {
  const health = await fetch(new URL("/health", env.ovUrl));
  if (health.status !== 200) throw new Error(`openviking /health ${health.status}`);
  const accountId = `evol-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const users = await provisionDisposableAccount(runtime, root, accountId);
  await rememberEvalAccountKey(accountId, users.adminKey);
  const workspace = await provisionEvalWorkspace({
    db,
    arm,
    familyId: family.familyId,
    benchmark: family.benchmark || benchmark,
    ovAccountId: accountId,
  });
  const dispatcher = createEvalDispatcher({ workspace, runtime, accountId, users });
  const daemon = await startEvalDaemon({ workspace, env });
  await startAgent(workspace, workspace.memoryAgentId, workspaceProfileToToolFence("openviking"));
  await startAgent(workspace, workspace.taskAgentId);
  return {
    accountId,
    workspace,
    daemon,
    dispatcher,
    agentWorkspaceDir: join(
      daemon.workspaceRoot,
      workspace.workspaceId,
      "agents",
      workspace.taskAgentId,
    ),
  };
}

async function releaseFamily(provisioned: FamilyWorkspace): Promise<void> {
  await provisioned.daemon.stop().catch(() => undefined);
  await destroyEvalWorkspace(provisioned.workspace);
  await forgetEvalAccountKey(provisioned.accountId).catch(() => undefined);
  await deleteDisposableAccount(runtime, root, provisioned.accountId).catch((error) => {
    console.warn(sanitizeDiagnostic(`ov account cleanup failed: ${String(error)}`));
  });
}

async function executeEpisode(
  arm: "warm" | "cold",
  family: EpisodeFamily,
  episode: ManifestEpisode,
  provisioned: FamilyWorkspace,
): Promise<AttemptRow> {
  if (env.episodeClosure && arm === "warm") {
    // Fresh session per episode: recall + prompt only, no cross-episode model
    // context. The cold arm gets a whole fresh workspace anyway. Do NOT use
    // the managed reset-session chain: its restart start intent is rebuilt
    // server-side without the fence, so the memory agent relaunches with bash.
    // Stop + clear the session pointer + explicit fenced start instead.
    for (const agentId of [
      provisioned.workspace.memoryAgentId,
      provisioned.workspace.taskAgentId,
    ]) {
      await controlAgent(provisioned.workspace, agentId, "stop", undefined).catch((error) => {
        console.warn(
          sanitizeDiagnostic(`closure stop failed for ${episode.episodeId}: ${String(error)}`),
        );
      });
      await provisioned.workspace.db.agent.update({
        where: { id: agentId },
        data: { currentSessionId: null },
      });
    }
    await startAgent(
      provisioned.workspace,
      provisioned.workspace.memoryAgentId,
      workspaceProfileToToolFence("openviking"),
    );
    await startAgent(provisioned.workspace, provisioned.workspace.taskAgentId);
  }
  const reminder = reminderForEpisode(episode.benchmark || benchmark, episode.domain);
  const result = await runEpisode({
    workspace: provisioned.workspace,
    env,
    episode,
    reminder,
    episodeTimeoutMs,
    settleMs,
  });
  const mechanism = classifyMechanism(result);
  let sidecarVerification: AttemptRow["sidecar_verification"] | undefined;
  if (env.verifySidecarUrl) {
    try {
      const response = await fetch(new URL("/verify", env.verifySidecarUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ episode_id: episode.episodeId }),
      });
      const verdict = (await response.json()) as {
        episode_id?: string;
        reward?: number;
        graded?: boolean;
        error?: string;
      };
      sidecarVerification = {
        episode_id: episode.episodeId,
        reward: Number(verdict.reward ?? 0),
        graded: Boolean(verdict.graded),
        error: verdict.error ?? null,
      };
      console.log(sanitizeDiagnostic(
        `${arm} ${episode.episodeId} sidecar reward=${sidecarVerification.reward} graded=${sidecarVerification.graded}`,
      ));
    } catch (error) {
      console.warn(sanitizeDiagnostic(`sidecar verify failed for ${episode.episodeId}: ${String(error)}`));
    }
  }
  const row = attemptRow({
    arm,
    family,
    episode,
    workDir: provisioned.agentWorkspaceDir,
    finalOutput: result.finalOutput,
    citationCount: result.citationCount,
    timedOut: result.timedOut,
    elapsedMs: result.elapsedMs,
    mechanism,
    error: result.timedOut ? "episode timeout" : null,
  });
  row.task_message_count = result.taskMessageCount;
  row.memory_leak_count = result.memoryLeakMessageIds.length;
  if (sidecarVerification) row.sidecar_verification = sidecarVerification;
  if (arm === "warm") {
    const drained = await drainEpisodeToMemory({
      workspace: provisioned.workspace,
      dispatcher: provisioned.dispatcher,
      channelName: family.familyId.toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 50) || "evol",
    });
    console.log(
      sanitizeDiagnostic(
        `${arm} ${episode.episodeId} mechanism=${mechanism} citations=${result.citationCount} drained=${drained}`,
      ),
    );
  } else {
    console.log(
      sanitizeDiagnostic(
        `${arm} ${episode.episodeId} mechanism=${mechanism} citations=${result.citationCount}`,
      ),
    );
  }
  await writer.append(row);
  return row;
}

try {
  for (const arm of env.arms) {
    const armRows: AttemptRow[] = [];
    for (const family of families) {
      const episodes = episodesForArm(family, arm);
      if (episodes.length === 0) continue;
      if (arm === "warm") {
        const provisioned = await provisionFamily(arm, family);
        try {
          for (const episode of episodes) {
            if (writer.completedRunIds.has(runIdFor(arm, episode.episodeId))) continue;
            armRows.push(await executeEpisode(arm, family, episode, provisioned));
          }
        } finally {
          await releaseFamily(provisioned);
        }
      } else {
        for (const episode of episodes) {
          if (writer.completedRunIds.has(runIdFor(arm, episode.episodeId))) continue;
          const provisioned = await provisionFamily(arm, family);
          try {
            armRows.push(await executeEpisode(arm, family, episode, provisioned));
          } finally {
            await releaseFamily(provisioned);
          }
        }
      }
    }
    summaries.push(summarizeArm(arm, armRows));
  }
  const summaryPath = await writeSummary({ resultDir: env.resultDir, evaluationId: env.evaluationId, summaries });
  console.log(sanitizeDiagnostic(`wrote ${writer.path}`));
  console.log(sanitizeDiagnostic(`wrote ${summaryPath}`));
} finally {
  // Known quirk inherited from the sibling evals: prisma $disconnect can hang
  // after results are written; the launcher watchdog pkills the process once
  // it logs `wrote ...-attempts.jsonl`.
  await db.$disconnect();
}
