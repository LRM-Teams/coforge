import type { TaskResult } from "@lrm/coforge-sdk/internal";

import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import type { TaskBoard } from "./task-board.server";

/**
 * A Task for an Agent, created from the Tasks page without a channel: it goes to the person's
 * direct conversation with the Agent (started if they have none yet, under the usual rule that
 * only a public Agent or their own private one may be messaged) and is assigned to the Agent, so
 * the Agent receives it like any assignment. TaskBoard still owns every Task rule.
 */
export async function createAgentDirectTask(
  db: PrismaClient,
  board: Pick<TaskBoard, "execute">,
  input: {
    workspaceId: string;
    userId: string;
    agentId: string;
    title: string;
    description?: string | null;
    idempotencyKey: string;
  },
): Promise<TaskResult> {
  const agent = await db.agent.findFirst({
    where: { id: input.agentId, workspaceId: input.workspaceId, deletedAt: null },
    select: { name: true },
  });
  if (!agent) throw new AppError("NOT_FOUND");
  const conversation = await new PrismaDirectConversationRepository(db).getOrCreateUserAgent(
    input.workspaceId,
    input.userId,
    input.agentId,
  );
  return board.execute(
    { workspaceId: input.workspaceId, userId: input.userId },
    {
      operation: "create",
      idempotencyKey: input.idempotencyKey,
      conversationId: conversation.id,
      title: input.title,
      ...(input.description ? { description: input.description } : {}),
      assignee: `@${agent.name}`,
    },
  );
}
