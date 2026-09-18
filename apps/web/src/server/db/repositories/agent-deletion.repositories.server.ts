import type { PrismaClient } from "../../../../generated/client";
import { ACTIVE_AGENT_WHERE } from "../../agents/active-agent.server";
import type { AgentDeletionOutcome, AgentDeletionStore } from "../../agents/agent-deletion.server";

/**
 * One transaction makes a deleted Agent inert cloud-side (ADR 0044): the Agent is marked
 * `deletedAt`, its Agent API keys are revoked, its public-channel memberships are soft-left
 * (which is what stops delivery and wake, since both read `ACTIVE_MEMBER_WHERE`), and its
 * scheduled Reminders are canceled. Messages, Tasks and Action cards are deliberately left
 * untouched — the `Restrict` foreign keys make them undeletable, and history must stay readable.
 *
 * Every statement is conditional on the Agent still being live, so a repeated delete is an
 * idempotent no-op rather than a second round of side effects. The per-User weekly-report
 * assistant is refused outright: Records provisions it on demand by `(workspaceId, userId)`, so
 * deleting it would only have it recreated and would break the feature meanwhile.
 */
export class PrismaAgentDeletionStore implements AgentDeletionStore {
  constructor(private readonly db: PrismaClient) {}

  async delete(input: {
    agentId: string;
    workspaceId: string;
    deletedAt: Date;
  }): Promise<AgentDeletionOutcome> {
    return this.db.$transaction(async (tx) => {
      const assistant = await tx.weeklyReportAssistant.findFirst({
        where: { agentId: input.agentId, workspaceId: input.workspaceId },
        select: { id: true },
      });
      if (assistant) return { outcome: "protected" as const };
      const deleted = await tx.agent.updateMany({
        where: { id: input.agentId, workspaceId: input.workspaceId, ...ACTIVE_AGENT_WHERE },
        data: { deletedAt: input.deletedAt },
      });
      // Already deleted: leave the original `deletedAt` and the first delete's effects alone.
      if (deleted.count === 0) return { outcome: "already-deleted" as const };

      const membershipsLeft = await tx.conversationMember.updateMany({
        where: { workspaceId: input.workspaceId, agentId: input.agentId, leftAt: null },
        data: { leftAt: input.deletedAt },
      });
      const remindersCanceled = await tx.reminder.updateMany({
        where: {
          workspaceId: input.workspaceId,
          ownerAgentId: input.agentId,
          status: "scheduled",
        },
        data: { status: "canceled" },
      });
      const apiKeysRevoked = await tx.agentApiKey.updateMany({
        where: { agentId: input.agentId, workspaceId: input.workspaceId, revokedAt: null },
        data: { revokedAt: input.deletedAt },
      });
      return {
        outcome: "deleted" as const,
        membershipsLeft: membershipsLeft.count,
        remindersCanceled: remindersCanceled.count,
        apiKeysRevoked: apiKeysRevoked.count,
      };
    });
  }
}
