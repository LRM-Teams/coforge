import { AppError } from "../../lib/app-error";
import type { AgentVisibility } from "../../features/agents/agent-visibility";
import { assertAgentLive } from "./active-agent.server";
import type { AgentRepository } from "../db/repositories/agent.repositories.server";
import { isAdminLike, type WorkspaceMemberRole } from "../workspaces/member-role.server";

/**
 * The atomic visibility transition, or whether it was a no-op (ADR 0059). Implementations own the
 * public↔private side effects in one transaction: public→private soft-leaves every active channel
 * membership including `#general`; private→public re-joins `#general` only. Messages, Tasks and
 * Action cards are never touched — history stays exactly as it was.
 */
export interface ChangeAgentVisibilityStore {
  apply(input: {
    agentId: string;
    workspaceId: string;
    visibility: AgentVisibility;
  }): Promise<{ changed: boolean }>;
}

/**
 * Changes one Agent's visibility (ADR 0059 "Changing visibility, both directions"). Authorized
 * for the Agent's own creator or a human Workspace owner/admin only — never an Agent, and never a
 * plain member acting on someone else's Agent. `onVisibilityChanged` tells connected browsers
 * (`publishAgentVisibilityChanged`); it runs once, after the transaction commits, and only when the
 * visibility actually changed. It is best-effort: the change is already committed, and a browser
 * that misses it catches up on its next focus or reconnect refresh.
 */
export class ChangeAgentVisibility {
  constructor(
    private readonly agents: AgentRepository,
    private readonly store: ChangeAgentVisibilityStore,
    private readonly onVisibilityChanged: (workspaceId: string, agentId: string) => Promise<void>,
  ) {}

  async execute(
    principal: { userId: string; workspaceId: string; role: WorkspaceMemberRole },
    input: { agentId: string; visibility: AgentVisibility },
  ): Promise<{ visibility: AgentVisibility; changed: boolean }> {
    const agent = await this.agents.getById(input.agentId);
    if (!agent || agent.workspaceId !== principal.workspaceId) throw new AppError("NOT_FOUND");
    // A deleted Agent has no visibility left to change, the same "already inert" refusal every
    // other post-delete mutation gives (ADR 0044).
    assertAgentLive(agent);
    const isCreator = agent.ownerId === principal.userId;
    if (!isCreator && !isAdminLike(principal.role)) throw new AppError("ACCESS_DENIED");
    const { changed } = await this.store.apply({
      agentId: agent.id,
      workspaceId: agent.workspaceId,
      visibility: input.visibility,
    });
    if (changed) await this.onVisibilityChanged(agent.workspaceId, agent.id).catch(() => {});
    return { visibility: input.visibility, changed };
  }
}
