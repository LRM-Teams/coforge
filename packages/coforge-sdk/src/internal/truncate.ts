/**
 * The single unit every Activity length cap is expressed in: Unicode code
 * points. `String.length`/`String.slice` count UTF-16 code units, so they
 * count an emoji (or any other astral character) as two and can split a
 * surrogate pair in half, leaving a lone surrogate on the wire. Spreading
 * iterates code points instead, keeping every cap below an exact,
 * pair-safe budget.
 */

/** Number of Unicode code points in `value`. */
export function codePointLength(value: string): number {
  return [...value].length;
}

/**
 * First `max` Unicode code points of `value`; `value` itself when already
 * within budget. Never splits a surrogate pair.
 */
export function truncateCodePoints(value: string, max: number): string {
  const chars = [...value];
  return chars.length > max ? chars.slice(0, max).join("") : value;
}
