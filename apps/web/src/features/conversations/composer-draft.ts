/**
 * Per-chat message-composer drafts, kept on this device only.
 *
 * Each chat (and each thread inside it) gets its own `localStorage` entry, so
 * typing in one conversation never leaks into another and an unfinished text
 * survives switching chats, reloads, and restarts on the same device.
 * Attachments are intentionally not persisted: files cannot live in
 * `localStorage`, so only the text body is remembered. The people the text's `@name`s were
 * picked to mean (`MentionPin`) are remembered too, beside it under their own key, so a reload
 * keeps who was meant along with what was written.
 */

import { browserLocalStorage } from "#src/features/browser-local-storage";
import { isMentionPin, NO_PINS, type MentionPin } from "./mention-pins";

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

/** Where a draft's pins live: beside its text, under the same chat (and thread) key. */
function pinsKey(draftKey: string): string {
  return `${draftKey}:pins`;
}

/** The saved draft's mention pins, or none when there are none, they cannot be read, or storage is
 * unavailable. */
export function readComposerDraftPins(key: string): readonly MentionPin[] {
  const storage = browserLocalStorage();
  if (!storage) return NO_PINS;
  try {
    const raw = storage.getItem(pinsKey(key));
    const parsed: unknown = raw ? JSON.parse(raw) : NO_PINS;
    return Array.isArray(parsed) && parsed.length && parsed.every(isMentionPin) ? parsed : NO_PINS;
  } catch {
    return NO_PINS;
  }
}

/** Saves a draft's mention pins; none removes the entry. */
export function writeComposerDraftPins(key: string, pins: readonly MentionPin[]): void {
  const storage = browserLocalStorage();
  if (!storage) return;
  try {
    if (pins.length) storage.setItem(pinsKey(key), JSON.stringify(pins));
    else storage.removeItem(pinsKey(key));
  } catch {
    // Private mode or quota: the composer still works for this visit.
  }
}

/** Drops the saved draft and its pins, e.g. after its message was sent. */
export function clearComposerDraft(key: string): void {
  const storage = browserLocalStorage();
  if (!storage) return;
  try {
    storage.removeItem(key);
    storage.removeItem(pinsKey(key));
  } catch {
    // Ignore: nothing durable depends on the removal.
  }
}
