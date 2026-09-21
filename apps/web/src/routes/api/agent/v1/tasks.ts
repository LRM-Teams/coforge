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

const taskRequestSchema = z
  .object({
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
        expiry: z.iso.datetime(),
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
    const command = taskRequestSchema.parse(await request.json().catch(() => undefined));
    // Agent Task commands act as the agent, not its owner user.
    const result = await board.execute(
      { workspaceId: principal.workspaceId, agentId: principal.agentId },
      command,
    );
    return Response.json({ ...result, idempotencyKey: command.idempotencyKey });
  } catch (error) {
    if (error instanceof AppError || error instanceof z.ZodError) {
      const code = error instanceof AppError ? error.code : "INVALID_INPUT";
      return Response.json({ error: "invalid task request", code }, { status: 400 });
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
