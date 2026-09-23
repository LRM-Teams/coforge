import { createFileRoute } from "@tanstack/react-router";
import { agentAuthMiddleware } from "@/server/agents/agent-http-middleware.server";
import { storeAgentAttachment } from "@/server/attachments/attachment.server";
import { PrismaDirectConversationRepository } from "@/server/db/repositories/direct-conversation.repositories.server";
import { isAppError } from "@/lib/app-error";

/** RFC 6838 `type/subtype`, case-insensitively; matches the parameter-free form the Agent sends. */
const MIME_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;

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

function isUploadFile(value: unknown): value is File {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "name") === "string" &&
    typeof Reflect.get(value, "size") === "number" &&
    typeof Reflect.get(value, "arrayBuffer") === "function"
  );
}

/**
 * Maps a target-resolution failure to the Agent API's status contract. `resolveAgentTarget`
 * (and the private helpers it calls) throws `AppError("INVALID_INPUT")` for a malformed
 * `#channel`, `AppError("ACCESS_DENIED")` for a channel the Agent is not a member of, and a
 * plain `Error` (`"invalid message target"`, `"target user not found"`,
 * `"conversation scope is not authorized"`) for the `@user` grammar and DM authorization.
 */
function targetResolutionStatus(error: unknown): number {
  if (isAppError(error)) return error.code === "ACCESS_DENIED" ? 403 : 400;
  if (error instanceof Error && error.message === "invalid message target") return 400;
  // "target user not found" / "conversation scope is not authorized": an unknown target or one
  // the Agent cannot reach reads the same to the caller as "not a member".
  return 403;
}

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
  if (!isUploadFile(file)) return Response.json({ error: "file is required" }, { status: 400 });
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
