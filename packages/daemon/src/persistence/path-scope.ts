/**
 * One id as one path segment — the rule every store in this directory applies to the ids it turns
 * into directories, so a separator, a `.` or a control character can never become part of a path.
 *
 * These used to be five copies: the guard was `SAFE` in the consumed-sequence store (whose own
 * comment read "the same scope guard the reminder receipts use"), `SAFE` again in the reminder
 * receipts and `SAFE_SCOPE` in the App Inbox store, and the escaping was `encodeIdentity` in both
 * the consumed-sequence and draft stores (the first noting "the same identity escaping the draft
 * store uses"). The error each store raises stays its own.
 */

/** The id grammar: one alphanumeric or `_`/`-`, then up to 127 more — no separator, no `.`, no
 * leading `-`, no control character. */
const SAFE_PATH_SCOPE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Whether an id may be a path segment at all. The stores that use this refuse the id (each with
 * its own error); the stores that escape it instead use `escapePathIdentity`. */
export function isSafePathScope(value: string): boolean {
  return SAFE_PATH_SCOPE.test(value);
}

/** An id as one path segment: percent-escaped, and `.` escaped too, so an id like `..` cannot read
 * as a relative path step. */
export function escapePathIdentity(identity: string): string {
  return encodeURIComponent(identity).replaceAll(".", "%2E");
}
