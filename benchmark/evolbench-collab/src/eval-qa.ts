import { RedisClient } from "bun";
import { PublicChannels } from "../../../apps/web/src/server/conversations/public-channels.server";
import { RedisMessageRequestIdempotency } from "../../../apps/web/src/server/conversations/redis-message-request-idempotency.server";
import type { EvalEnv } from "./env";
import type { ManifestEpisode } from "./types";
import type { EvalWorkspace } from "./workspace";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export function episodePrompt(
  episode: ManifestEpisode,
  reminder: string,
  envNote?: string | null,
): string {
  const note = envNote
    ? `\n\n${envNote
        .replaceAll("%TASK_ID%", episode.taskId)
        .replaceAll("%EPISODE_ID%", episode.episodeId)}`
    : "";
  return `@memory ${episode.prompt}${note}\n\n${reminder}`;
}

export async function postEpisodePrompt(input: {
  workspace: EvalWorkspace;
  redisUrl: string;
  episode: ManifestEpisode;
  reminder: string;
  envNote?: string | null;
}): Promise<{ triggerId: string; createdAt: Date }> {
  const body = episodePrompt(input.episode, input.reminder, input.envNote);
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

export type EpisodeResult = {
  finalOutput: string | null;
  offerMessageId: string | null;
  citationCount: number;
  taskMessageCount: number;
  memoryLeakMessageIds: string[];
  timedOut: boolean;
  elapsedMs: number;
};

/** One episode: the prompt goes to @memory; the Memory Agent publishes its
 * recall offer addressed to the Task Agent; the Task Agent executes and posts
 * the final answer. The reply is final after the settle window of quiet. */
export async function runEpisode(input: {
  workspace: EvalWorkspace;
  env: EvalEnv;
  episode: ManifestEpisode;
  reminder: string;
  episodeTimeoutMs: number;
  settleMs: number;
}): Promise<EpisodeResult> {
  const startedAt = Date.now();
  const posted = await postEpisodePrompt({
    workspace: input.workspace,
    redisUrl: input.env.redisUrl,
    episode: input.episode,
    reminder: input.reminder,
    envNote: input.env.envNote,
  });
  const deadline = Date.now() + input.episodeTimeoutMs;
  const abortQuietMs = input.env.abortQuietMs;
  let snapshot = {
    finalOutput: null as string | null,
    offerMessageId: null as string | null,
    citationCount: 0,
    taskMessageCount: 0,
    memoryLeakMessageIds: [] as string[],
    timedOut: false,
  };
  while (Date.now() < deadline) {
    const offer = await input.workspace.db.memoryOfferRecord.findFirst({
      where: {
        workspaceId: input.workspace.workspaceId,
        conversationId: input.workspace.channelId,
        createdAt: { gt: posted.createdAt },
      },
      include: { citations: true },
      orderBy: { createdAt: "desc" },
    });
    const taskMessages = await input.workspace.db.message.findMany({
      where: {
        conversationId: input.workspace.channelId,
        createdAt: { gt: posted.createdAt },
        sender: { agentId: input.workspace.taskAgentId },
      },
      orderBy: { createdAt: "asc" },
      select: { id: true, body: true, createdAt: true },
    });
    const memoryMessages = await input.workspace.db.message.findMany({
      where: {
        conversationId: input.workspace.channelId,
        createdAt: { gt: posted.createdAt },
        sender: { agentId: input.workspace.memoryAgentId },
      },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    snapshot = {
      finalOutput: taskMessages.at(-1)?.body ?? null,
      offerMessageId: offer?.messageId ?? null,
      citationCount: offer?.citations.length ?? 0,
      taskMessageCount: taskMessages.length,
      memoryLeakMessageIds: memoryMessages
        .map((row) => row.id)
        .filter((id) => id !== offer?.messageId),
      timedOut: false,
    };
    const lastTaskAt = taskMessages.at(-1)?.createdAt?.getTime() ?? 0;
    // Nothing observable is happening at all (no offer yet, no task message
    // within the abort window) — the memory agent is stuck, so stop burning
    // the full episode deadline.
    const deadQuiet =
      snapshot.offerMessageId === null &&
      Date.now() - Math.max(posted.createdAt.getTime(), lastTaskAt) >= abortQuietMs;
    if (deadQuiet) {
      return { ...snapshot, timedOut: true, elapsedMs: Date.now() - startedAt };
    }
    const offeredAndQuiet =
      snapshot.offerMessageId !== null &&
      snapshot.taskMessageCount > 0 &&
      Date.now() - lastTaskAt >= input.settleMs;
    // Without an offer we ride to the deadline: the memory agent may be slow,
    // and an answer that arrived without recall is still recorded (the grader
    // judges it) while the mechanism columns expose the missing recall.
    if (offeredAndQuiet) {
      return { ...snapshot, elapsedMs: Date.now() - startedAt };
    }
    await delay(input.env.pollMs);
  }
  return { ...snapshot, timedOut: true, elapsedMs: Date.now() - startedAt };
}
