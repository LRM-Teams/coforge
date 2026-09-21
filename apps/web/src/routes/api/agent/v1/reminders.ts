import { createFileRoute } from "@tanstack/react-router";
import {
  type AgentReminderOperationRequest,
  validateAgentReminderOperationRequest,
} from "@lrm/coforge-sdk/internal";
import { agentAuthMiddleware } from "#/server/agents/agent-http.middleware";
import { createAgentReminderService } from "#/server/agents/agent-api-http.server";

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
  principal: { workspaceId: string; agentId: string; computerId: string; userId: string },
  service: (command: AgentReminderOperationRequest, userId: string) => Promise<unknown>,
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
  } catch {
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
