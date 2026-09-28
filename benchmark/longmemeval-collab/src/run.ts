import { workspaceProfileToToolFence } from "../../../packages/coforge-sdk/src/agent/memory-tool-fences.ts";
import { EVAL_FLAG, evalOptedIn, loadEvalEnv } from "./env";
import { startEvalDaemon, startAgent, type EvalDaemon } from "./eval-daemon";
import { evaluateQuestion } from "./eval-qa";
import { createEvalDispatcher, ingestSample } from "./ingest";
import { gradeReply } from "./judge";
import { loadLongMemEvalSamples } from "./longmemeval";
import { writeResults, summarizeArm } from "./report";
import { sanitizeDiagnostic } from "../../public-channel-memory/src/sanitize";
import {
  createEvalRuntime,
  deleteDisposableAccount,
  forgetEvalAccountKey,
  provisionDisposableAccount,
  readSecretRootKey,
  rememberEvalAccountKey,
  rootIdentity,
  rotateEvalAdminKey,
} from "../../public-channel-memory/src/ov";
import {
  connectEvalDb,
  destroyEvalWorkspace,
  provisionEvalWorkspace,
  resetAgentSessions,
  type EvalWorkspace,
} from "./workspace";
import type { ArmSummary, EvalAttempt } from "./types";

if (!evalOptedIn()) {
  console.log(`longmemeval collaboration eval skipped: set ${EVAL_FLAG}=1`);
  process.exit(0);
}

const env = loadEvalEnv();
if (env.sampleIndexes.length < 1) throw new Error("no samples selected");
Bun.env.COFORGE_EVAL_DISABLE_HOST_PI_INJECTION = "1";
process.env.COFORGE_EVAL_DISABLE_HOST_PI_INJECTION = "1";
console.log(
  sanitizeDiagnostic(
    `memory agent ${env.memoryAgentProvider}/${env.memoryAgentModel}; task agent ${env.taskAgentProvider}/${env.taskAgentModel}; judge ${env.judgeModel}; samples ${env.sampleIndexes.join(",")}`,
  ),
);
Bun.env.OPENVIKING_PROTOTYPE_ENABLED = "1";
Bun.env.COFORGE_OPENVIKING_ACCOUNT_KEYS_FILE ??= "/tmp/pcm-eval-ov-keys.json";

const samples = await loadLongMemEvalSamples(env.dataPath, env.sampleIndexes, env.dataPin ?? undefined);
const runtime = createEvalRuntime(env.ovUrl);
const rootKey = await readSecretRootKey(env.ovConfPath);
const root = rootIdentity(rootKey);
const db = connectEvalDb(env.databaseUrl);
const attempts: EvalAttempt[] = [];
const summaries: ArmSummary[] = [];

async function runSample(arm: (typeof env.arms)[number], sampleIndex: number) {
  const sample = samples.find((row) => row.sampleIndex === sampleIndex);
  if (!sample) throw new Error(`sample ${sampleIndex} missing`);
  let accountId = `lme-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  let workspace: EvalWorkspace | undefined;
  let provisioned = false;
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
    });
    console.log(
      sanitizeDiagnostic(
        `${arm} sample=${sample.sampleId} index=${sample.sampleIndex} workspace=${workspace.workspaceId} channel=${workspace.channelId} memoryAgent=${workspace.memoryAgentId} taskAgent=${workspace.taskAgentId}`,
      ),
    );
    const dispatcher = createEvalDispatcher({
      workspace,
      runtime,
      accountId,
      users,
    });
    const ingested = await ingestSample({
      workspace,
      sample,
      dispatcher,
      fromSession: env.ingestFromSession,
    });
    daemon = await startEvalDaemon({ workspace, env });
    await resetAgentSessions(workspace);
    await startAgent(workspace, workspace.memoryAgentId, workspaceProfileToToolFence(arm));
    await startAgent(workspace, workspace.taskAgentId);
    console.log(sanitizeDiagnostic(`${arm} eval daemon computer=${daemon.computerId}`));
    const armAttempts: EvalAttempt[] = [];
    const attempt = await evaluateQuestion({ arm, workspace, question: sample.question, env });
    if (attempt.headlineEligible && attempt.reply) {
      const judged = await gradeReply({
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
        `${arm} q${attempt.questionIndex} type=${attempt.questionType} mechanism=${attempt.mechanism} judge=${attempt.judge}`,
      ),
    );
    summaries.push(
      summarizeArm(arm, workspace.workspaceId, sample.sampleId, ingested, armAttempts),
    );
    const written = await writeResults({ resultDir: env.resultDir, attempts, summaries });
    console.log(sanitizeDiagnostic(`wrote ${written.jsonl}`));
    console.log(sanitizeDiagnostic(`wrote ${written.summary}`));
  } finally {
    if (daemon) await daemon.stop().catch(() => undefined);
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
    for (const sampleIndex of env.sampleIndexes) {
      await runSample(arm, sampleIndex);
    }
  }
} finally {
  // Known quirk inherited from the public-channel eval: prisma $disconnect can
  // hang after results are written; the launcher watchdog pkills the process
  // once it logs `wrote .../attempts-`.
  await db.$disconnect();
}
