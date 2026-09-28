/**
 * The id grammar every scope field shares: one alphanumeric or `_`/`-`, then up to 127 more. A
 * request's `requestId`, `workspaceId`, `computerId` and `agentId`, an Agent's `launchId`, a daemon
 * instance id, a reminder's owner or event id — all of them are read as one path segment or one
 * identifier somewhere, so they are one rule.
 *
 * `SCOPE_ID_PATTERN.test(value)` on its own is **not** the rule, and this module exists because three
 * copies of the pattern disagreed about that. A missing id stringifies to `"undefined"` (or
 * `"null"`), which the pattern happily matches, so a payload that simply left the field out would
 * pass a pattern-only check. The protobuf encoder used to cover for this by refusing an absent field
 * and the JSON path does not, which is why the string check belongs here, once, rather than at each
 * call site where it can be forgotten.
 */
export const SCOPE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Whether `value` is a scope id: present, a string, and matching the grammar. */
export function isScopeId(value: unknown): boolean {
  return typeof value === "string" && SCOPE_ID_PATTERN.test(value);
}
