import { createFileRoute } from "@tanstack/react-router";
import {
  type AgentReminderOperationRequest,
  validateAgentReminderOperationRequest,
} from "@lrm/coforge-sdk/internal";
import { isAppError } from "#/lib/app-error";
import { agentAuthMiddleware } from "#/server/agents/agent-http.middleware";
import { createAgentReminderService } from "#/server/agents/agent-api-http.server";

export type AgentReminderPrincipal = {
  workspaceId: string;
  agentId: string;
  computerId: string;
  userId: string;
};

type AgentReminderService = (
  command: AgentReminderOperationRequest,
  userId: string,
) => Promise<unknown>;

function isReminderAuthorizationFailure(error: unknown): boolean {
  if (isAppError(error)) return error.code === "ACCESS_DENIED";
  return (
    error instanceof Error &&
    [
      "reminder operation is not authorized",
      "reminder target is not authorized",
      "reminder snapshot is not authorized",
      "reminder fire is not authorized",
    ].includes(error.message)
  );
}

/**
 * The Agent API names the request's idempotency key `idempotencyKey`; the reminder command — whose
 * shape is shared with the protobuf codec, and whose rules refuse a request without one — names it
 * `requestId`. The two meet here, in one place, the way the Task route does it.
 *
 * Exported and taking its service as an argument so this boundary is testable on its own: a
 * mismatch here turns every reminder command into `400 invalid reminder request`.
 */
export async function handleAgentReminderPost(
  request: Request,
  principal: AgentReminderPrincipal,
  service: AgentReminderService,
): Promise<Response> {
  try {
    const body = (await request.json()) as AgentReminderOperationRequest & {
      idempotencyKey?: string;
    };
    const { idempotencyKey, ...fields } = body;
    // JSON in, JSON out: the request is validated against the same rules the codec applies, but
    // this route never becomes protobuf. Protobuf is the WebSocket path's contract, not HTTP's.
    const command = validateAgentReminderOperationRequest({
      ...fields,
      requestId: idempotencyKey,
    });
    if (
      command.agentId !== principal.agentId ||
      command.workspaceId !== principal.workspaceId ||
      command.computerId !== principal.computerId
    )
      return Response.json({ error: "reminder scope denied" }, { status: 403 });
    const result = await service(command, principal.userId);
    // The caller's own name for the key is what it matches the answer against.
    return Response.json({ ...(result as Record<string, unknown>), idempotencyKey });
  } catch (error) {
    // Authorization failures are a valid, well-formed request. Returning 400 here made the
    // daemon report the same status as malformed JSON and hid the ACCESS_DENIED cause.
    if (isReminderAuthorizationFailure(error))
      return Response.json(
        { error: "reminder access denied", code: "ACCESS_DENIED" },
        { status: 403 },
      );
    return Response.json({ error: "invalid reminder request" }, { status: 400 });
  }
}

export const Route = createFileRoute("/api/agent/v1/reminders")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      POST: ({ request, context: { principal, db } }) =>
        handleAgentReminderPost(request, principal, (command, userId) =>
          createAgentReminderService(db).execute(command, userId),
        ),
    },
  },
});
