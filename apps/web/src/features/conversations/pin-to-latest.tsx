import { ScriptOnce } from "@tanstack/react-router";

/**
 * Scrolls the pane's history to its end while the server's page parses, so the first paint shows a
 * conversation's newest messages rather than the top of its window, and hydration finds it there
 * already (the pane's own open position, which decides the rest, runs after hydration). Placed
 * after the composer, when the pane's height is final. A message hash names another position, so
 * it is left to the pane. `ScriptOnce` emits the script only in the server's markup, and the
 * script removes itself, so the client renders nothing in its place.
 */
export function PinToLatestOnFirstPaint() {
  return (
    <ScriptOnce>
      {`if(!location.hash){var h=document.currentScript.parentElement.querySelector("[data-scroll-restoration-id]");if(h)h.scrollTop=h.scrollHeight}`}
    </ScriptOnce>
  );
}
