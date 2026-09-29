import { IMMUTABLE_IMAGE_CACHE_CONTROL } from "./cache-control.server";

/**
 * The headers for serving a private image's bytes: an avatar (the viewer's own, an Agent's, a
 * Workspace member's, the Computer creator's), a project's icon, or the Workspace's icon.
 *
 * Every private image route answers the same way: the image is shown inline (`Content-Disposition:
 * inline`), the browser is told not to reinterpret it as anything else (`nosniff` — these are
 * user-supplied bytes), the viewer may keep it for the year the URL's version token makes safe, and
 * the answer varies by cookie because who may see it depends on the session. A route that needs a
 * different answer stops using this and says why, rather than editing the shared block.
 */
export function privateImageHeaders(contentType: string): Record<string, string> {
  return {
    "content-type": contentType,
    "content-disposition": "inline",
    "x-content-type-options": "nosniff",
    "cache-control": IMMUTABLE_IMAGE_CACHE_CONTROL,
    vary: "cookie",
  };
}
