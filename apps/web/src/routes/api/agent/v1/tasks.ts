import { createFileRoute } from "@tanstack/react-router";
import type { AgentTaskRequest } from "@lrm/coforge-sdk/agent";
import { agentAuthMiddleware } from "#/server/agents/agent-http.middleware";
import { TaskBoard } from "#/server/tasks/task-board.server";

export const Route = createFileRoute("/api/agent/v1/tasks")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      POST: async ({ request, context: { principal, db } }) => {
        try {
          const command = (await request.json()) as AgentTaskRequest;
          const result = await new TaskBoard(db).execute(
            { workspaceId: principal.workspaceId, agentId: principal.agentId },
            command,
          );
          return Response.json({ idempotencyKey: command.requestId, ...result });
        } catch {
          return Response.json({ error: "invalid task request" }, { status: 400 });
        }
      },
    },
  },
});
