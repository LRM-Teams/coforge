import { createFileRoute } from "@tanstack/react-router";
import { validateWeeklyReportRequest, type WeeklyReportRequest } from "@lrm/coforge-sdk/internal";
import { agentAuthMiddleware } from "#/server/agents/agent-http-middleware.server";
import {
  PrismaAgentRepository,
  RepositoryAgentAuthorization,
} from "#/server/db/repositories/agent.repositories.server";
import { recordCatalog } from "#/server/records/record-catalog.server";
import { weeklyReportAssistantOwner } from "#/server/records/weekly-report-assistant.server";
import {
  executeAgentWeeklyReport,
  weeklyReportWireRequest,
  type WeeklyReportWireRequest,
} from "#/server/agents/agent-weekly-report-http.server";

export const Route = createFileRoute("/api/agent/v1/weekly-reports")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      POST: async ({ request, context: { principal, db } }) => {
        try {
          const body = (await request.json()) as WeeklyReportWireRequest;
          // The validator speaks the shared shape, whose key is `requestId`.
          const command = validateWeeklyReportRequest({
            ...body,
            requestId: body.idempotencyKey,
          } as WeeklyReportRequest);
          const authorization = new RepositoryAgentAuthorization(new PrismaAgentRepository(db));
          const result = await executeAgentWeeklyReport(
            recordCatalog(db),
            {
              computerIdForAuthorizedAgent: (workspaceId, agentId, userId) =>
                authorization.computerIdForAuthorizedAgent(workspaceId, agentId, userId),
              weeklyReportAssistantOwner: (workspaceId, agentId) =>
                weeklyReportAssistantOwner(db, { workspaceId, agentId }),
            },
            weeklyReportWireRequest(command),
            principal,
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
