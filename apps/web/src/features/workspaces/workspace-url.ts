import { deLocalizeHref } from "#src/paraglide/runtime";
import { isValidWorkspaceSlug } from "./workspace-slug";

/** Every app page lives under `/w/<workspaceSlug>/…` (after the locale prefix). */

/** The de-localized path of a page in a Workspace: its home, or `rest` (`/settings`, …) under it. */
export function workspacePath(slug: string, rest = ""): string {
  return `/w/${slug}${rest}`;
}
const WORKSPACE_PATH = /^\/w\/([^/?#]+)(.*)$/;

/**
 * A page path split into the Workspace it names and the rest (`""`, `/channel/<id>`, …), or
 * `undefined` outside `/w/<slug>` or for a malformed slug. Accepts localized or de-localized paths.
 */
export function splitWorkspacePath(path: string): { slug: string; rest: string } | undefined {
  const match = WORKSPACE_PATH.exec(deLocalizeHref(path));
  if (!match || !isValidWorkspaceSlug(match[1]!)) return undefined;
  const rest = match[2]!;
  return rest === "" || /^[/?#]/.test(rest) ? { slug: match[1]!, rest } : undefined;
}

/** The Workspace a page path names, or `undefined` outside `/w/<slug>`. */
export function workspaceSlugFromPath(pathname: string): string | undefined {
  return splitWorkspacePath(pathname)?.slug;
}
