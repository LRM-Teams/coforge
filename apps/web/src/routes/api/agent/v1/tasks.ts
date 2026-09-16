import { createFileRoute } from "@tanstack/react-router";
import type { AgentTaskRequest } from "@lrm/coforge-sdk/agent";
import { agentAuthMiddleware } from "#/server/agents/agent-http.middleware";
import { getDatabaseClient } from "#/server/db/client.server";
import { TaskBoard } from "#/server/tasks/task-board.server";

export const Route = createFileRoute("/api/agent/v1/tasks")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      POST: async ({ request, context }) => {
        try {
          const principal = context.principal;
          const db = getDatabaseClient();
          if (!db || !principal.agentId)
            return Response.json({ error: "task access denied" }, { status: 403 });
          const command = (await request.json()) as AgentTaskRequest;
          const result = await new TaskBoard(db).execute(
            { workspaceId: principal.workspaceId, agentId: principal.agentId },
            command,
          );
          return Response.json({ requestId: command.requestId, ...result });
        } catch {
          return Response.json({ error: "invalid task request" }, { status: 400 });
        }
      },
    },
  },
});
