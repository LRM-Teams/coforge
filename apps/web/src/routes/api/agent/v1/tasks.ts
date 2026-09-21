import { createFileRoute } from "@tanstack/react-router";
import type { AgentTaskRequest } from "@lrm/coforge-sdk/agent";
import type { TaskPrincipal, TaskResult } from "@lrm/coforge-sdk/internal";
import { AppError } from "#/lib/app-error";
import { agentAuthMiddleware } from "#/server/agents/agent-http.middleware";
import { TaskBoard } from "#/server/tasks/task-board.server";

/**
 * The Agent API's task body is the board's own command — the request's idempotency key is named
 * `idempotencyKey` on both sides, so the route passes the body through and echoes the key back.
 * No protobuf here: HTTP speaks JSON; the WebSocket path's protobuf contract is a different
 * surface. The board is the validator, and its `AppError` codes are the caller's diagnosis — a
 * malformed command says *which* way it was malformed; anything else is a fault of ours, is
 * logged, and is answered 500, answering 400 for it would blame the caller.
 */
export async function handleAgentTaskPost(
  request: Request,
  principal: TaskPrincipal,
  board: {
    execute(principal: TaskPrincipal, command: AgentTaskRequest): Promise<TaskResult>;
  },
): Promise<Response> {
  try {
    const command = (await request.json()) as AgentTaskRequest;
    // The HTTP auth principal carries BOTH the agent and its owner (`userId`), but the board's
    // scope() requires EXACTLY ONE of the two and throws ACCESS_DENIED otherwise - passing the
    // principal through made every agent Task command over HTTP a 400, invisible behind the
    // route's opaque body. An Agent Task command acts as the agent, so scope it to the agent,
    // exactly like the WebSocket task method did.
    const result = await board.execute(
      { workspaceId: principal.workspaceId, agentId: principal.agentId },
      command,
    );
    return Response.json({ ...result, idempotencyKey: command.idempotencyKey });
  } catch (error) {
    if (error instanceof AppError)
      return Response.json({ error: "invalid task request", code: error.code }, { status: 400 });
    console.error("[agent] Task command failed", error);
    return Response.json({ error: "Task command failed" }, { status: 500 });
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
