import { workspaceProfileToToolFence } from "../../../packages/coforge-sdk/src/agent/memory-tool-fences.ts";
import { EVAL_FLAG, evalOptedIn, loadEvalEnv } from "./env";
import { startEvalDaemon, startAgent, type EvalDaemon } from "./eval-daemon";
import { evaluateTask } from "./eval-qa";
import { createEvalDispatcher, ingestTaskSkills } from "./ingest";
import { loadTask, listTasks } from "./tasks";
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
import { stageEnvironment } from "./stage";
import { runVerification } from "./verify";
import {
  connectEvalDb,
  destroyEvalWorkspace,
  provisionEvalWorkspace,
  resetAgentSessions,
  type EvalWorkspace,
} from "./workspace";
import { join } from "node:path";
import type { ArmSummary, EvalAttempt } from "./types";

if (!evalOptedIn()) {
  console.log(`skillsbench collaboration eval skipped: set ${EVAL_FLAG}=1`);
  process.exit(0);
}

const env = loadEvalEnv();
Bun.env.COFORGE_EVAL_DISABLE_HOST_PI_INJECTION = "1";
process.env.COFORGE_EVAL_DISABLE_HOST_PI_INJECTION = "1";
const available = await listTasks(env.tasksDir);
const taskNames =
  env.taskNames.length > 0
    ? env.taskNames
    : available.slice(0, Number(Bun.env.COFORGE_EVAL_TASK_COUNT ?? "1"));
if (taskNames.length === 0) throw new Error(`no tasks found under ${env.tasksDir} (run prepare first)`);
for (const name of taskNames) {
  if (!available.includes(name)) throw new Error(`task ${name} not found under ${env.tasksDir}`);
}
console.log(
  sanitizeDiagnostic(
    `memory agent ${env.memoryAgentProvider}/${env.memoryAgentModel}; task agent ${env.taskAgentProvider}/${env.taskAgentModel}; tasks ${taskNames.join(",")}`,
  ),
);
Bun.env.OPENVIKING_PROTOTYPE_ENABLED = "1";
Bun.env.COFORGE_OPENVIKING_ACCOUNT_KEYS_FILE ??= "/tmp/pcm-eval-ov-keys.json";

const runtime = createEvalRuntime(env.ovUrl);
const rootKey = await readSecretRootKey(env.ovConfPath);
const root = rootIdentity(rootKey);
const db = connectEvalDb(env.databaseUrl);
const attempts: EvalAttempt[] = [];
const summaries: ArmSummary[] = [];

async function runTask(arm: (typeof env.arms)[number], taskName: string) {
  const task = await loadTask(env.tasksDir, taskName);
  let accountId = `sb-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
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
      task,
      ovAccountId: accountId,
    });
    console.log(
      sanitizeDiagnostic(
        `${arm} task=${task.name} skills=${task.skills.map((skill) => skill.name).join("|") || "none"} envFiles=${task.envFiles.length} workspace=${workspace.workspaceId} memoryAgent=${workspace.memoryAgentId} taskAgent=${workspace.taskAgentId}`,
      ),
    );
    const dispatcher = createEvalDispatcher({ workspace, runtime, accountId, users });
    const ingestedSkills = await ingestTaskSkills({ workspace, task, dispatcher });
    daemon = await startEvalDaemon({ workspace, env });
    const agentWorkspaceDir = join(
      daemon.workspaceRoot,
      workspace.workspaceId,
      "agents",
      workspace.taskAgentId,
    );
    const staged = await stageEnvironment({ task, agentWorkspaceDir });
    await resetAgentSessions(workspace);
    await startAgent(workspace, workspace.memoryAgentId, workspaceProfileToToolFence(arm));
    await startAgent(workspace, workspace.taskAgentId);
    console.log(
      sanitizeDiagnostic(
        `${arm} eval daemon computer=${daemon.computerId} skillsIngested=${ingestedSkills} envStaged=${staged} agentWorkspace=${agentWorkspaceDir}`,
      ),
    );
    const attempt = await evaluateTask({
      arm,
      workspace,
      task,
      env,
      verify: (current) =>
        runVerification({ task: current, agentWorkspaceDir, verifyBaseDir: join(daemon!.workspaceRoot, workspace!.workspaceId) }),
    });
    attempts.push(attempt);
    console.log(
      sanitizeDiagnostic(
        `${arm} ${attempt.taskName} mechanism=${attempt.mechanism} citations=${attempt.citationCount} verified=${attempt.verification.verified} passed=${attempt.verification.passed} score=${attempt.verification.testScore ?? "n/a"}`,
      ),
    );
    summaries.length = 0;
    summaries.push(summarizeArm(arm, attempts));
    const written = await writeResults({ resultDir: env.resultDir, attempts, summaries });
    console.log(sanitizeDiagnostic(`wrote ${written.jsonl}`));
    console.log(sanitizeDiagnostic(`wrote ${written.csv}`));
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
    for (const taskName of taskNames) {
      await runTask(arm, taskName);
    }
  }
} finally {
  // Known quirk inherited from the sibling evals: prisma $disconnect can hang
  // after results are written; the launcher watchdog pkills the process once
  // it logs `wrote .../attempts-`.
  await db.$disconnect();
}
