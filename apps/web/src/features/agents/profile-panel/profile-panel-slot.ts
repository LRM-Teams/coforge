/**
 * The conversation's right-hand slot is shared by the Thread panel and the Agent profile panel:
 * The two panels are mutually exclusive. The navigation hooks clear the other panel when one is
 * opened; this function remains defensive for legacy URLs that contain both search params.
 */
export type ConversationSlot = "thread" | "profile";

export function resolveVisibleConversationSlot(input: {
  threadOpen: boolean;
  profileOpen: boolean;
}): ConversationSlot | undefined {
  if (input.threadOpen && input.profileOpen) {
    return "thread";
  }
  if (input.threadOpen) return "thread";
  if (input.profileOpen) return "profile";
  return undefined;
}
