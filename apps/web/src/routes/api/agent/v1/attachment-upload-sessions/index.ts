import { createFileRoute } from "@tanstack/react-router";
import { UUID_LIKE_PATTERN, MIME_TYPE_PATTERN } from "@lrm/coforge-sdk/internal";
import { errorResponse } from "#src/server/agents/agent-http-error.server";
import { agentAuthMiddleware } from "#src/server/agents/agent-http-middleware.server";
import {
  createAttachmentUploadSession,
  AttachmentUploadSessionError,
  type AttachmentUploadSessionCreated,
} from "#src/server/attachments/attachment-upload-session.server";
import { getFileStorage } from "#src/server/files/file-storage.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { targetResolutionStatus } from "#src/server/agents/agent-target-status.server";

const UUID_PATTERN = UUID_LIKE_PATTERN;

export type AttachmentUploadSessionCreatePrincipal = { workspaceId: string; agentId: string };

export type AttachmentUploadSessionCreateDependencies = {
  resolveTarget(
    workspaceId: string,
    agentId: string,
    target: string,
  ): Promise<{ conversationId: string }>;
  create(input: {
    agentId: string;
    workspaceId: string;
    conversationId: string;
    fileName: string;
    contentType: string;
    sizeBytes: number;
    clientRequestId: string;
  }): Promise<AttachmentUploadSessionCreated>;
};

export async function handleAttachmentUploadSessionCreate(
  request: Request,
  principal: AttachmentUploadSessionCreatePrincipal,
  dependencies: AttachmentUploadSessionCreateDependencies,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("UPLOAD_INVALID_REQUEST", "request body must be JSON", 400, false);
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    return errorResponse(
      "UPLOAD_INVALID_REQUEST",
      "request body must be a JSON object",
      400,
      false,
    );
  const { target, fileName, contentType, sizeBytes, clientRequestId } = body as Record<
    string,
    unknown
  >;
  if (typeof target !== "string" || target.length === 0)
    return errorResponse("UPLOAD_INVALID_REQUEST", "target is required", 400, false);
  if (typeof fileName !== "string" || fileName.length === 0 || fileName.length > 255)
    return errorResponse("UPLOAD_INVALID_REQUEST", "fileName is required", 400, false);
  if (typeof contentType !== "string" || !MIME_TYPE_PATTERN.test(contentType))
    return errorResponse(
      "UPLOAD_INVALID_REQUEST",
      "contentType must look like type/subtype",
      400,
      false,
    );
  if (typeof sizeBytes !== "number" || !Number.isInteger(sizeBytes) || sizeBytes <= 0)
    return errorResponse(
      "UPLOAD_INVALID_REQUEST",
      "sizeBytes must be a positive integer",
      400,
      false,
    );
  if (typeof clientRequestId !== "string" || !UUID_PATTERN.test(clientRequestId))
    return errorResponse("UPLOAD_INVALID_REQUEST", "clientRequestId must be a UUID", 400, false);

  // The attachment belongs to the conversation, not a message; strip any `:root` thread suffix
  // rather than resolving it, exactly as the multipart upload route already does.
  const parentTarget = target.split(":")[0]!;
  let conversationId: string;
  try {
    const resolved = await dependencies.resolveTarget(
      principal.workspaceId,
      principal.agentId,
      parentTarget,
    );
    conversationId = resolved.conversationId;
  } catch (error) {
    return errorResponse(
      "UPLOAD_FORBIDDEN",
      "target is not accessible",
      targetResolutionStatus(error),
      false,
    );
  }

  try {
    const session = await dependencies.create({
      agentId: principal.agentId,
      workspaceId: principal.workspaceId,
      conversationId,
      fileName,
      contentType,
      sizeBytes,
      clientRequestId,
    });
    return Response.json(session, { status: 201 });
  } catch (error) {
    if (error instanceof AttachmentUploadSessionError)
      return errorResponse(error.code, error.message, error.status, error.retryable);
    throw error;
  }
}

export const Route = createFileRoute("/api/agent/v1/attachment-upload-sessions/")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      POST: async ({ request, context: { principal, db } }) => {
        const repository = new PrismaDirectConversationRepository(db);
        const storage = await getFileStorage();
        return handleAttachmentUploadSessionCreate(request, principal, {
          resolveTarget: (workspaceId, agentId, target) =>
            repository.resolveAgentTarget(workspaceId, agentId, target),
          create: (input) => createAttachmentUploadSession(db, storage, input),
        });
      },
    },
  },
});
