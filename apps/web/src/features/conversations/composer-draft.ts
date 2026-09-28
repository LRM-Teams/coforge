/**
 * Per-chat message-composer drafts, kept on this device only.
 *
 * Each chat (and each thread inside it) gets its own `localStorage` entry, so
 * typing in one conversation never leaks into another and an unfinished text
 * survives switching chats, reloads, and restarts on the same device.
 * Attachments are intentionally not persisted: files cannot live in
 * `localStorage`, so only the text body is remembered.
 */

import { browserLocalStorage } from "#src/features/browser-local-storage";

const DRAFT_KEY_PREFIX = "coforge.composer-draft:";

/** Storage key for one composer: the main pane, or one thread pane. */
export function composerDraftKey(conversationId: string, threadRootId?: string): string {
  return threadRootId
    ? `${DRAFT_KEY_PREFIX}${conversationId}:thread:${threadRootId}`
    : `${DRAFT_KEY_PREFIX}${conversationId}`;
}

/** The saved draft text, or `""` when none exists or storage is unavailable. */
export function readComposerDraft(key: string): string {
  const storage = browserLocalStorage();
  if (!storage) return "";
  try {
    return storage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

/** Saves a draft; a blank body removes the entry so dead chats leave no clutter. */
export function writeComposerDraft(key: string, body: string): void {
  const storage = browserLocalStorage();
  if (!storage) return;
  try {
    if (body) storage.setItem(key, body);
    else storage.removeItem(key);
  } catch {
    // Private mode or quota: the composer still works for this visit.
  }
}

/** Drops the saved draft, e.g. after its message was sent. */
export function clearComposerDraft(key: string): void {
  const storage = browserLocalStorage();
  if (!storage) return;
  try {
    storage.removeItem(key);
  } catch {
    // Ignore: nothing durable depends on the removal.
  }
}
