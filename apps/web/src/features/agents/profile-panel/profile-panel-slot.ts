/**
 * The conversation's right-hand slot is shared by the Thread panel and the Agent profile panel:
 * whichever was opened most recently is shown; the other keeps its own state and reappears when
 * the visible one closes. Pure so the arbitration rule is unit-testable without mounting
 * `react-resizable-panels` or a route.
 */
export type ConversationSlot = "thread" | "profile";

export function resolveVisibleConversationSlot(input: {
  threadOpen: boolean;
  profileOpen: boolean;
  /** Which of the two was opened (or re-affirmed) most recently; only breaks the tie when both
   * are open at once. Undefined defaults to favoring an already-open thread. */
  lastOpened?: ConversationSlot;
}): ConversationSlot | undefined {
  if (input.threadOpen && input.profileOpen) {
    return input.lastOpened === "profile" ? "profile" : "thread";
  }
  if (input.threadOpen) return "thread";
  if (input.profileOpen) return "profile";
  return undefined;
}
