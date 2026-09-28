/**
 * Replying to a *part* of a message: the reader highlights a phrase inside a message body, a reply
 * affordance appears at the selection, and what they highlighted lands in the composer as a
 * markdown blockquote credited to the message's author.
 *
 * Everything here is text in / text out, so the shape of a quote and its bound are testable
 * without a DOM: `message-row.tsx` owns reading the browser selection, `message-composer.tsx` owns
 * inserting the result into the draft, and this module owns what a quote *is*.
 */

/** Longest selection a quote carries. A highlight is a phrase or a sentence, never a document, so
 * a stray select-all (or a triple-click) cannot turn the composer into a wall of quoted history —
 * the text is cut and marked instead. Mirrors the other preview bounds in this feature (e.g.
 * `HELD_PREVIEW_CHARS`), which cap what one interactive step may carry. */
export const QUOTE_SELECTION_MAX_CHARS = 600;

/** What a quote needs to know about the message it was highlighted out of. */
export type SelectionQuoteSource = {
  /** The reader-visible sender name, already resolved by the row (`MessageView.senderName`). */
  author: string;
  /** The message's local clock label, as the row prints it beside the sender. */
  time: string;
};

/** The highlighted text, normalized: outer blank space dropped, and the length bound applied with
 * a trailing ellipsis so a cut quote is visibly cut rather than silently shortened. */
export function quoteSelectionText(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length <= QUOTE_SELECTION_MAX_CHARS) return trimmed;
  return `${trimmed.slice(0, QUOTE_SELECTION_MAX_CHARS).trimEnd()}…`;
}

/**
 * A markdown blockquote of the highlighted text, credited on its own first line, ready for the
 * reply to be typed under it.
 *
 * Every highlighted line is quoted (`> `), so a multi-line highlight stays one quote block instead
 * of leaking its tail into the draft as plain text; an inner blank line becomes a bare `>` so the
 * block does not break in half. Blank input yields `""` — the caller treats that as "nothing to
 * quote" rather than inserting an empty block.
 */
export function formatSelectionQuote(source: SelectionQuoteSource, raw: string): string {
  const text = quoteSelectionText(raw);
  if (!text) return "";
  const author = source.author.trim();
  const time = source.time.trim();
  const credit = author ? (time ? `> **${author}** ${time}:` : `> **${author}**:`) : undefined;
  const quoted = text.split("\n").map((line) => (line ? `> ${line}`.trimEnd() : ">"));
  return credit ? [credit, ...quoted].join("\n") : quoted.join("\n");
}

/** Rendered size of the reply-to-selection affordance bar (three icon buttons with dividers in a
 * bordered strip), in px; used only to place and clamp it, never to style it. */
export const AFFORDANCE_WIDTH = 100;
export const AFFORDANCE_HEIGHT = 34;

/** The subset of `DOMRect` the placement math reads, so it stays testable without a DOM. */
export type AffordanceRect = Pick<
  DOMRect,
  "top" | "right" | "bottom" | "left" | "width" | "height"
>;

/** Gap between a touch highlight's bottom and the bar below it, in px: clears the selection's end
 * handle (the knob the platform draws under the last selected line) so the bar never sits on it. */
export const TOUCH_AFFORDANCE_GAP = 20;

/**
 * Where the reply-to-selection affordance goes, relative to the message body's own box. This
 * follows the standard selection-toolbar logic (Medium's highlight menu, Floating UI's
 * `flip`/`shift`): on the preferred side of the highlight with a gap, horizontally centered on
 * it. A mouse selection prefers *above* — above the *highlight*, not inside the body, so on the
 * body's first line the affordance overflows upward over the sender header rather than covering
 * the highlight. A touch selection prefers *below*: the platform raises its own edit menu above
 * the highlight (iOS Copy/Look Up, Android's selection toolbar) and web content cannot suppress
 * it (`-webkit-touch-callout` only covers the link callout), so the bar takes the other side.
 * The bar flips to the other side only when the preferred one would cross the visible boundary
 * (the history scroller's edges) and the other one fits; with room on neither side (a highlight
 * taller than the visible history) it keeps its side, pinned inside that boundary. Horizontally
 * it stays clamped inside the body when centering would overflow either edge.
 */
export function selectionAffordancePlacement(
  highlight: AffordanceRect,
  container: AffordanceRect,
  boundary?: { top: number; bottom?: number },
  side: "above" | "below" = "above",
): { top: number; left: number } {
  const above = highlight.top - AFFORDANCE_HEIGHT - 4;
  const below = highlight.bottom + (side === "below" ? TOUCH_AFFORDANCE_GAP : 4);
  const fitsAbove = !boundary || above >= boundary.top;
  const fitsBelow = boundary?.bottom === undefined || below + AFFORDANCE_HEIGHT <= boundary.bottom;
  const preferredFits = side === "above" ? fitsAbove : fitsBelow;
  const otherFits = side === "above" ? fitsBelow : fitsAbove;
  const top = preferredFits
    ? side === "above"
      ? above
      : below
    : otherFits
      ? side === "above"
        ? below
        : above
      : // Room on neither side: keep the preferred side, pinned inside the visible region.
        Math.max(
          boundary?.top ?? -Infinity,
          Math.min(
            side === "above" ? above : below,
            (boundary?.bottom ?? Infinity) - AFFORDANCE_HEIGHT,
          ),
        );
  return {
    top: top - container.top,
    left: Math.max(
      0,
      Math.min(
        highlight.left + highlight.width / 2 - container.left - AFFORDANCE_WIDTH / 2,
        container.width - AFFORDANCE_WIDTH,
      ),
    ),
  };
}
