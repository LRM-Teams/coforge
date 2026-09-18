/** Image types the browser may render inline from `/api/attachments/:id`. Everything else is
 * delivered as an opaque download so a stored HTML/SVG/PDF can never execute in the app origin. */
const INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Whether `contentType` is one of the raster image types the browser may render inline. */
export function isInlineImage(contentType: string): boolean {
  return INLINE_IMAGE_TYPES.has(contentType);
}

/**
 * Types the browser may render, but only from the signed delivery (CDN) origin — never from this
 * one. A PDF is read in the browser's own viewer, which needs a real URL with a real content type;
 * serving that from our origin would put a document the sender controls inside our session's
 * origin, which is exactly what `INLINE_IMAGE_TYPES` exists to prevent. On the delivery origin it
 * has no access to our cookies, so the viewer is safe there. Where delivery is not configured
 * there is no such URL, and the attachment stays an opaque download (`attachmentResponseHeaders`
 * is deliberately not widened).
 */
const DELIVERY_INLINE_TYPES = new Set(["application/pdf"]);

/** Whether `contentType` may be previewed, but only through a signed delivery URL. */
export function isDeliveryInlinePreview(contentType: string): boolean {
  return DELIVERY_INLINE_TYPES.has(contentType);
}

/**
 * Response headers for one authorized attachment. `forceDownload` (the `?download` query)
 * always yields `Content-Disposition: attachment`; otherwise safe raster images are served with
 * their real content type and `inline` so `<img src>` works, and the rest stay octet-stream.
 */
export function attachmentResponseHeaders(
  attachment: { fileName: string; contentType: string },
  forceDownload: boolean,
): Record<string, string> {
  const inline = !forceDownload && isInlineImage(attachment.contentType);
  const fileName = attachment.fileName.replace(/["\\\r\n]/g, "_");
  return {
    "Content-Type": inline ? attachment.contentType : "application/octet-stream",
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${fileName}"`,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
  };
}
