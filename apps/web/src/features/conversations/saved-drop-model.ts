/**
 * The drag payload contract for save-by-drag (#127 follow-up, the boss's "直接 drag 到 PINNED"):
 * a conversation pane writes one of these onto a dragged message row (see `message-row.tsx`,
 * which owns the MIME constant), and the sidebar's SAVED section (`conversation-directory.tsx`)
 * is the drop target that turns it into a bookmark. The guard is framework-free so the rules are
 * unit-testable without a DOM harness (apps/web's suite renders server-side; effects never run).
 */

export const SAVED_DRAG_MIME = "application/x-coforge-saved-message";

/** A pure guard over the drag payload: an opaque or foreign drag must not throw into the drop
 * handler — it simply is not a bookmark. */
export function savedDropPayload(
  raw: string | undefined,
): { conversationId: string; messageId: string } | undefined {
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  if (typeof record.conversationId !== "string" || !record.conversationId) return undefined;
  if (typeof record.messageId !== "string" || !record.messageId) return undefined;
  return { conversationId: record.conversationId, messageId: record.messageId };
}
