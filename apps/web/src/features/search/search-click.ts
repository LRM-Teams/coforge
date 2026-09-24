import { useCallback, useEffect, useRef, type MouseEvent } from "react";

/** Long enough for a second click to arrive before the first one previews. */
const DOUBLE_CLICK_MS = 220;

/**
 * A result link's click: with room for a preview, a single click previews and a double click
 * lets the link open for real; without room (or for a result that has no preview) a click opens.
 * A modified or middle click keeps the browser's own behaviour, a new tab. `onOpened` runs once
 * per open or preview, so search remembers it once.
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
      const modified = event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
      if (event.button !== 0 || modified || !onPreview) {
        onOpened();
        return;
      }
      clearTimeout(pending.current);
      // The second click of a double click goes through: the link itself opens the conversation,
      // counted once (the first click's preview never happened).
      if (event.detail >= 2) {
        onOpened();
        return;
      }
      event.preventDefault();
      const showPreview = () => {
        onOpened();
        onPreview();
      };
      // A keyboard activation (Enter) is no double click in the making: preview at once.
      if (event.detail === 0) showPreview();
      else pending.current = setTimeout(showPreview, DOUBLE_CLICK_MS);
    },
    [onPreview, onOpened],
  );
}
