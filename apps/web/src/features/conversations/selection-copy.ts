/**
 * Copying a highlight out of a message body, in the two shapes readers ask for: *styled* — the
 * rendered fragment as rich text (`text/html` with a `text/plain` fallback), so pasting into a
 * doc or another chat keeps bold/links/code — and *Markdown*, the fragment converted back to
 * Markdown source so it can be pasted into an editor as markup.
 *
 * The fragment comes from the live selection (`Range.cloneContents`): the body it was copied out
 * of already passed through `rehype-sanitize` at render time, and the mention chips it may contain
 * carry only their resolved `@label` text. HTML→Markdown conversion is Turndown with its GFM
 * plugin — the same GFM feature set (strikethrough, tables) the body renderer accepts — so a copy
 * round-trips through the composer's Markdown instead of flattening to plain text.
 */
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

import { copyText } from "../records/report-editor/lib/clipboard";

/** One service for the feature: fenced code, ATX headings, `-` bullets and `*` emphasis match
 * what the composer and body renderer accept. */
const turndown = new TurndownService({
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  emDelimiter: "*",
  headingStyle: "atx",
});
turndown.use(gfm);

/** The rendered fragment under a selection, as an HTML string. */
export function selectionFragmentHtml(range: Range): string {
  const holder = document.createElement("div");
  holder.appendChild(range.cloneContents());
  return holder.innerHTML;
}

/** A rendered fragment as Markdown source, trimmed of the trailing blank line Turndown adds. */
export function fragmentHtmlToMarkdown(html: string): string {
  return turndown.turndown(html).trim();
}

/**
 * Writes the fragment as rich text so a paste elsewhere keeps its formatting. Falls back to the
 * plain text when the async Clipboard API (or `text/html` support) is unavailable or denied.
 */
export async function copyFragmentStyled(html: string, plainText: string): Promise<boolean> {
  if (
    typeof navigator !== "undefined" &&
    typeof navigator.clipboard?.write === "function" &&
    typeof ClipboardItem !== "undefined"
  ) {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([plainText], { type: "text/plain" }),
        }),
      ]);
      return true;
    } catch {
      // Fall through to the plain-text copy.
    }
  }
  return copyText(plainText);
}

/** Writes the fragment's Markdown source as plain clipboard text. */
export function copyFragmentMarkdown(html: string): Promise<boolean> {
  return copyText(fragmentHtmlToMarkdown(html));
}
