import { useSyncExternalStore } from "react";

import { attachmentPreviewKind, isPdfAttachment } from "./attachment-preview-kind";

const noSubscription = () => () => {};

/**
 * `attachmentPreviewKind` with the page's origin, for a component. The server render and the
 * render that hydrates its markup have no origin, so a PDF is download-only in both and the markup
 * agrees; the browser then reads the origin and the PDF offers its preview. Only a PDF depends on
 * the origin, so no other attachment renders again for it.
 */
export function useAttachmentPreviewKind(
  fileName: string,
  contentType: string,
  previewUrl: string | undefined,
) {
  const needsOrigin = isPdfAttachment(fileName, contentType);
  const applicationOrigin = useSyncExternalStore(
    noSubscription,
    () => (needsOrigin ? location.origin : undefined),
    () => undefined,
  );
  return attachmentPreviewKind(fileName, contentType, previewUrl, applicationOrigin);
}
