import { RedisClient } from "bun";
import { PublicChannels } from "../../../apps/web/src/server/conversations/public-channels.server";
import { RedisMessageRequestIdempotency } from "../../../apps/web/src/server/conversations/redis-message-request-idempotency.server";
import { classifyMechanism } from "./leak";
import type { EvalEnv } from "./env";
import type { EvalAttempt, LongMemEvalQuestion } from "./types";
import type { EvalArm } from "./types";
import type { EvalWorkspace } from "./workspace";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** LongMemEval temporal gold answers assume the question_date as "today", the
 * same convention the OpenViking longmemeval benchmark passes to its answer
 * prompt, so the date rides along in the question body. */
export function questionBody(question: LongMemEvalQuestion): string {
  const today = question.questionDate
    ? ` (Today's date: ${question.questionDate.toISOString().slice(0, 10)})`
    : "";
  return `@memory ${question.question}${today}`;
}

export async function postMemoryQuestion(input: {
  workspace: EvalWorkspace;
  redisUrl: string;
  question: LongMemEvalQuestion;
}): Promise<{ triggerId: string; createdAt: Date }> {
  const body = questionBody(input.question);
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
    // The reply is final once the offer is out and the Task Agent has been
    // quiet for the settle window (it may post interim notes before answering).
    // Without an offer we never exit early: the memory agent may just be slow,
    // and an ungrounded Task Agent reply is judged at the timeout boundary.
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

export async function evaluateQuestion(input: {
  arm: EvalArm;
  workspace: EvalWorkspace;
  question: LongMemEvalQuestion;
  env: EvalEnv;
}): Promise<EvalAttempt> {
  const startedAt = Date.now();
  const posted = await postMemoryQuestion({
    workspace: input.workspace,
    redisUrl: input.env.redisUrl,
    question: input.question,
  });
  const polled = await pollCollaboration({
    workspace: input.workspace,
    triggerCreatedAt: posted.createdAt,
    env: input.env,
  });
  const classified = classifyMechanism(polled);
  return {
    arm: input.arm,
    sampleId: input.question.sampleId,
    questionIndex: input.question.questionIndex,
    questionType: input.question.questionType,
    question: input.question.question,
    goldAnswer: input.question.answer,
    reply: polled.reply,
    offerMessageId: polled.offerMessageId,
    citationCount: polled.citationCount,
    taskMessageCount: polled.taskMessageCount,
    memoryLeakMessageIds: polled.memoryLeakMessageIds,
    toolsUsed: polled.toolsUsed,
    mechanism: classified.mechanism,
    headlineEligible: classified.headlineEligible,
    judge: "UNJUDGED",
    judgeReason: "",
    elapsedMs: Date.now() - startedAt,
  };
}
