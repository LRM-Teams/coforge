import type { PrismaClient } from "../../../generated/client";
import type { EpisodeParticipant } from "./memory-episodes.server";
import { normalizeEpisodeParticipants } from "./memory-episodes.server";

/**
 * Group Memory interactions layer, slice 1 (ADR 0052-C).
 *
 * Lossless extraction of structured collaboration facts at ingestion time:
 *  - participants snapshot for the episode (ADR 0052-C);
 *  - Interaction Links — `mentions` (MessageMention rows), `responds_to`
 *    (threadRootId), `delegates_to` (Task assignment to a member other than
 *    the creator).
 *
 * Zero guessing, zero LLM: every link maps to an existing structured fact.
 * `continues` is deliberately absent (no structured source — see ADR 0052-C).
 * The `from` end is always a message inside the ingested window; the `to`
 * end may point outside it (replying to a thread root from before the window
 * is a real fact). Extraction is idempotent via the normalized target key,
 * so ingestion replays and re-extraction never duplicate an edge.
 */

export type InteractionLinkKind = "mentions" | "responds_to" | "delegates_to";

type LinkRow = {
  workspaceId: string;
  conversationId: string;
  fromMessageId: string;
  kind: InteractionLinkKind;
  targetKey: string;
  toMessageId?: string | null;
  toMemberId?: string | null;
};

/** Collect the distinct window participants from sender member rows. */
export async function collectEpisodeParticipants(
  db: PrismaClient,
  input: { conversationId: string; startSequence: number; endSequence: number },
): Promise<EpisodeParticipant[]> {
  const messages = await db.message.findMany({
    where: {
      conversationId: input.conversationId,
      sequence: { gte: input.startSequence, lte: input.endSequence },
      senderMemberId: { not: null },
    },
    select: {
      sender: {
        select: {
          user: { select: { id: true, username: true } },
          agent: { select: { id: true, name: true } },
        },
      },
    },
  });
  const participants: EpisodeParticipant[] = [];
  for (const message of messages) {
    const sender = message.sender;
    if (!sender) continue;
    if (sender.agent)
      participants.push({ kind: "agent", id: sender.agent.id, handle: sender.agent.name });
    else if (sender.user)
      participants.push({ kind: "human", id: sender.user.id, handle: sender.user.username });
  }
  return normalizeEpisodeParticipants(participants);
}

/**
 * Extract Interaction Links whose `from` message lies inside the window.
 * Idempotent: existing (fromMessage, kind, target) rows are skipped, so this
 * is safe to call on every ingestion replay.
 */
export async function extractInteractionLinks(
  db: PrismaClient,
  input: {
    workspaceId: string;
    conversationId: string;
    startSequence: number;
    endSequence: number;
  },
): Promise<{ inserted: number }> {
  const windowMessages = await db.message.findMany({
    where: {
      conversationId: input.conversationId,
      sequence: { gte: input.startSequence, lte: input.endSequence },
    },
    select: { id: true, threadRootId: true },
  });
  const messageIds = windowMessages.map((message) => message.id);

  const rows: LinkRow[] = [];

  for (const message of windowMessages) {
    if (message.threadRootId) {
      rows.push({
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
        fromMessageId: message.id,
        kind: "responds_to",
        targetKey: `message:${message.threadRootId}`,
        toMessageId: message.threadRootId,
        toMemberId: null,
      });
    }
  }

  if (messageIds.length) {
    const mentions = await db.messageMention.findMany({
      where: { messageId: { in: messageIds } },
      select: { messageId: true, memberId: true },
    });
    for (const mention of mentions) {
      rows.push({
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
        fromMessageId: mention.messageId,
        kind: "mentions",
        targetKey: `member:${mention.memberId}`,
        toMessageId: null,
        toMemberId: mention.memberId,
      });
    }

    const delegated = await db.task.findMany({
      where: {
        messageId: { in: messageIds },
        ownerMemberId: { not: null },
      },
      select: { messageId: true, ownerMemberId: true, creatorMemberId: true },
    });
    for (const task of delegated) {
      // Self-assignment is collaboration with oneself, not delegation.
      if (task.ownerMemberId === task.creatorMemberId) continue;
      rows.push({
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
        fromMessageId: task.messageId,
        kind: "delegates_to",
        targetKey: `member:${task.ownerMemberId}`,
        toMessageId: null,
        toMemberId: task.ownerMemberId,
      });
    }
  }

  if (!rows.length) return { inserted: 0 };
  const result = await db.memoryInteractionLink.createMany({
    data: rows,
    skipDuplicates: true,
  });
  return { inserted: result.count };
}
