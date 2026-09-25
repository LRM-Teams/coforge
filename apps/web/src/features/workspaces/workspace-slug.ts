import { WORKSPACE_SLUG_MAX_LENGTH, WORKSPACE_SLUG_PATTERN } from "@lrm/coforge-sdk/internal";
import { nameToSlug } from "#src/lib/slug";

const RESERVED_WORKSPACE_SLUGS = new Set([
  "admin",
  "api",
  "auth",
  "computers",
  "en",
  "health",
  "login",
  "messages",
  "oauth",
  "settings",
  "workspace",
  "workspaces",
]);

/** A name's slug, cut to the length the shape rule allows (`WORKSPACE_SLUG_MAX_LENGTH`). */
export function nameToWorkspaceSlug(name: string): string {
  return nameToSlug(name, WORKSPACE_SLUG_MAX_LENGTH);
}

export function isReservedWorkspaceSlug(slug: string): boolean {
  return RESERVED_WORKSPACE_SLUGS.has(slug);
}

/** The shape rule is the shared one (`@lrm/coforge-sdk/internal`), so the Computer's setup check
 * and this app's creation check cannot drift; the reserved names above stay this app's own. */
export function isValidWorkspaceSlug(slug: string): boolean {
  return WORKSPACE_SLUG_PATTERN.test(slug) && slug.length <= WORKSPACE_SLUG_MAX_LENGTH;
}
