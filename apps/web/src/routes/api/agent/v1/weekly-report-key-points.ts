import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { agentAuthMiddleware } from "#src/server/agents/agent-http-middleware.server";
import { agentRouteDomainErrorResponse } from "#src/server/agents/agent-http-routes.server";
import { applyKeyPointExtractionWriteBack } from "#src/server/records/weekly-report-key-points.server";

const bodySchema = z.object({
  idempotencyKey: z.string().uuid(),
  reportId: z.string().uuid(),
  markdown: z.string().min(1).max(500_000),
});

/** Daemon rejects the proxy response unless `idempotencyKey` echoes the request. */
export function weeklyReportKeyPointsHttpResponse(input: {
  idempotencyKey: string;
  reportId: string;
  status: string;
}) {
  return {
    idempotencyKey: input.idempotencyKey,
    requestId: input.idempotencyKey,
    reportId: input.reportId,
    status: input.status,
  };
}

export const Route = createFileRoute("/api/agent/v1/weekly-report-key-points")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      POST: async ({ request, context: { principal, db } }) => {
        try {
          if (!principal.agentId) {
            return Response.json({ error: "agent required" }, { status: 403 });
          }
          const json = await request.json();
          const body = bodySchema.parse(json);
          const result = await applyKeyPointExtractionWriteBack(db, {
            workspaceId: principal.workspaceId,
            agentId: principal.agentId,
            reportId: body.reportId,
            markdown: body.markdown,
            requestId: body.idempotencyKey,
          });
          return Response.json(
            weeklyReportKeyPointsHttpResponse({
              idempotencyKey: body.idempotencyKey,
              reportId: result.reportId,
              status: result.status,
            }),
          );
        } catch (error) {
          return agentRouteDomainErrorResponse(error, "invalid key-points request");
        }
      },
    },
  },
});
