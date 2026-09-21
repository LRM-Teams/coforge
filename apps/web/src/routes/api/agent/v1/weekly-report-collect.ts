import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { agentAuthMiddleware } from "#/server/agents/agent-http.middleware";
import { reportCollectSlotOutcome } from "#/server/records/weekly-report-collect-orchestrate.server";

const bodySchema = z.object({
  idempotencyKey: z.string().uuid(),
  runId: z.string().uuid(),
  outcome: z.enum(["ready", "empty", "failed"]),
  packMarkdown: z.string().max(500_000).optional(),
  failureReason: z.string().max(2000).optional(),
});

/** Daemon rejects the proxy response unless `idempotencyKey` echoes the request. */
export function weeklyReportCollectHttpResponse(input: {
  idempotencyKey: string;
  runId: string;
  status: string;
  allTerminal: boolean;
  canSynthesize: boolean;
  newlyAccepted: boolean;
  synthesisStarted: boolean;
}) {
  return {
    idempotencyKey: input.idempotencyKey,
    requestId: input.idempotencyKey,
    runId: input.runId,
    status: input.status,
    allTerminal: input.allTerminal,
    canSynthesize: input.canSynthesize,
    newlyAccepted: input.newlyAccepted,
    synthesisStarted: input.synthesisStarted,
  };
}

export const Route = createFileRoute("/api/agent/v1/weekly-report-collect")({
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
          const accepted = await reportCollectSlotOutcome(db, {
            workspaceId: principal.workspaceId,
            agentId: principal.agentId,
            computerId: principal.computerId,
            requestId: body.idempotencyKey,
            runId: body.runId,
            outcome: body.outcome,
            packMarkdown: body.packMarkdown,
            failureReason: body.failureReason,
          });
          const view = accepted.run;

          return Response.json(
            weeklyReportCollectHttpResponse({
              idempotencyKey: body.idempotencyKey,
              runId: view.id,
              status: view.status,
              allTerminal: view.allTerminal,
              canSynthesize: view.canSynthesize,
              newlyAccepted: accepted.newlyAccepted,
              synthesisStarted: accepted.synthesisStarted,
            }),
          );
        } catch (error) {
          if (error && typeof error === "object" && "code" in error) {
            const code = String((error as { code: string }).code);
            if (code === "NOT_FOUND") return Response.json({ error: "not found" }, { status: 404 });
            if (code === "ACCESS_DENIED")
              return Response.json({ error: "forbidden" }, { status: 403 });
            if (code === "INVALID_INPUT")
              return Response.json({ error: "invalid input" }, { status: 400 });
          }
          return Response.json({ error: "invalid collect request" }, { status: 400 });
        }
      },
    },
  },
});
