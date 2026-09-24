type Sequenced = { id: string; sequence: number };

/**
 * Merge two message lists by id, `incoming` winning on conflicts, ordered by sequence.
 * Every place that folds a page, a poll or a send result into the loaded conversation uses this.
 */
export function mergeMessages<T extends Sequenced>(
  base: readonly T[],
  incoming: readonly T[],
): T[] {
  const byId = new Map(base.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((left, right) => left.sequence - right.sequence);
}

/**
 * Thread replies grouped under their root, in list order. When every reply is the same object as
 * in `previous`, returns `previous` itself: a new top-level message (or any change that leaves
 * the replies alone) keeps the grouping's identity, so what is derived from it — each row's
 * thread entry and preview — does not re-render every row.
 */
export function groupRepliesByRoot<T extends { id: string; threadRootId?: string }>(
  messages: readonly T[],
  previous?: ReadonlyMap<string, T[]>,
): ReadonlyMap<string, T[]> {
  const byRoot = new Map<string, T[]>();
  for (const message of messages) {
    if (!message.threadRootId) continue;
    const replies = byRoot.get(message.threadRootId);
    if (replies) replies.push(message);
    else byRoot.set(message.threadRootId, [message]);
  }
  if (previous && previous.size === byRoot.size) {
    const unchanged = [...byRoot].every(([rootId, replies]) => {
      const before = previous.get(rootId);
      return (
        before?.length === replies.length &&
        replies.every((reply, index) => reply === before[index])
      );
    });
    if (unchanged) return previous;
  }
  return byRoot;
}
