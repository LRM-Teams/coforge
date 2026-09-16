import type { Prisma } from "../../../generated/client";

/** Reactions on a message, oldest first so grouping preserves first-reaction order. */
export const MESSAGE_REACTIONS_SELECT = {
  orderBy: { createdAt: "asc" },
  select: {
    emoji: true,
    member: {
      select: {
        agentId: true,
        agent: { select: { name: true } },
        user: { select: { username: true } },
      },
    },
  },
} satisfies NonNullable<Prisma.MessageInclude["reactions"]>;

export type MessageReactionRow = {
  emoji: string;
  member: {
    agentId: string | null;
    agent: { name: string } | null;
    user: { username: string } | null;
  };
};

export type MessageReactionSummary = { emoji: string; count: number; reactors: string[] };

/**
 * Groups reactions by emoji in first-reaction order for the browser; a reactor is
 * `@username` or `@agentname`. Returns undefined when the message has no reactions.
 */
export function reactionSummaries(
  rows: MessageReactionRow[],
): MessageReactionSummary[] | undefined {
  if (rows.length === 0) return undefined;
  const byEmoji = new Map<string, string[]>();
  for (const row of rows) {
    const reactor = row.member.agentId
      ? `@${row.member.agent?.name ?? "agent"}`
      : `@${row.member.user?.username}`;
    const reactors = byEmoji.get(row.emoji);
    if (reactors) reactors.push(reactor);
    else byEmoji.set(row.emoji, [reactor]);
  }
  return [...byEmoji].map(([emoji, reactors]) => ({ emoji, count: reactors.length, reactors }));
}
