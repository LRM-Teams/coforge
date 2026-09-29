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
 * Thread replies grouped under their root, in list order. A root whose replies are the same
 * objects as in `previous` keeps its list from `previous`, and when no root changed `previous`
 * itself comes back: a reply in one thread (or a new top-level message) leaves every other
 * thread's list as it was, so only that thread's summary re-renders.
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
  if (!previous) return byRoot;
  let unchanged = previous.size === byRoot.size;
  for (const [rootId, replies] of byRoot) {
    const before = previous.get(rootId);
    if (
      before?.length === replies.length &&
      replies.every((reply, index) => reply === before[index])
    )
      byRoot.set(rootId, before);
    else unchanged = false;
  }
  return unchanged ? previous : byRoot;
}
