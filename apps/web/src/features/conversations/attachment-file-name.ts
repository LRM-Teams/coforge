/**
 * One derived filename for a message's attachments, as a lightweight list or jump index shows it:
 * the first (send order) plus a count of the rest, e.g. `photo.png (+2 more)`.
 *
 * Shared by `ConversationHistory.ownMessages` (server) and the own-messages index in
 * `conversation-pane.tsx` (browser), so the two never drift. It deliberately carries no
 * server-only imports: the browser bundle and server-only modules can import the same definition.
 */
export function attachmentFileNameSummary(attachments: { fileName: string }[]): string | undefined {
  const [first, ...rest] = attachments;
  if (!first) return undefined;
  return rest.length ? `${first.fileName} (+${rest.length} more)` : first.fileName;
}
