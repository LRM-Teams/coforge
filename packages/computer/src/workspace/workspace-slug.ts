import { WORKSPACE_SLUG_MAX_LENGTH, WORKSPACE_SLUG_PATTERN } from "@lrm/coforge-sdk/internal";

/**
 * Whether `slug` is a Workspace slug: the shape rule the Web app validates on creation
 * (`apps/web/src/features/workspaces/workspace-slug.ts`), read from the SDK because this package
 * cannot depend on the Web app — the SDK is the one place both sides can reach.
 *
 * It intentionally leaves out the reserved-slug set (an app-routing concern, not a shape concern) —
 * a reserved or unknown slug still fails, just later, as `SETUP_WORKSPACE_NOT_FOUND` during the
 * Workspace lookup RPC.
 */
export function isValidComputerWorkspaceSlug(slug: string): boolean {
  return WORKSPACE_SLUG_PATTERN.test(slug) && slug.length <= WORKSPACE_SLUG_MAX_LENGTH;
}
