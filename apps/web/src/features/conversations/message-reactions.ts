/** Who reacted: the person's or Agent's own `id` (how the viewer's own reaction is found) and the
 * `label` to show, a person's name or an Agent's `@handle`. */
export type Reactor = { id: string; label: string };

/** One emoji's reactions on a message, as the server summarizes them (`reactionSummaries`). */
export type ReactionSummary = { emoji: string; count: number; reactors: Reactor[] };

/**
 * The summaries after `reactor` adds or removes `emoji`, computed locally so the chip can change
 * before the server answers. Keeps the server's first-reaction order: a new emoji goes last and a
 * reactor is appended to its emoji. Returns undefined once no reaction is left, the same shape a
 * message without reactions has.
 */
export function applyReactionToggle(
  reactions: readonly ReactionSummary[] | undefined,
  emoji: string,
  reactor: Reactor,
  active: boolean,
): ReactionSummary[] | undefined {
  const isReactor = (other: Reactor) => other.id === reactor.id;
  const current = reactions ?? [];
  const existing = current.find((reaction) => reaction.emoji === emoji);
  const next: ReactionSummary[] = active
    ? existing
      ? current.map((reaction) =>
          reaction === existing && !reaction.reactors.some(isReactor)
            ? { emoji, count: reaction.count + 1, reactors: [...reaction.reactors, reactor] }
            : reaction,
        )
      : [...current, { emoji, count: 1, reactors: [reactor] }]
    : current.flatMap((reaction) => {
        if (reaction !== existing || !reaction.reactors.some(isReactor)) return [reaction];
        const reactors = reaction.reactors.filter((other) => !isReactor(other));
        return reactors.length ? [{ emoji, count: reaction.count - 1, reactors }] : [];
      });
  return next.length ? next : undefined;
}

/**
 * Toggles the viewer's reactions optimistically on a loaded conversation: the chip changes at
 * once, the server's summary for that message then replaces the local guess, and a failed call
 * re-reads the conversation (`resync`) before the error reaches the caller. Only the newest
 * toggle on a message settles it, so an older answer arriving late cannot undo a newer click.
 */
export function createReactionToggler<M extends { reactions?: ReactionSummary[] }>(deps: {
  /** Replace one loaded message; leaves every other message object as it is. */
  update: (messageId: string, update: (message: M) => M) => void;
  resync: () => Promise<unknown>;
}) {
  const latest = new Map<string, number>();
  let issued = 0;
  return async function toggleReaction(
    messageId: string,
    emoji: string,
    /** The viewer; without one the chip waits for the server's summary. */
    reactor: Reactor | undefined,
    active: boolean,
    send: () => Promise<ReactionSummary[] | undefined>,
  ) {
    const token = ++issued;
    latest.set(messageId, token);
    if (reactor)
      deps.update(messageId, (message) => ({
        ...message,
        reactions: applyReactionToggle(message.reactions, emoji, reactor, active),
      }));
    try {
      const reactions = await send();
      if (latest.get(messageId) === token)
        deps.update(messageId, (message) => ({ ...message, reactions }));
    } catch (error) {
      void deps.resync().catch(() => {});
      throw error;
    } finally {
      if (latest.get(messageId) === token) latest.delete(messageId);
    }
  };
}
