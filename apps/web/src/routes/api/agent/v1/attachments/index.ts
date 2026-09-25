import { createFileRoute } from "@tanstack/react-router";
import { MIME_TYPE_PATTERN } from "@lrm/coforge-sdk/internal";
import { agentAuthMiddleware } from "#src/server/agents/agent-http-middleware.server";
import { storeAgentAttachment } from "#src/server/attachments/attachment.server";
import { isFile } from "#src/server/attachments/upload-file.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { isAppError } from "#src/lib/app-error";
import { targetResolutionStatus } from "#src/server/agents/agent-target-status.server";

export type AgentAttachmentUploadPrincipal = { workspaceId: string; agentId: string };

export type AgentAttachmentUploadDependencies = {
  resolveTarget(
    workspaceId: string,
    agentId: string,
    target: string,
  ): Promise<{ conversationId: string }>;
  store(input: {
    agentId: string;
    conversationId: string;
    workspaceId: string;
    file: File;
    contentType: string;
  }): Promise<{ id: string; fileName: string; contentType: string; sizeBytes: number }>;
};

/** Multipart upload handling; extracted from the route so it can be tested with fakes. */
export async function handleAgentAttachmentUpload(
  request: Request,
  principal: AgentAttachmentUploadPrincipal,
  dependencies: AgentAttachmentUploadDependencies,
): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: "request body must be multipart/form-data" }, { status: 400 });
  }
  const file = form.get("file");
  const target = form.get("target");
  const mimeTypeField = form.get("mimeType");
  if (!isFile(file)) return Response.json({ error: "file is required" }, { status: 400 });
  if (typeof target !== "string" || target.length === 0)
    return Response.json({ error: "target is required" }, { status: 400 });
  if (mimeTypeField !== null && typeof mimeTypeField !== "string")
    return Response.json({ error: "mimeType must be a string" }, { status: 400 });
  if (mimeTypeField && !MIME_TYPE_PATTERN.test(mimeTypeField))
    return Response.json({ error: "mimeType is invalid" }, { status: 400 });

  // The attachment belongs to the conversation, not a message; strip any `:root` thread suffix
  // rather than resolving it, so uploading never depends on a thread anchor already existing.
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
    return Response.json(
      { error: "target is not accessible" },
      { status: targetResolutionStatus(error) },
    );
  }

  const contentType = mimeTypeField || file.type || "application/octet-stream";
  try {
    const stored = await dependencies.store({
      agentId: principal.agentId,
      conversationId,
      workspaceId: principal.workspaceId,
      file,
      contentType,
    });
    return Response.json(stored);
  } catch (error) {
    if (isAppError(error) && error.code === "INVALID_INPUT")
      return Response.json(
        {
          error:
            file.size === 0 ? "file must not be empty" : "file exceeds the maximum attachment size",
        },
        { status: file.size === 0 ? 400 : 413 },
      );
    throw error;
  }
}

export const Route = createFileRoute("/api/agent/v1/attachments/")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      POST: ({ request, context: { principal, db } }) => {
        const repository = new PrismaDirectConversationRepository(db);
        return handleAgentAttachmentUpload(request, principal, {
          resolveTarget: (workspaceId, agentId, target) =>
            repository.resolveAgentTarget(workspaceId, agentId, target),
          store: (input) => storeAgentAttachment(db, input),
        });
      },
    },
  },
});
