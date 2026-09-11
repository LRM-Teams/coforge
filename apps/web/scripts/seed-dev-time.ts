export type SeedMessage = { key: string; conversationId: string; createdAt: Date };
type SequencedMessage = { id: string; conversationId: string; sequence: number };

export function seedTimestamp(
  capturedNow: Date,
  daysBefore: number,
  hour: number,
  minute = 0,
): Date {
  const timestamp = new Date(capturedNow);
  timestamp.setUTCDate(timestamp.getUTCDate() - daysBefore);
  timestamp.setUTCHours(hour, minute, 0, 0);
  return timestamp > capturedNow ? new Date(capturedNow) : timestamp;
}

export function orderSeedMessages<T extends SeedMessage>(messages: T[]): T[] {
  return [...messages].sort(
    (left, right) =>
      left.conversationId.localeCompare(right.conversationId) ||
      left.createdAt.getTime() - right.createdAt.getTime() ||
      left.key.localeCompare(right.key),
  );
}

export function assignMissingSeedSequences<T extends SeedMessage & { id: string }>(
  orderedSeedMessages: T[],
  existingMessages: SequencedMessage[],
): Array<{ id: string; sequence: number }> {
  const existingIds = new Set(existingMessages.map(({ id }) => id));
  const nextByConversation = new Map<string, number>();
  for (const message of existingMessages) {
    nextByConversation.set(
      message.conversationId,
      Math.max(nextByConversation.get(message.conversationId) ?? 0, message.sequence),
    );
  }

  return orderedSeedMessages.flatMap((message) => {
    if (existingIds.has(message.id)) return [];
    const sequence = (nextByConversation.get(message.conversationId) ?? 0) + 1;
    nextByConversation.set(message.conversationId, sequence);
    return [{ id: message.id, sequence }];
  });
}
