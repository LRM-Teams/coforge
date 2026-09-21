import { createFileRoute } from "@tanstack/react-router";
import type { AgentTaskRequest } from "@lrm/coforge-sdk/agent";
import type { TaskCommand, TaskPrincipal, TaskResult } from "@lrm/coforge-sdk/internal";
import { agentAuthMiddleware } from "#/server/agents/agent-http.middleware";
import { TaskBoard } from "#/server/tasks/task-board.server";

/**
 * The Agent API's body names the request's idempotency key `idempotencyKey`; the Task board's own
 * command shape — shared with the protobuf codec — names it `requestId`, and refuses a command
 * without one (`invalid Task request`). The two names meet here.
 *
 * Exported and taking its board as an argument so this boundary is testable on its own: the route
 * below is a thin wrapper, and a mismatch here silently turns every Task command into a 400.
 */
export async function handleAgentTaskPost(
  request: Request,
  principal: TaskPrincipal,
  board: { execute(principal: TaskPrincipal, command: TaskCommand): Promise<TaskResult> },
): Promise<Response> {
  try {
    const body = (await request.json()) as AgentTaskRequest;
    const { idempotencyKey, ...command } = body;
    const result = await board.execute(principal, { ...command, requestId: idempotencyKey });
    return Response.json({ idempotencyKey, ...result });
  } catch {
    return Response.json({ error: "invalid task request" }, { status: 400 });
  }
}

export const Route = createFileRoute("/api/agent/v1/tasks")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      POST: ({ request, context: { principal, db } }) =>
        handleAgentTaskPost(request, principal, new TaskBoard(db)),
    },
  },
});
