/**
 * How well a name matches a lower-cased query, or `undefined` when it does not match at all.
 * Lower is better: 0 exact, 1 a prefix of the label or any other field, 2 a later label word's
 * prefix (e.g. a surname), 3 any other substring hit. Everything is compared case-insensitively.
 * The @-mention list and the search page's matches rank by it.
 */
export function nameMatchTier(
  label: string,
  others: readonly string[],
  lowerQuery: string,
): 0 | 1 | 2 | 3 | undefined {
  const fields = [label, ...others].map((field) => field.toLowerCase());
  if (fields.some((field) => field === lowerQuery)) return 0;
  if (fields.some((field) => field.startsWith(lowerQuery))) return 1;
  const laterWords = fields[0]!.split(/\s+/).filter(Boolean).slice(1);
  if (laterWords.some((word) => word.startsWith(lowerQuery))) return 2;
  if (fields.some((field) => field.includes(lowerQuery))) return 3;
  return undefined;
}
