import { deLocalizeHref } from "#src/paraglide/runtime";
import { isValidWorkspaceSlug } from "./workspace-slug";

/** Every app page lives under `/w/<workspaceSlug>/…` (after the locale prefix). */
const WORKSPACE_PATH = /^\/w\/([^/]+)(?:\/|$)/;

/** The Workspace a page path names, or `undefined` outside `/w/<slug>`. */
export function workspaceSlugFromPath(pathname: string): string | undefined {
  const slug = WORKSPACE_PATH.exec(deLocalizeHref(pathname))?.[1];
  return slug && isValidWorkspaceSlug(slug) ? slug : undefined;
}
