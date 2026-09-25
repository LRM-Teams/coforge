/**
 * CoForge's Workspace-slug shape: lowercase alphanumerics in single-hyphen-separated segments, at
 * most 48 characters.
 *
 * The one definition, because the two sides that check a slug cannot otherwise share it: the Web
 * app's creation and routing validation (`apps/web/src/features/workspaces/workspace-slug.ts`) and
 * the Computer, which checks the slug a setup request names
 * (`packages/computer/src/workspace/workspace-slug.ts`). The Computer cannot depend on the Web app,
 * which is why its copy had to be — in its own words — a "conservative, deliberately duplicated
 * shape check".
 *
 * The shape only. Which slugs are *reserved* is an app-routing concern and stays in the Web app;
 * an unknown or reserved slug still fails, just later, as `SETUP_WORKSPACE_NOT_FOUND` during the
 * Workspace lookup RPC.
 */
export const WORKSPACE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const WORKSPACE_SLUG_MAX_LENGTH = 48;
