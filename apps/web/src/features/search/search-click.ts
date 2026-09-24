import { useCallback, useEffect, useRef, type MouseEvent } from "react";

/** Long enough for a second click to arrive before the first one previews. */
const DOUBLE_CLICK_MS = 220;

/**
 * A result link's click: with room for a preview, a single click previews and a double click
 * lets the link open for real; without room (or for a result that has no preview) a click opens.
 * A modified or middle click keeps the browser's own behaviour, a new tab. `onOpened` runs for
 * every open and preview, so search can remember it.
 */
export function useResultClick({
  onPreview,
  onOpened,
}: {
  /** Undefined when this result cannot be previewed here. */
  onPreview: (() => void) | undefined;
  onOpened: () => void;
}) {
  const pending = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(pending.current), []);
  return useCallback(
    (event: MouseEvent) => {
      onOpened();
      const modified = event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
      if (event.button !== 0 || modified || !onPreview) return;
      clearTimeout(pending.current);
      // The second click of a double click goes through: the link itself opens the conversation.
      if (event.detail >= 2) return;
      event.preventDefault();
      pending.current = setTimeout(onPreview, DOUBLE_CLICK_MS);
    },
    [onPreview, onOpened],
  );
}
