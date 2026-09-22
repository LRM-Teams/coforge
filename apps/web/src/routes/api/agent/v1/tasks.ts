import { createFileRoute } from "@tanstack/react-router";
import type { AgentTaskRequest } from "@lrm/coforge-sdk/agent";
import { TASK_STATUSES, type TaskPrincipal, type TaskResult } from "@lrm/coforge-sdk/internal";
import { z } from "zod";
import { AppError } from "#/lib/app-error";
import { agentAuthMiddleware } from "#/server/agents/agent-http.middleware";
import { TaskBoard } from "#/server/tasks/task-board.server";

const taskOperations = [
  "list",
  "create",
  "convert",
  "claim",
  "unclaim",
  "update",
  "assign",
  "unassign",
  "amend",
  "history",
  "delete",
  "receipt",
] as const;
const taskStatuses = [...TASK_STATUSES, "all"] as const;

/** The HTTP status a board refusal's code means. Codes outside this map (workspace/computer
 * invariants the board does not raise) fall through to 500. */
const TASK_REFUSAL_STATUS: Record<string, number> = {
  INVALID_INPUT: 400,
  NOT_FOUND: 404,
  ACCESS_DENIED: 403,
  CONFLICT: 409,
  TEMPORARILY_UNAVAILABLE: 503,
};

const taskRequestSchema = z
  .object({
    // Legacy Task envelope, accepted and ignored. Clients installed before the envelope was purged
    // (#643) still send these, and `.strict()` turned that into a ZodError -> 400 for **every**
    // Agent Task request from every installed Computer (claim, history, …), which the proxy reports
    // as an opaque 502. The route has always taken its principal from the Agent API key, never from
    // these body fields, so the compatible reading is to keep ignoring them until the matching
    // client ships. Drop these three keys once no supported Computer sends them.
    protocolMajor: z.number().optional(),
    workspaceId: z.string().optional(),
    agentId: z.string().optional(),
    operation: z.enum(taskOperations),
    idempotencyKey: z.string().min(1),
    conversationId: z.string().uuid().optional(),
    target: z.string().min(1).optional(),
    number: z.number().int().positive().optional(),
    numbers: z.array(z.number().int().positive()).min(1).optional(),
    messageId: z.string().min(1).optional(),
    messageIds: z.array(z.string().min(1)).min(1).optional(),
    title: z.string().min(1).max(10_000).optional(),
    titles: z.array(z.string().min(1).max(10_000)).min(1).optional(),
    description: z.string().max(50_000).nullable().optional(),
    assignee: z.string().nullable().optional(),
    mine: z.boolean().optional(),
    createsResource: z.boolean().optional(),
    receipt: z
      .object({
        object: z.string().min(1),
        purpose: z.string().min(1),
        teardownOwner: z.string().min(1),
        securityPrivacy: z.string().min(1),
        expiry: z.iso.datetime({ offset: true }),
        runbook: z.string().min(1),
        tracking: z.string().min(1),
      })
      .optional(),
    freshnessContextMode: z.enum(["inline", "withheld"]).optional(),
    attachmentId: z.string().uuid().optional(),
    status: z.enum(taskStatuses).optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
  })
  .strict();

/** The raw HTTP adapter validates JSON shape; the board owns command invariants and authorization. */
export async function handleAgentTaskPost(
  request: Request,
  principal: TaskPrincipal,
  board: {
    execute(principal: TaskPrincipal, command: AgentTaskRequest): Promise<TaskResult>;
  },
): Promise<Response> {
  try {
    const parsed = taskRequestSchema.parse(await request.json().catch(() => undefined));
    // Drop the ignored legacy envelope before the board sees it, so a command is still exactly a
    // `TaskCommand` (the fields were never part of the command).
    const {
      protocolMajor: _protocolMajor,
      workspaceId: _workspaceId,
      agentId: _agentId,
      ...command
    } = parsed;
    // Agent Task commands act as the agent, not its owner user.
    const result = await board.execute(
      { workspaceId: principal.workspaceId, agentId: principal.agentId },
      command,
    );
    return Response.json({ ...result, idempotencyKey: command.idempotencyKey });
  } catch (error) {
    if (error instanceof AppError) {
      // A board refusal is a business outcome, not a malformed request: name its code and give it
      // the HTTP status that code means, so a claim of an already-claimed task is a 409 and not a
      // shapeless 400 the caller can only report as an opaque failure.
      const status = TASK_REFUSAL_STATUS[error.code] ?? 500;
      return Response.json({ error: "task request refused", code: error.code }, { status });
    }
    if (error instanceof z.ZodError) {
      return Response.json(
        { error: "invalid task request", code: "INVALID_INPUT" },
        { status: 400 },
      );
    }
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
