import { IMMUTABLE_IMAGE_CACHE_CONTROL } from "./cache-control.server";

/**
 * The headers for serving an avatar's bytes.
 *
 * All four avatar routes — the viewer's own, an agent's, a Workspace member's, and the Computer
 * creator's — answer the same way and have to keep answering the same way, which is why the block
 * lives here rather than four times: the image is shown inline (`Content-Disposition: inline`), the
 * browser is told not to reinterpret it as anything else (`nosniff` — these are user-supplied
 * bytes), the viewer may keep it for the year the URL's version token makes safe, and the answer
 * varies by cookie because who may see it depends on the session.
 */
export function avatarImageHeaders(contentType: string): Record<string, string> {
  return {
    "content-type": contentType,
    "content-disposition": "inline",
    "x-content-type-options": "nosniff",
    "cache-control": IMMUTABLE_IMAGE_CACHE_CONTROL,
    vary: "cookie",
  };
}
