import { createFileRoute } from "@tanstack/react-router";
import { agentAuthMiddleware } from "@/server/agents/agent-http-middleware.server";
import {
  cancelAttachmentUploadSession,
  getAttachmentUploadSession,
  AttachmentUploadSessionError,
} from "@/server/attachments/attachment-upload-session.server";
import { getFileStorage } from "@/server/files/file-storage.server";

function errorResponse(code: string, message: string, status: number, retryable: boolean) {
  return Response.json({ error: message, code, retryable }, { status });
}

export const Route = createFileRoute("/api/agent/v1/attachment-upload-sessions/$uploadId")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      GET: async ({ context: { principal, db }, params }) => {
        try {
          const session = await getAttachmentUploadSession(db, {
            agentId: principal.agentId,
            workspaceId: principal.workspaceId,
            uploadId: params.uploadId,
          });
          return Response.json(session);
        } catch (error) {
          if (error instanceof AttachmentUploadSessionError)
            return errorResponse(error.code, error.message, error.status, error.retryable);
          throw error;
        }
      },
      DELETE: async ({ context: { principal, db }, params }) => {
        try {
          const storage = await getFileStorage();
          const session = await cancelAttachmentUploadSession(db, storage, {
            agentId: principal.agentId,
            workspaceId: principal.workspaceId,
            uploadId: params.uploadId,
          });
          return Response.json(session);
        } catch (error) {
          if (error instanceof AttachmentUploadSessionError)
            return errorResponse(error.code, error.message, error.status, error.retryable);
          throw error;
        }
      },
    },
  },
});
