import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { agentAuthMiddleware } from "#/server/agents/agent-http.middleware";
import { applyKeyPointExtractionWriteBack } from "#/server/records/weekly-report-key-points.server";

const bodySchema = z.object({
  requestId: z.string().uuid(),
  reportId: z.string().uuid(),
  markdown: z.string().min(1).max(500_000),
});

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
            requestId: body.requestId,
          });
          return Response.json({
            requestId: body.requestId,
            reportId: result.reportId,
            status: result.status,
          });
        } catch (error) {
          if (error && typeof error === "object" && "code" in error) {
            const code = String((error as { code: string }).code);
            if (code === "NOT_FOUND") return Response.json({ error: "not found" }, { status: 404 });
            if (code === "ACCESS_DENIED")
              return Response.json({ error: "forbidden" }, { status: 403 });
            if (code === "INVALID_INPUT")
              return Response.json({ error: "invalid input" }, { status: 400 });
          }
          return Response.json({ error: "invalid key-points request" }, { status: 400 });
        }
      },
    },
  },
});
