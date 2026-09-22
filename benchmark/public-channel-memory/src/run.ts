import { EVAL_FLAG, evalOptedIn, loadEvalEnv } from "./env";
import { evaluateQuestion } from "./eval-qa";
import { createEvalDispatcher, ingestSample } from "./ingest";
import { gradeReply } from "./judge";
import { loadLocomoSample } from "./locomo";
import { writeResults, summarizeArm } from "./report";
import { sanitizeDiagnostic } from "./sanitize";
import {
  createEvalRuntime,
  deleteDisposableAccount,
  provisionDisposableAccount,
  readSecretRootKey,
  rootIdentity,
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
Bun.env.OPENVIKING_PROTOTYPE_ENABLED = "1";

const sample = await loadLocomoSample(env.locomoPath, env.sampleId, env.qaLimit);
const runtime = createEvalRuntime(env.ovUrl);
const rootKey = await readSecretRootKey(env.ovConfPath);
const root = rootIdentity(rootKey);
const db = connectEvalDb(env.databaseUrl);
const attempts: EvalAttempt[] = [];
const summaries: ArmSummary[] = [];

async function runArm(arm: (typeof env.arms)[number]) {
  const accountId = `pcm-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  let workspace: EvalWorkspace | undefined;
  let provisioned = false;
  try {
    const health = await fetch(new URL("/health", env.ovUrl));
    if (health.status !== 200) throw new Error(`openviking /health ${health.status}`);
    const users = await provisionDisposableAccount(runtime, root, accountId);
    provisioned = true;
    workspace = await provisionEvalWorkspace({
      db,
      arm,
      sample,
      ovAccountId: accountId,
    });
    console.log(
      sanitizeDiagnostic(
        `${arm} workspace=${workspace.workspaceId} channel=${workspace.channelId} memoryAgent=${workspace.memoryAgentId} recipient=${workspace.recipientAgentId}`,
      ),
    );
    const dispatcher = createEvalDispatcher({
      workspace,
      runtime,
      accountId,
      users,
    });
    const ingested = await ingestSample({ workspace, sample, dispatcher });
    await resetMemoryAgentSession(workspace);
    const armAttempts: EvalAttempt[] = [];
    for (const question of sample.questions) {
      const attempt = await evaluateQuestion({ arm, workspace, question, env });
      if (attempt.headlineEligible && attempt.reply) {
        const judged = await gradeReply({
          category: attempt.category,
          question: attempt.question,
          goldAnswer: attempt.goldAnswer,
          response: attempt.reply,
          baseUrl: env.judgeBaseUrl,
          apiKey: env.judgeApiKey,
          model: env.judgeModel,
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
    if (workspace) await destroyEvalWorkspace(workspace);
    if (provisioned) {
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
