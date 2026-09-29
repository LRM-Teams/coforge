import { RedisClient } from "bun";
import { PublicChannels } from "../../../apps/web/src/server/conversations/public-channels.server";
import { RedisMessageRequestIdempotency } from "../../../apps/web/src/server/conversations/redis-message-request-idempotency.server";
import { classifyMechanism } from "./leak";
import type { EvalEnv } from "./env";
import type { EvalAttempt, LocomoQuestion } from "./types";
import type { EvalArm } from "./types";
import type { EvalWorkspace } from "./workspace";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export async function postMemoryQuestion(input: {
  workspace: EvalWorkspace;
  redisUrl: string;
  question: LocomoQuestion;
}): Promise<{ triggerId: string; createdAt: Date }> {
  const body = `@memory ${input.question.question}`;
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

async function pollAnswer(input: {
  workspace: EvalWorkspace;
  triggerCreatedAt: Date;
  env: EvalEnv;
}): Promise<{
  reply: string | null;
  offerMessageId: string | null;
  citationCount: number;
  toolsUsed: string[];
  timedOut: boolean;
}> {
  const deadline = Date.now() + input.env.pollTimeoutMs;
  while (Date.now() < deadline) {
    const reply = await input.workspace.db.message.findFirst({
      where: {
        conversationId: input.workspace.channelId,
        createdAt: { gt: input.triggerCreatedAt },
        sender: { agentId: input.workspace.memoryAgentId },
      },
      orderBy: { createdAt: "asc" },
    });
    const offer = await input.workspace.db.memoryOfferRecord.findFirst({
      where: {
        workspaceId: input.workspace.workspaceId,
        conversationId: input.workspace.channelId,
        createdAt: { gt: input.triggerCreatedAt },
      },
      include: { citations: true },
      orderBy: { createdAt: "desc" },
    });
    if (reply || offer) {
      return {
        reply: reply?.body ?? null,
        offerMessageId: offer?.messageId ?? null,
        citationCount: offer?.citations.length ?? 0,
        toolsUsed: offer && offer.citations.length > 0 ? inferToolsFromCitations(offer.citations) : [],
        timedOut: false,
      };
    }
    await delay(input.env.pollMs);
  }
  return { reply: null, offerMessageId: null, citationCount: 0, toolsUsed: [], timedOut: true };
}

function inferToolsFromCitations(citations: Array<{ citationKind: string }>): string[] {
  const tools = new Set<string>();
  for (const citation of citations) {
    if (citation.citationKind === "openviking") {
      tools.add("ov_find");
      tools.add("ov_read");
    }
    if (citation.citationKind === "causal") {
      tools.add("causal_search");
    }
  }
  return [...tools];
}

export async function evaluateQuestion(input: {
  arm: EvalArm;
  workspace: EvalWorkspace;
  question: LocomoQuestion;
  env: EvalEnv;
}): Promise<EvalAttempt> {
  const posted = await postMemoryQuestion({
    workspace: input.workspace,
    redisUrl: input.env.redisUrl,
    question: input.question,
  });
  const polled = await pollAnswer({
    workspace: input.workspace,
    triggerCreatedAt: posted.createdAt,
    env: input.env,
  });
  const classified = classifyMechanism(polled);
  return {
    arm: input.arm,
    sampleId: input.question.sampleId,
    questionIndex: input.question.questionIndex,
    category: input.question.category,
    question: input.question.question,
    goldAnswer: input.question.answer,
    reply: polled.reply,
    offerMessageId: polled.offerMessageId,
    citationCount: polled.citationCount,
    toolsUsed: polled.toolsUsed,
    mechanism: classified.mechanism,
    headlineEligible: classified.headlineEligible,
    judge: "UNJUDGED",
    judgeReason: "",
  };
}
