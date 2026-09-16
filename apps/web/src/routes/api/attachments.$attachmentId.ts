import { createFileRoute } from "@tanstack/react-router";
import type { PrismaClient } from "../../../generated/client";
import { requireBrowserUser } from "#/server/auth/require-user.server";
import {
  attachmentResponseHeaders,
  isInlineImage,
} from "#/server/attachments/attachment-response.server";
import { readAuthorizedAttachment } from "#/server/attachments/attachment.server";
import { getDatabaseClient } from "#/server/db/client.server";
import { getFileDelivery, type FileDelivery } from "#/server/files/file-delivery.server";
import type { StoredFile } from "#/server/files/file-storage.server";

export const Route = createFileRoute("/api/attachments/$attachmentId")({
  server: {
    handlers: {
      GET: ({ params, request }) =>
        handleAttachmentDownload(request, params, attachmentDownloadDependencies),
    },
  },
});

type AttachmentDownloadDependencies = {
  authenticate(cookieHeader: string | undefined): { id: string };
  database(): PrismaClient | null | undefined;
  read(
    db: PrismaClient,
    input: { attachmentId: string; userId: string },
  ): Promise<{
    attachment: { fileName: string; contentType: string; objectKey: string };
    open(): Promise<StoredFile>;
  }>;
  delivery(): FileDelivery | null;
};

const attachmentDownloadDependencies: AttachmentDownloadDependencies = {
  authenticate: requireBrowserUser,
  database: getDatabaseClient,
  read: readAuthorizedAttachment,
  delivery: getFileDelivery,
};

/**
 * Serves one authorized attachment. Forced downloads (`?download`), non-image content types,
 * and deployments without a `FileDelivery` all stream the bytes through the backend exactly as
 * before. Otherwise-eligible inline images redirect to a short-lived signed CDN URL instead, so
 * the bytes never round-trip through the backend at all.
 */
export async function handleAttachmentDownload(
  request: Request,
  params: { attachmentId: string },
  dependencies: AttachmentDownloadDependencies = attachmentDownloadDependencies,
): Promise<Response> {
  const user = dependencies.authenticate(request.headers.get("cookie") ?? undefined);
  const db = dependencies.database();
  if (!db) return new Response("persistence unavailable", { status: 503 });
  try {
    const { attachment, open } = await dependencies.read(db, {
      attachmentId: params.attachmentId,
      userId: user.id,
    });
    const forceDownload = new URL(request.url).searchParams.has("download");
    const delivery =
      !forceDownload && isInlineImage(attachment.contentType) ? dependencies.delivery() : null;
    if (delivery) {
      const { url } = delivery.signedUrl(attachment.objectKey);
      return new Response(null, {
        status: 302,
        headers: {
          Location: url,
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    const file = await open();
    return new Response(file.body, {
      headers: attachmentResponseHeaders(attachment, forceDownload),
    });
  } catch {
    return new Response("not found", { status: 404 });
  }
}
