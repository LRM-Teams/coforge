import { WeeklyReportWorkflow } from "#src/server/records/weekly-report-workflow.server";
import { createFileRoute } from "@tanstack/react-router";
import { validateWeeklyReportRequest } from "@lrm/coforge-sdk/internal";
import { agentAuthMiddleware } from "#src/server/agents/agent-http-middleware.server";
import {
  PrismaAgentRepository,
  RepositoryAgentAuthorization,
} from "#src/server/db/repositories/agent.repositories.server";
import { recordCatalog } from "#src/server/records/record-catalog.server";
import { weeklyReportAssistantOwner } from "#src/server/records/weekly-report-assistant.server";
import { executeAgentWeeklyReport } from "#src/server/agents/agent-weekly-report-http.server";

export const Route = createFileRoute("/api/agent/v1/weekly-reports")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      POST: async ({ request, context: { principal, db } }) => {
        try {
          const command = validateWeeklyReportRequest(await request.json());
          const authorization = new RepositoryAgentAuthorization(new PrismaAgentRepository(db));
          const result = await executeAgentWeeklyReport(
            recordCatalog(db),
            {
              computerIdForAuthorizedAgent: (workspaceId, agentId, userId) =>
                authorization.computerIdForAuthorizedAgent(workspaceId, agentId, userId),
              weeklyReportAssistantOwner: (workspaceId, agentId) =>
                weeklyReportAssistantOwner(db, { workspaceId, agentId }),
            },
            command,
            principal,
            new WeeklyReportWorkflow(db),
          );
          if ("error" in result)
            return Response.json({ error: result.error.message }, { status: result.error.code });
          return Response.json(result.response);
        } catch {
          return Response.json({ error: "invalid weekly-report request" }, { status: 400 });
        }
      },
    },
  },
});
