export const WORKSPACE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

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

export function nameToWorkspaceSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}

export function isReservedWorkspaceSlug(slug: string): boolean {
  return RESERVED_WORKSPACE_SLUGS.has(slug);
}

export function isValidWorkspaceSlug(slug: string): boolean {
  return WORKSPACE_SLUG_PATTERN.test(slug) && slug.length <= 48;
}
