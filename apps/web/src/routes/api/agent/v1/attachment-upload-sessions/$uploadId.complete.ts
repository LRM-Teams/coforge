import { createFileRoute } from "@tanstack/react-router";
import { errorResponse } from "#src/server/agents/agent-http-error.server";
import { agentAuthMiddleware } from "#src/server/agents/agent-http-middleware.server";
import {
  completeAttachmentUploadSession,
  AttachmentUploadSessionError,
} from "#src/server/attachments/attachment-upload-session.server";
import { getFileStorage } from "#src/server/files/file-storage.server";

export const Route = createFileRoute("/api/agent/v1/attachment-upload-sessions/$uploadId/complete")(
  {
    server: {
      middleware: [agentAuthMiddleware],
      handlers: {
        POST: async ({ context: { principal, db }, params }) => {
          try {
            const storage = await getFileStorage();
            const result = await completeAttachmentUploadSession(db, storage, {
              agentId: principal.agentId,
              workspaceId: principal.workspaceId,
              uploadId: params.uploadId,
            });
            return Response.json(result);
          } catch (error) {
            if (error instanceof AttachmentUploadSessionError)
              return errorResponse(error.code, error.message, error.status, error.retryable);
            throw error;
          }
        },
      },
    },
  },
);
