import { IMMUTABLE_IMAGE_CACHE_CONTROL } from "./cache-control.server";

/**
 * The headers for serving a private image's bytes: the viewer's own avatar, an agent's, a Workspace
 * member's, the Computer creator's, a project's icon, and the Workspace's icon.
 *
 * All six routes answer the same way and have to keep answering the same way, which is why the
 * block lives here rather than six times: the image is shown inline (`Content-Disposition:
 * inline`), the browser is told not to reinterpret it as anything else (`nosniff` — these are
 * user-supplied bytes), the viewer may keep it for the year the URL's version token makes safe, and
 * the answer varies by cookie because who may see it depends on the session.
 *
 * The project icon reached this by being the odd one out: it served `private, no-cache` with its own
 * capitalized header names, while `projectIconUrl` had already versioned the URL with
 * `versionedImagePath`, so the bytes behind it never change and there was nothing to revalidate.
 * The four avatars differ from each other only in which variable holds the content type; if one of
 * them ever gains a reason to answer differently, it should stop using this and say so, rather than
 * editing the shared block and changing the others.
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
