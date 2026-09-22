import { workspaceProfileToToolFence } from "../../../packages/coforge-sdk/src/agent/memory-tool-fences.ts";
import { startCausalHost, type CausalHost } from "./causal-host";
import { EVAL_FLAG, evalOptedIn, loadEvalEnv } from "./env";
import { startEvalDaemon, startMemoryAgent, type EvalDaemon } from "./eval-daemon";
import { evaluateQuestion } from "./eval-qa";
import { createEvalDispatcher, ingestSample } from "./ingest";
import { gradeReply } from "./judge";
import { loadLocomoSample } from "./locomo";
import { writeResults, summarizeArm } from "./report";
import { sanitizeDiagnostic } from "./sanitize";
import {
  createEvalRuntime,
  deleteDisposableAccount,
  forgetEvalAccountKey,
  provisionDisposableAccount,
  readSecretRootKey,
  rememberEvalAccountKey,
  rootIdentity,
  rotateEvalAdminKey,
} from "./ov";
import {
  connectEvalDb,
  destroyEvalWorkspace,
  provisionEvalWorkspace,
  resetMemoryAgentSession,
  type EvalWorkspace,
} from "./workspace";
import type { ArmSummary, EvalAttempt } from "./types";

if (!evalOptedIn()) {
  console.log(`public-channel memory eval skipped: set ${EVAL_FLAG}=1`);
  process.exit(0);
}

const env = loadEvalEnv();
if (env.qaLimit < 1) throw new Error("COFORGE_EVAL_QA_LIMIT must be >= 1");
Bun.env.COFORGE_EVAL_DISABLE_HOST_PI_INJECTION = "1";
process.env.COFORGE_EVAL_DISABLE_HOST_PI_INJECTION = "1";
console.log(
  sanitizeDiagnostic(
    `memory agent ${env.memoryAgentProvider}/${env.memoryAgentModel}; judge ${env.judgeModel}`,
  ),
);
Bun.env.OPENVIKING_PROTOTYPE_ENABLED = "1";
Bun.env.COFORGE_OPENVIKING_ACCOUNT_KEYS_FILE ??= "/tmp/pcm-eval-ov-keys.json";
Bun.env.COFORGE_CAUSAL_MEMORY_URL ??= "http://127.0.0.1:9938";
Bun.env.COFORGE_CAUSAL_MEMORY_TENANT_TOKENS_FILE ??= "/tmp/pcm-eval-causal/tenant-tokens.json";

const sample = await loadLocomoSample(env.locomoPath, env.sampleId, env.qaLimit);
const runtime = createEvalRuntime(env.ovUrl);
const rootKey = await readSecretRootKey(env.ovConfPath);
const root = rootIdentity(rootKey);
const db = connectEvalDb(env.databaseUrl);
const attempts: EvalAttempt[] = [];
const summaries: ArmSummary[] = [];

async function runArm(arm: (typeof env.arms)[number]) {
  let accountId = `pcm-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  let workspace: EvalWorkspace | undefined;
  let provisioned = false;
  let causal: CausalHost | undefined;
  let daemon: EvalDaemon | undefined;
  try {
    const health = await fetch(new URL("/health", env.ovUrl));
    if (health.status !== 200) throw new Error(`openviking /health ${health.status}`);
    const resumeAccount = Bun.env.COFORGE_EVAL_OV_ACCOUNT?.trim();
    const reuseAccount = arm === "openviking" && resumeAccount ? resumeAccount : undefined;
    if (reuseAccount) accountId = reuseAccount;
    const users = reuseAccount
      ? await rotateEvalAdminKey(runtime, root, accountId)
      : await provisionDisposableAccount(runtime, root, accountId);
    provisioned = !reuseAccount;
    await rememberEvalAccountKey(accountId, users.adminKey);
    workspace = await provisionEvalWorkspace({
      db,
      arm,
      sample,
      ovAccountId: accountId,
      memoryAgentProvider: env.memoryAgentProvider,
      memoryAgentModel: env.memoryAgentModel,
    });
    console.log(
      sanitizeDiagnostic(
        `${arm} workspace=${workspace.workspaceId} channel=${workspace.channelId} memoryAgent=${workspace.memoryAgentId} recipient=${workspace.recipientAgentId}`,
      ),
    );
    if (arm === "causal_openviking") {
      causal = await startCausalHost({
        workspaceId: workspace.workspaceId,
        url: Bun.env.COFORGE_CAUSAL_MEMORY_URL ?? "http://127.0.0.1:9938",
      });
      console.log(sanitizeDiagnostic(`${arm} causal-memory ${causal.url}`));
    }
    const dispatcher = createEvalDispatcher({
      workspace,
      runtime,
      accountId,
      users,
    });
    const fromSession =
      arm === "openviking" ? Number(Bun.env.COFORGE_EVAL_INGEST_FROM_SESSION ?? "1") : 1;
    const ingested = await ingestSample({
      workspace,
      sample,
      dispatcher,
      fromSession: Number.isFinite(fromSession) && fromSession > 0 ? fromSession : 1,
    });
    daemon = await startEvalDaemon({ workspace, arm, env });
    await resetMemoryAgentSession(workspace);
    await startMemoryAgent(workspace, workspaceProfileToToolFence(arm));
    console.log(
      sanitizeDiagnostic(`${arm} eval daemon computer=${daemon.computerId}`),
    );
    const armAttempts: EvalAttempt[] = [];
    for (const question of sample.questions) {
      const attempt = await evaluateQuestion({ arm, workspace, question, env });
      if (attempt.headlineEligible && attempt.reply) {
        const judged = await gradeReply({
          category: attempt.category,
          question: attempt.question,
          goldAnswer: attempt.goldAnswer,
          response: attempt.reply,
          apiKey: env.cursorApiKey,
          model: env.judgeModel,
          cli: env.cursorCli,
        });
        attempt.judge = judged.label;
        attempt.judgeReason = judged.reason;
      } else if (!attempt.reply) {
        attempt.judge = "WRONG";
        attempt.judgeReason = attempt.mechanism;
      }
      armAttempts.push(attempt);
      attempts.push(attempt);
      console.log(
        sanitizeDiagnostic(
          `${arm} q${attempt.questionIndex} mechanism=${attempt.mechanism} judge=${attempt.judge}`,
        ),
      );
    }
    summaries.push(summarizeArm(arm, workspace.workspaceId, sample.sampleId, ingested, armAttempts));
  } finally {
    if (daemon) await daemon.stop().catch(() => undefined);
    if (causal) await causal.stop().catch(() => undefined);
    if (workspace) await destroyEvalWorkspace(workspace);
    if (provisioned) {
      await forgetEvalAccountKey(accountId).catch(() => undefined);
      await deleteDisposableAccount(runtime, root, accountId).catch((error) => {
        console.warn(sanitizeDiagnostic(`ov account cleanup failed: ${String(error)}`));
      });
    }
  }
}

try {
  for (const arm of env.arms) {
    await runArm(arm);
  }
  const written = await writeResults({ resultDir: env.resultDir, attempts, summaries });
  console.log(sanitizeDiagnostic(`wrote ${written.jsonl}`));
  console.log(sanitizeDiagnostic(`wrote ${written.summary}`));
} finally {
  await db.$disconnect();
}
