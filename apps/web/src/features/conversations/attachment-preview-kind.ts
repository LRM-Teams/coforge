/**
 * Which preview an attachment supports. Pure decision, kept out of the component so the rule that
 * governs it — above all the cross-origin requirement for a PDF — is testable on its own.
 */
export type AttachmentPreviewKind = "markdown" | "html" | "video" | "audio" | "pdf";

const MARKDOWN_EXTENSIONS = new Set(["md", "markdown", "mdown", "mkd"]);
const HTML_EXTENSIONS = new Set(["html", "htm"]);

/**
 * The media types a `<video>`/`<audio>` element may be handed, and the exact MIME type used for
 * each. The element is fed a Blob built with one of these, so an attachment's bytes are never
 * sniffed into something else.
 */
export const MEDIA_TYPES = new Map<string, { kind: "video" | "audio"; mimeType: string }>([
  ["mp4", { kind: "video", mimeType: "video/mp4" }],
  ["m4v", { kind: "video", mimeType: "video/mp4" }],
  ["webm", { kind: "video", mimeType: "video/webm" }],
  ["ogv", { kind: "video", mimeType: "video/ogg" }],
  ["mp3", { kind: "audio", mimeType: "audio/mpeg" }],
  ["m4a", { kind: "audio", mimeType: "audio/mp4" }],
  ["wav", { kind: "audio", mimeType: "audio/wav" }],
  ["oga", { kind: "audio", mimeType: "audio/ogg" }],
  ["ogg", { kind: "audio", mimeType: "audio/ogg" }],
]);

function extensionOf(fileName: string): string {
  return fileName.includes(".") ? fileName.split(".").pop()!.toLowerCase() : "";
}

/** The MIME type a previewable media attachment is played as, from our own allowlist. */
export function mediaMimeType(fileName: string): string | null {
  return MEDIA_TYPES.get(extensionOf(fileName))?.mimeType ?? null;
}

/**
 * Whether `previewUrl` may be framed as a document.
 *
 * A PDF is read in the browser's own viewer, which cannot be sandboxed — an empty `sandbox`
 * blocks the viewer outright — so the only isolation left is the origin boundary: the document
 * must come from somewhere that holds none of this application's cookies. That requirement is
 * enforced here rather than described in a comment, and it fails closed: an absent, relative,
 * unparseable or same-origin URL is not previewable, and the attachment stays a download.
 *
 * `applicationOrigin` is the page's own origin, and an unknown origin is not previewable either.
 * During server rendering there is nothing to compare against, so a frame emitted there would be
 * decided by no check at all: the browser can begin loading `src` from the SSR HTML — with host
 * cookies, if the delivery origin is misconfigured to this one — before hydration re-runs this
 * function and removes it. A check that only runs after the frame exists is not fail-closed, so
 * the answer without a known origin is "no". Every caller renders inside the conversation pane's
 * `ClientOnly` boundary today, which is why this costs no visible behaviour: the browser always
 * has an origin to compare.
 */
export function isFrameableDocumentUrl(
  previewUrl: string | undefined,
  applicationOrigin: string | undefined,
): boolean {
  if (!previewUrl || !applicationOrigin) return false;
  let url: URL;
  try {
    url = new URL(previewUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  return url.origin !== applicationOrigin;
}

/**
 * Which preview one attachment supports, or `null` for the rest (which stay download-only).
 *
 * The file name decides first: an upload's stored content type is whatever the sender's browser
 * guessed, and a `.md` file routinely arrives as `text/plain` or `application/octet-stream`.
 */
export function attachmentPreviewKind(
  fileName: string,
  contentType: string,
  /** The signed delivery URL, when the server supplied one. Required for a PDF, and only when it
   * is genuinely off this origin — see `isFrameableDocumentUrl`. */
  previewUrl?: string,
  /** The page's own origin; absent during server rendering. */
  applicationOrigin: string | undefined = globalThis.location?.origin,
): AttachmentPreviewKind | null {
  const extension = extensionOf(fileName);
  if (extension === "pdf" || contentType === "application/pdf")
    return isFrameableDocumentUrl(previewUrl, applicationOrigin) ? "pdf" : null;
  if (MARKDOWN_EXTENSIONS.has(extension)) return "markdown";
  if (HTML_EXTENSIONS.has(extension)) return "html";
  const media = MEDIA_TYPES.get(extension);
  if (media) return media.kind;
  if (contentType === "text/markdown") return "markdown";
  if (contentType === "text/html") return "html";
  return null;
}
