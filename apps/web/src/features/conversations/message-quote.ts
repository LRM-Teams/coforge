/**
 * Replying to a *part* of a message: the reader highlights a phrase inside a message body, a reply
 * affordance appears at the selection, and what they highlighted lands in the composer as a
 * markdown blockquote.
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

/** The highlighted text, normalized: outer blank space dropped, and the length bound applied with
 * a trailing ellipsis so a cut quote is visibly cut rather than silently shortened. */
export function quoteSelectionText(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length <= QUOTE_SELECTION_MAX_CHARS) return trimmed;
  return `${trimmed.slice(0, QUOTE_SELECTION_MAX_CHARS).trimEnd()}…`;
}

/**
 * A markdown blockquote of the highlighted text, ready for the reply to be typed under it. No
 * attribution: the reply already sits in the same conversation, right under the message it quotes,
 * so crediting the author would only repeat what the reader can see.
 *
 * Every highlighted line is quoted (`> `), so a multi-line highlight stays one quote block instead
 * of leaking its tail into the draft as plain text; an inner blank line becomes a bare `>` so the
 * block does not break in half. Blank input yields `""` — the caller treats that as "nothing to
 * quote" rather than inserting an empty block.
 */
export function formatSelectionQuote(raw: string): string {
  const text = quoteSelectionText(raw);
  if (!text) return "";
  return text
    .split("\n")
    .map((line) => (line ? `> ${line}`.trimEnd() : ">"))
    .join("\n");
}
