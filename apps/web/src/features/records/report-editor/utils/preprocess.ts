import { preprocessFileCards } from "./file-cards";

/**
 * Minimal markdown preprocess before TipTap markdown parse.
 * Mentions and Multica linkify are stubbed — only file-card syntax is rewritten.
 */
export function preprocessMarkdown(markdown: string, _opts?: { linkify?: boolean }): string {
  if (!markdown) return "";
  return preprocessFileCards(markdown);
}
