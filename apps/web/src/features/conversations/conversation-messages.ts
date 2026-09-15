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
