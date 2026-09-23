/**
 * Resolve who receives a Leader weekly-report send.
 * Testing phase: the sender may be included when listed (or via allMembers).
 */
export function recipientUserIdsForSend(input: {
  allMembers: boolean;
  recipientUserIds: readonly string[];
  workspaceMemberIds: readonly string[];
  senderUserId: string;
}): string[] {
  void input.senderUserId;
  const pool = input.allMembers ? input.workspaceMemberIds : input.recipientUserIds;
  return [...new Set(pool)];
}
