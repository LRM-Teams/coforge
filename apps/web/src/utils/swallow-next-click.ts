/**
 * Swallow the single `click` that a pointer gesture produces *after* the element it started on has
 * unmounted. A popup that picks on `pointerdown` and then closes leaves the browser's trailing
 * `click` to land on whatever is now under the pointer — for the mention popup, the message row
 * behind it, whose tap opens its action sheet. The row decides from the click's target, so it never
 * sees the press it should have ignored.
 *
 * One listener, one click: it removes itself as soon as it has swallowed one, and gives up after
 * `expiryMs` so a keyboard pick — which produces no click — cannot leave it lying in wait to
 * swallow some later, unrelated press.
 */
export function swallowNextClick(
  target: Pick<EventTarget, "addEventListener" | "removeEventListener"> = window,
  expiryMs = 500,
): void {
  function swallow(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    target.removeEventListener("click", swallow, true);
  }
  target.addEventListener("click", swallow, true);
  setTimeout(() => target.removeEventListener("click", swallow, true), expiryMs);
}
