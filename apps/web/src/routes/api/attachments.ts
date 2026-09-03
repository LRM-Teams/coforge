import { createFileRoute } from "@tanstack/react-router";
import type { PrismaClient } from "../../../generated/client";
import { requireBrowserUser } from "#/server/auth/require-user.server";
import { storeAttachment } from "#/server/attachments/attachment.server";
import { getDatabaseClient } from "#/server/db/client.server";
import { toPublicServerError } from "#/server/errors/public-error.server";
import { AppError, isAppError, type AppErrorCode } from "#/lib/app-error";

export const Route = createFileRoute("/api/attachments")({
  server: {
    handlers: {
      POST: ({ request }) => handleAttachmentUpload(request),
    },
  },
});

type AttachmentUploadDependencies = {
  authenticate(cookieHeader: string | undefined): { id: string };
  database(): PrismaClient | null | undefined;
  store: typeof storeAttachment;
};

const attachmentUploadDependencies: AttachmentUploadDependencies = {
  authenticate: requireBrowserUser,
  database: getDatabaseClient,
  store: storeAttachment,
};

export async function handleAttachmentUpload(
  request: Request,
  dependencies: AttachmentUploadDependencies = attachmentUploadDependencies,
): Promise<Response> {
  try {
    const user = dependencies.authenticate(request.headers.get("cookie") ?? undefined);
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw new AppError("INVALID_INPUT");
    }
    const conversationId = form.get("conversationId");
    const file = form.get("file");
    if (typeof conversationId !== "string" || !isFile(file)) throw new AppError("INVALID_INPUT");
    const db = dependencies.database();
    if (!db) throw new AppError("TEMPORARILY_UNAVAILABLE");
    return Response.json(await dependencies.store(db, { userId: user.id, conversationId, file }));
  } catch (error) {
    const publicError = toPublicServerError(error);
    if (!isAppError(publicError)) throw publicError;
    return Response.json(
      { code: publicError.code, errorId: publicError.errorId },
      {
        status: statusForErrorCode(publicError.code),
        headers: { "cache-control": "no-store" },
      },
    );
  }
}

function isFile(value: FormDataEntryValue | null): value is File {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "name") === "string" &&
    typeof Reflect.get(value, "size") === "number" &&
    typeof Reflect.get(value, "arrayBuffer") === "function"
  );
}

function statusForErrorCode(code: AppErrorCode): number {
  if (code === "INVALID_INPUT") return 400;
  if (code === "ACCESS_DENIED") return 403;
  if (code === "NOT_FOUND") return 404;
  if (code === "CONFLICT") return 409;
  if (code === "TEMPORARILY_UNAVAILABLE") return 503;
  return 500;
}
