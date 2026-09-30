import type { Prisma } from "#src/generated/prisma/client";
import { humanLabel } from "#src/lib/human-label";

/** Reactions on a message, oldest first so grouping preserves first-reaction order. */
export const MESSAGE_REACTIONS_SELECT = {
  orderBy: { createdAt: "asc" },
  select: {
    emoji: true,
    member: {
      select: {
        userId: true,
        agentId: true,
        agent: { select: { name: true } },
        user: { select: { username: true, displayName: true, fullName: true } },
      },
    },
  },
} satisfies NonNullable<Prisma.MessageInclude["reactions"]>;

export type MessageReactionRow = {
  emoji: string;
  member: {
    userId: string | null;
    agentId: string | null;
    agent: { name: string } | null;
    user: { username: string; displayName: string | null; fullName: string | null } | null;
  };
};

/** Who reacted: the person's or Agent's own id (what the viewer's own reaction is matched by) and
 * the name to show for them. */
export type MessageReactor = { id: string; label: string };

export type MessageReactionSummary = { emoji: string; count: number; reactors: MessageReactor[] };

/**
 * Groups reactions by emoji in first-reaction order for the browser. A person's `label` is the
 * name teammates know them by (`humanLabel`), never their username; an Agent's is its `@handle`.
 * Returns undefined when the message has no reactions (including rows selected without the
 * relation, as in unit-test fakes).
 */
export function reactionSummaries(
  rows: MessageReactionRow[] | undefined,
): MessageReactionSummary[] | undefined {
  if (!rows?.length) return undefined;
  const byEmoji = new Map<string, MessageReactor[]>();
  for (const row of rows) {
    const { member } = row;
    // A conversation member is exactly one of a User or an Agent.
    const reactor: MessageReactor = member.agentId
      ? { id: member.agentId, label: `@${member.agent?.name ?? "agent"}` }
      : { id: member.userId!, label: humanLabel(member.user!) };
    const reactors = byEmoji.get(row.emoji);
    if (reactors) reactors.push(reactor);
    else byEmoji.set(row.emoji, [reactor]);
  }
  return [...byEmoji].map(([emoji, reactors]) => ({ emoji, count: reactors.length, reactors }));
}
