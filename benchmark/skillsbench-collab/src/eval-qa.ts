import { RedisClient } from "bun";
import { PublicChannels } from "../../../apps/web/src/server/conversations/public-channels.server";
import { RedisMessageRequestIdempotency } from "../../../apps/web/src/server/conversations/redis-message-request-idempotency.server";
import { rewriteInstruction } from "./rewrite";
import { classifyMechanism } from "./leak";
import type { EvalEnv } from "./env";
import type { EvalAttempt, SkillsBenchTask } from "./types";
import type { EvalArm } from "./types";
import type { EvalWorkspace } from "./workspace";
import type { Verification } from "./types";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** The instruction goes to the Memory Agent with the same /root/ rewrite the
 * OpenViking evaluator applies, so paths read relative to the execution root. */
export function instructionBody(task: SkillsBenchTask): string {
  return `@memory ${rewriteInstruction(task.instruction)}`;
}

export async function postTaskInstruction(input: {
  workspace: EvalWorkspace;
  redisUrl: string;
  task: SkillsBenchTask;
}): Promise<{ triggerId: string; createdAt: Date }> {
  const body = instructionBody(input.task);
  if (input.redisUrl) {
    const redis = new RedisClient(input.redisUrl);
    try {
      const channels = new PublicChannels(input.workspace.db, new RedisMessageRequestIdempotency(redis));
      const sent = await channels.send({
        workspaceId: input.workspace.workspaceId,
        userId: input.workspace.evalUserId,
        channelId: input.workspace.channelId,
        requestId: crypto.randomUUID(),
        body,
      });
      const triggerId = (sent as { id?: string }).id;
      if (!triggerId) throw new Error("channel send did not return a message id");
      return { triggerId, createdAt: new Date() };
    } finally {
      redis.close();
    }
  }
  const member = await input.workspace.db.conversationMember.findFirst({
    where: { conversationId: input.workspace.channelId, userId: input.workspace.evalUserId },
  });
  if (!member) throw new Error("eval user is not a channel member");
  const latest = await input.workspace.db.message.findFirst({
    where: { conversationId: input.workspace.channelId },
    orderBy: { sequence: "desc" },
    select: { sequence: true },
  });
  const created = await input.workspace.db.message.create({
    data: {
      conversationId: input.workspace.channelId,
      workspaceId: input.workspace.workspaceId,
      senderMemberId: member.id,
      body,
      sequence: (latest?.sequence ?? 0) + 1,
    },
  });
  return { triggerId: created.id, createdAt: created.createdAt };
}

type CollaborationPoll = {
  reply: string | null;
  offerMessageId: string | null;
  citationCount: number;
  toolsUsed: string[];
  taskMessageCount: number;
  memoryLeakMessageIds: string[];
  timedOut: boolean;
};

function inferToolsFromCitations(citations: Array<{ citationKind: string }>): string[] {
  const tools = new Set<string>();
  for (const citation of citations) {
    if (citation.citationKind === "openviking") {
      tools.add("ov_find");
      tools.add("ov_read");
    }
  }
  return [...tools];
}

async function pollCollaboration(input: {
  workspace: EvalWorkspace;
  triggerCreatedAt: Date;
  env: EvalEnv;
}): Promise<CollaborationPoll> {
  const deadline = Date.now() + input.env.pollTimeoutMs;
  let snapshot: CollaborationPoll = {
    reply: null,
    offerMessageId: null,
    citationCount: 0,
    toolsUsed: [],
    taskMessageCount: 0,
    memoryLeakMessageIds: [],
    timedOut: false,
  };
  while (Date.now() < deadline) {
    const offer = await input.workspace.db.memoryOfferRecord.findFirst({
      where: {
        workspaceId: input.workspace.workspaceId,
        conversationId: input.workspace.channelId,
        createdAt: { gt: input.triggerCreatedAt },
      },
      include: { citations: true },
      orderBy: { createdAt: "desc" },
    });
    const taskMessages = await input.workspace.db.message.findMany({
      where: {
        conversationId: input.workspace.channelId,
        createdAt: { gt: input.triggerCreatedAt },
        sender: { agentId: input.workspace.taskAgentId },
      },
      orderBy: { createdAt: "asc" },
      select: { id: true, body: true, createdAt: true },
    });
    const memoryMessages = await input.workspace.db.message.findMany({
      where: {
        conversationId: input.workspace.channelId,
        createdAt: { gt: input.triggerCreatedAt },
        sender: { agentId: input.workspace.memoryAgentId },
      },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    snapshot = {
      reply: taskMessages.at(-1)?.body ?? null,
      offerMessageId: offer?.messageId ?? null,
      citationCount: offer?.citations.length ?? 0,
      toolsUsed: offer && offer.citations.length > 0 ? inferToolsFromCitations(offer.citations) : [],
      taskMessageCount: taskMessages.length,
      memoryLeakMessageIds: memoryMessages
        .map((row) => row.id)
        .filter((id) => id !== offer?.messageId),
      timedOut: false,
    };
    // Execution is done once the skill offer is out and the Task Agent has
    // been quiet for the settle window (it may work in the shell for a long
    // time between channel updates). Without an offer we always ride to the
    // deadline: the memory agent may just be slow.
    const lastTaskAt = taskMessages.at(-1)?.createdAt?.getTime() ?? 0;
    const offeredAndQuiet =
      snapshot.offerMessageId !== null &&
      snapshot.taskMessageCount > 0 &&
      Date.now() - lastTaskAt >= input.env.settleMs;
    if (offeredAndQuiet) return snapshot;
    await delay(input.env.pollMs);
  }
  return { ...snapshot, timedOut: true };
}

export async function evaluateTask(input: {
  arm: EvalArm;
  workspace: EvalWorkspace;
  task: SkillsBenchTask;
  env: EvalEnv;
  verify: (task: SkillsBenchTask) => Promise<Verification>;
}): Promise<EvalAttempt> {
  const startedAt = Date.now();
  const posted = await postTaskInstruction({
    workspace: input.workspace,
    redisUrl: input.env.redisUrl,
    task: input.task,
  });
  const polled = await pollCollaboration({
    workspace: input.workspace,
    triggerCreatedAt: posted.createdAt,
    env: input.env,
  });
  const classified = classifyMechanism(polled);
  // pytest is the judge: verification runs whatever the collaboration phase
  // produced, including on timeout.
  const verification = await input.verify(input.task);
  return {
    arm: input.arm,
    taskName: input.task.name,
    instructionExcerpt: input.task.instruction.slice(0, 200),
    reply: polled.reply,
    offerMessageId: polled.offerMessageId,
    citationCount: polled.citationCount,
    taskMessageCount: polled.taskMessageCount,
    memoryLeakMessageIds: polled.memoryLeakMessageIds,
    toolsUsed: polled.toolsUsed,
    mechanism: classified.mechanism,
    headlineEligible: classified.headlineEligible,
    verification,
    elapsedMs: Date.now() - startedAt,
  };
}
