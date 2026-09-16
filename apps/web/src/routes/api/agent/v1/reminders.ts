import { createFileRoute } from "@tanstack/react-router";
import {
  decodeAgentReminderOperationRequest,
  encodeAgentReminderOperationRequest,
  type AgentReminderOperationRequest,
} from "@lrm/coforge-sdk/internal";
import { agentAuthMiddleware } from "#/server/agents/agent-http.middleware";
import { createAgentReminderService } from "#/server/agents/agent-api-http.server";

export const Route = createFileRoute("/api/agent/v1/reminders")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      POST: async ({ request, context: { principal, db } }) => {
        try {
          const input = (await request.json()) as AgentReminderOperationRequest;
          const command = decodeAgentReminderOperationRequest(
            encodeAgentReminderOperationRequest(input),
          );
          if (
            command.agentId !== principal.agentId ||
            command.workspaceId !== principal.workspaceId ||
            command.computerId !== principal.computerId
          )
            return Response.json({ error: "reminder scope denied" }, { status: 403 });
          const result = await createAgentReminderService(db).execute(command, principal.userId);
          return Response.json(result);
        } catch {
          return Response.json({ error: "invalid reminder request" }, { status: 400 });
        }
      },
    },
  },
});
