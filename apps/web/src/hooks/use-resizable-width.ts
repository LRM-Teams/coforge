import { useCallback, useEffect, useState, type PointerEvent as ReactPointerEvent } from "react";

/**
 * A user-adjustable panel width, dragged from a handle on the panel's leading edge and
 * remembered per `storageKey`. The panel sits at the right of the nearest ancestor marked
 * `data-resize-container`, so the width is the distance from the pointer to that edge.
 */
export function useResizableWidth({
  storageKey,
  initial,
  min,
  maxRatio,
}: {
  storageKey: string;
  initial: number;
  min: number;
  /** Largest share of the container the panel may take. */
  maxRatio: number;
}) {
  const [width, setWidth] = useState(initial);
  useEffect(() => {
    try {
      const stored = Number(window.localStorage.getItem(storageKey));
      if (Number.isFinite(stored) && stored >= min) setWidth(stored);
    } catch {
      // Storage may be unavailable; the default width still works.
    }
  }, [storageKey, min]);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      // The panel's own box shrinks as it is dragged; measure against the layout it sits in.
      const container = event.currentTarget.closest<HTMLElement>("[data-resize-container]");
      if (!container || event.button !== 0) return;
      event.preventDefault();
      const handle = event.currentTarget;
      handle.setPointerCapture(event.pointerId);
      let next = width;
      const move = (pointer: PointerEvent) => {
        const bounds = container.getBoundingClientRect();
        next = Math.round(
          Math.min(Math.max(bounds.right - pointer.clientX, min), bounds.width * maxRatio),
        );
        setWidth(next);
      };
      const stop = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", stop);
        handle.removeEventListener("pointercancel", stop);
        try {
          window.localStorage.setItem(storageKey, String(next));
        } catch {
          // Not remembered this time; still resized for the session.
        }
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", stop);
      handle.addEventListener("pointercancel", stop);
    },
    [width, min, maxRatio, storageKey],
  );

  return { width, onPointerDown };
}
