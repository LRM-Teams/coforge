export type ExcerptPart = { text: string; match: boolean };

/** Characters kept before the first match, so the match stays inside a two-line excerpt. */
const LEAD = 40;

/**
 * A result's excerpt: the text starting a little before the first match (with an ellipsis when
 * cut), split into parts where each term match is flagged, case-insensitively.
 */
export function searchExcerpt(text: string, terms: string[]): ExcerptPart[] {
  const flat = text.replace(/\s+/g, " ").trim();
  if (terms.length === 0) return [{ text: flat, match: false }];
  const pattern = new RegExp(
    `(${terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`,
    "gi",
  );
  const first = flat.search(pattern);
  const start = first > LEAD ? first - LEAD : 0;
  const shown = start > 0 ? `…${flat.slice(start)}` : flat;
  return shown
    .split(pattern)
    .filter(Boolean)
    .map((part) => ({
      text: part,
      match: terms.some((t) => t.toLowerCase() === part.toLowerCase()),
    }));
}
