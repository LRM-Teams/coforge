import { splitPlainLines } from "./split-highlighted-lines";

export interface FindMatch {
  /** 1-based, agrees with the `data-line` value the code view renders. */
  line: number;
  /** 0-based character offset into the line. */
  start: number;
  /** Exclusive end offset into the line. */
  end: number;
}

/**
 * Hard cap on how many matches are collected. A pathological query (an empty
 * or near-universal substring) against a huge file could otherwise produce
 * an unbounded array and an unbounded number of DOM ranges downstream.
 */
export const FIND_MATCH_CAP = 10_000;

/**
 * Finds every non-overlapping occurrence of `query` in `text`, searched one
 * line at a time so results line up with the code view's `data-line`
 * numbers. Pure and DOM-free: `project-file-view.tsx` maps these positions
 * onto rendered rows separately, for the CSS Custom Highlight API.
 */
export function findMatches(
  text: string,
  query: string,
  options?: { caseSensitive?: boolean },
): FindMatch[] {
  if (query === "") return [];
  const caseSensitive = options?.caseSensitive ?? false;
  const needle = caseSensitive ? query : query.toLowerCase();
  const lines = splitPlainLines(text);
  const matches: FindMatch[] = [];

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const haystack = caseSensitive ? lines[lineIndex] : lines[lineIndex].toLowerCase();
    let from = 0;
    while (from <= haystack.length - needle.length) {
      const at = haystack.indexOf(needle, from);
      if (at === -1) break;
      matches.push({ line: lineIndex + 1, start: at, end: at + needle.length });
      if (matches.length >= FIND_MATCH_CAP) return matches;
      // Non-overlapping: resume the search right after this match instead of
      // at `at + 1`, so "aa" against "aaa" reports one match, not two.
      from = at + needle.length;
    }
  }

  return matches;
}
