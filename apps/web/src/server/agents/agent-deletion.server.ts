import type { AgentStopIntent } from "@lrm/coforge-sdk/internal";
import { AppError } from "#src/lib/app-error";
import {
  assertCanDeleteAgents,
  type WorkspaceMemberRole,
} from "#src/server/workspaces/member-role.server";
import type {
  AgentRecord,
  AgentRepository,
} from "#src/server/db/repositories/agent.repositories.server";
import type { AgentRuntimeLock } from "./agent-runtime-lock.server";
import { agentStopIntent } from "./manage-agents.server";
import {
  announceMemberChanged,
  type ConversationRealtime,
} from "#src/server/conversations/conversation-realtime.server";

/** What one delete changed. */
export type AgentDeletionEffects = {
  membershipsLeft: number;
  /** The channels the Agent was an active member of, whose member lists now changed. */
  leftChannelIds: string[];
  remindersCanceled: number;
  apiKeysRevoked?: number;
};

/**
 * The atomic live → deleted transition, or why it did not happen. `protected` covers an Agent
 * that must keep existing for a product feature (the per-User weekly-report assistant), which is
 * not a delete target at all.
 */
export type AgentDeletionOutcome =
  | ({ outcome: "deleted" } & AgentDeletionEffects)
  | { outcome: "already-deleted" }
  | { outcome: "protected" };

/**
 * One atomic transition from live to deleted: mark the Agent and make it inert cloud-side
 * (revoke Agent API keys, soft-leave channel memberships, cancel scheduled Reminders). Message,
 * Task and Action-card rows are never touched — their `Restrict` foreign keys make them
 * undeletable, and history must stay readable.
 */
export interface AgentDeletionStore {
  delete(input: {
    agentId: string;
    workspaceId: string;
    deletedAt: Date;
  }): Promise<AgentDeletionOutcome>;
}

type AgentRuntimeControl = {
  stop(intent: AgentStopIntent, userId: string): Promise<void>;
};

/**
 * Deletes one Agent. Authorization is Raft's `deleteAgents` capability — Workspace
 * owner/admin only, never by Agent ownership alone. Runs under the Agent runtime lock so a
 * concurrent config/credential change cannot interleave with the delete.
 *
 * The Agent is persisted as deleted *before* the runtime stop is attempted: the delete is the
 * user's intent and must not be blocked by an offline Computer, and the Agent is already inert
 * cloud-side (hidden, key revoked, memberships left) even if the Daemon never answers. A stop
 * that cannot be delivered is reconciled later by `WorkspaceAgentRecovery`, which stops — never
 * starts — a deleted Agent the Daemon still reports as running.
 */
export class AgentDeletion {
  constructor(
    private readonly agents: AgentRepository,
    private readonly store: AgentDeletionStore,
    private readonly runtimeControl: AgentRuntimeControl,
    private readonly runtimeLock: AgentRuntimeLock,
    private readonly now: () => Date = () => new Date(),
    private readonly realtime?: Pick<ConversationRealtime, "memberChanged">,
  ) {}

  async delete(
    principal: { userId: string; workspaceId: string; role: WorkspaceMemberRole },
    agentId: string,
  ): Promise<AgentDeletionOutcome> {
    assertCanDeleteAgents(principal.role);
    return this.runtimeLock.run(agentId, async () => {
      const agent = await this.agents.getById(agentId);
      if (!agent || agent.workspaceId !== principal.workspaceId) throw new AppError("NOT_FOUND");
      const result = await this.store.delete({
        agentId: agent.id,
        workspaceId: agent.workspaceId,
        deletedAt: this.now(),
      });
      // A repeated delete is an idempotent no-op; never send a second stop for it.
      if (result.outcome !== "deleted") return result;
      await announceMemberChanged(this.realtime, {
        workspaceId: agent.workspaceId,
        conversationIds: result.leftChannelIds,
      });
      await this.#stopRuntime(agent, principal.userId);
      return result;
    });
  }

  /**
   * Best effort: the Agent is already deleted, so a Computer that is offline or slow must not
   * fail the operation the user asked for. `deletedAt` is what keeps the Agent from ever being
   * started again, and recovery stops any process this call could not reach.
   */
  async #stopRuntime(agent: AgentRecord, userId: string) {
    if (!agent.computerId) return;
    try {
      await this.runtimeControl.stop(agentStopIntent(agent), userId);
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "agent_deletion:stop_failed",
          agent_id: agent.id,
          workspace_id: agent.workspaceId,
          computer_id: agent.computerId,
          error_type: error instanceof Error ? error.name : typeof error,
        }),
      );
    }
  }
}
