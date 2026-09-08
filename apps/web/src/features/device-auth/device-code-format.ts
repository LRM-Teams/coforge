/** Shared by the server's lookup path and the browser page, so it carries no server-only imports:
 * pulling it out of `device-auth.server.ts` is what keeps the route from dragging the database
 * client into the client bundle. */

export const USER_CODE_LENGTH = 8;

/** Codes are shown as `XXXX-XXXX` but may be typed with or without the dash, in any case, and
 * with stray whitespace from a copy-paste. Everything normalizes to the canonical form so all of
 * those resolve to the same grant. */
export function normalizeUserCode(value: string): string {
  return value.replace(/[\s-]/g, "").toUpperCase();
}

export function formatUserCode(normalized: string): string {
  return normalized.length > 4 ? `${normalized.slice(0, 4)}-${normalized.slice(4)}` : normalized;
}
