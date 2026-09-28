import { getFileDelivery, type FileDelivery } from "#src/server/files/file-delivery.server";
import { isDeliveryInlinePreview, isInlineImage } from "./attachment-response.server";

export type AttachmentView = {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  /** A short-lived signed CDN URL, present for an inline-eligible image and for a type that may
   * only be previewed off our own origin (a PDF) when delivery is configured. `<img src>` should
   * prefer this over `/api/attachments/:id` so the bytes never round-trip through the backend;
   * once it expires, that route is the fallback (it redirects to a freshly signed URL, or streams
   * the bytes when delivery is not configured). Its absence is also the client's signal that a
   * PDF cannot be previewed in this deployment, so it offers the download instead. */
  previewUrl?: string;
};

/**
 * The browser-facing shape of one attachment, attached to every browser message payload — page
 * reads, polled updates, and the immediate response to the sender's own send — so `<img src>`
 * can be pointed straight at the CDN (Discord-style) instead of the backend proxy. `objectKey`
 * exists on the input only so this function can sign a delivery URL with it; it is never part of
 * the returned view and must never reach the client, logs, or analytics.
 */
/** A signing failure must never take a message read down: the client falls back to the
 * authenticated route, which streams the bytes. Logged once per process without the key. */
function signPreviewUrl(delivery: FileDelivery, objectKey: string): string | undefined {
  try {
    return delivery.signedUrl(objectKey).url;
  } catch (error) {
    if (!signingFailureLogged) {
      signingFailureLogged = true;
      console.error(
        JSON.stringify({
          event: "file_delivery_signing_failed",
          errorType: error instanceof Error ? error.name : typeof error,
        }),
      );
    }
    return undefined;
  }
}

let signingFailureLogged = false;

export function attachmentView(
  row: { id: string; fileName: string; contentType: string; sizeBytes: number; objectKey: string },
  delivery: FileDelivery | null = getFileDelivery(),
): AttachmentView {
  const previewUrl =
    delivery && (isInlineImage(row.contentType) || isDeliveryInlinePreview(row.contentType))
      ? signPreviewUrl(delivery, row.objectKey)
      : undefined;
  return {
    id: row.id,
    fileName: row.fileName,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    ...(previewUrl ? { previewUrl } : {}),
  };
}
