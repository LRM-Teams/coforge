import { getFileDelivery, type FileDelivery } from "../files/file-delivery.server";
import { isInlineImage } from "./attachment-response.server";

export type AttachmentView = {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  /** A short-lived signed CDN URL, present only for an inline-eligible image when delivery is
   * configured. `<img src>` should prefer this over `/api/attachments/:id` so the bytes never
   * round-trip through the backend; once it expires, that route is the fallback (it redirects to
   * a freshly signed URL, or streams the bytes when delivery is not configured). */
  previewUrl?: string;
};

/**
 * The browser-facing shape of one attachment, attached to every browser message payload — page
 * reads, polled updates, and the immediate response to the sender's own send — so `<img src>`
 * can be pointed straight at the CDN (Discord-style) instead of the backend proxy. `objectKey`
 * exists on the input only so this function can sign a delivery URL with it; it is never part of
 * the returned view and must never reach the client, logs, or analytics.
 */
export function attachmentView(
  row: { id: string; fileName: string; contentType: string; sizeBytes: number; objectKey: string },
  delivery: FileDelivery | null = getFileDelivery(),
): AttachmentView {
  const previewUrl =
    delivery && isInlineImage(row.contentType) ? delivery.signedUrl(row.objectKey).url : undefined;
  return {
    id: row.id,
    fileName: row.fileName,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    ...(previewUrl ? { previewUrl } : {}),
  };
}
