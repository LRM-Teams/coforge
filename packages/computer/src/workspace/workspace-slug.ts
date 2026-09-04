// The authoritative slug rule lives in
// apps/web/src/server/workspaces/workspace-slug.ts. packages/computer cannot
// depend on the apps/web app (wrong dependency direction across the packaging
// boundary), so this is a conservative, deliberately duplicated shape check
// rather than a shared import: lowercase letters, digits, and single hyphens
// between segments, matching WORKSPACE_SLUG_PATTERN there. It intentionally
// leaves out the reserved-slug set (an app-routing concern, not a shape
// concern) - a reserved or unknown slug still fails, just later, as
// SETUP_WORKSPACE_NOT_FOUND during the Workspace lookup RPC.
export const COMPUTER_WORKSPACE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_WORKSPACE_SLUG_LENGTH = 48;

export function isValidComputerWorkspaceSlug(slug: string): boolean {
  return COMPUTER_WORKSPACE_SLUG_PATTERN.test(slug) && slug.length <= MAX_WORKSPACE_SLUG_LENGTH;
}
