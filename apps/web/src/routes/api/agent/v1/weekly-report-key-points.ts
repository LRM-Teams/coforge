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

export type WeeklyReportKeyPointsPrincipal = { workspaceId: string; agentId?: string };

/** The records-domain write-back the route dispatches to, without the database handle. */
export type WeeklyReportKeyPointsService = (
  input: Parameters<typeof applyKeyPointExtractionWriteBack>[1],
) => ReturnType<typeof applyKeyPointExtractionWriteBack>;

/** Exported and taking its service as an argument so the route's own contract — above all that the
 * response echoes the request's `idempotencyKey`, which the daemon rejects it without — is testable
 * without a database. */
export async function handleWeeklyReportKeyPointsPost(
  request: Request,
  principal: WeeklyReportKeyPointsPrincipal,
  service: WeeklyReportKeyPointsService,
): Promise<Response> {
  try {
    if (!principal.agentId) {
      return Response.json({ error: "agent required" }, { status: 403 });
    }
    const json = await request.json();
    const body = bodySchema.parse(json);
    const result = await service({
      workspaceId: principal.workspaceId,
      agentId: principal.agentId,
      reportId: body.reportId,
      markdown: body.markdown,
      requestId: body.idempotencyKey,
    });
    // The daemon rejects the proxy response unless `idempotencyKey` echoes the request.
    return Response.json({
      idempotencyKey: body.idempotencyKey,
      reportId: result.reportId,
      status: result.status,
    });
  } catch (error) {
    return agentRouteDomainErrorResponse(error, "invalid key-points request");
  }
}

export const Route = createFileRoute("/api/agent/v1/weekly-report-key-points")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      POST: ({ request, context: { principal, db } }) =>
        handleWeeklyReportKeyPointsPost(request, principal, (input) =>
          applyKeyPointExtractionWriteBack(db, input),
        ),
    },
  },
});
