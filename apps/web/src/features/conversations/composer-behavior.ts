/**
 * Pure decision functions for the message composer's Enter-to-send and
 * paste-to-upload behaviour, kept free of React and DOM types so they can be
 * unit tested with plain objects.
 *
 * React Aria's `useKeyboard` (https://react-aria.adobe.com/useKeyboard) is a
 * thin passthrough over native keyboard events with no IME awareness, and
 * `useClipboard` (https://react-aria.adobe.com/useClipboard) unconditionally
 * calls `preventDefault()` on every paste once an `onPaste` handler is given
 * (see its `dnd/useClipboard` implementation), which would also swallow
 * plain-text pastes into this textarea. Neither hook fits a live-editing
 * native `<textarea>`, so the composer wires the standard
 * `onKeyDown`/`onCompositionStart`/`onCompositionEnd`/`onPaste` DOM props
 * directly, same as its existing `onKeyDown`/`onChange` handlers, and the
 * decisions below are the pure logic behind them.
 */

/** How long after `compositionend` an Enter keydown is still treated as part of the same IME confirmation (Safari fires it after compositionend with `isComposing` already false). */
export const IME_ENTER_GUARD_MS = 50;

export type EnterKeyLikeEvent = {
  key: string;
  shiftKey: boolean;
  /** `event.nativeEvent.isComposing` OR'd with the composer's own compositionstart/compositionend tracking. */
  isComposing: boolean;
  /** `event.keyCode`; Safari/Chrome fire keydown with 229 while a composition is in progress. */
  keyCode: number;
};

/**
 * Whether a keydown on the composer textarea should submit the message.
 * Plain Enter sends; Shift+Enter always stays a newline; Enter is ignored
 * entirely while (or immediately after) an IME composition is being
 * confirmed.
 */
export function shouldSendOnEnter(
  event: EnterKeyLikeEvent,
  composition: { lastCompositionEndAt: number | null; now: number },
): boolean {
  if (event.key !== "Enter" || event.shiftKey) return false;
  if (event.isComposing || event.keyCode === 229) return false;
  const { lastCompositionEndAt, now } = composition;
  if (lastCompositionEndAt !== null && now - lastCompositionEndAt < IME_ENTER_GUARD_MS)
    return false;
  return true;
}

export type ClipboardDataLike = {
  files?: ArrayLike<File> | null;
  items?: ArrayLike<{ kind: string; getAsFile(): File | null }> | null;
};

/**
 * The files carried by a paste event, preferring `clipboardData.files` and
 * falling back to scanning `items` for `kind === "file"` entries (some
 * browsers only populate `items` for pasted screenshots).
 */
export function filesFromPaste(clipboardData: ClipboardDataLike | null | undefined): File[] {
  if (!clipboardData) return [];
  const files = clipboardData.files ? Array.from(clipboardData.files) : [];
  if (files.length > 0) return files;
  if (!clipboardData.items) return [];
  const fallback: File[] = [];
  for (const item of Array.from(clipboardData.items)) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file) fallback.push(file);
  }
  return fallback;
}
