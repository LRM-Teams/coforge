import { AppError } from "#src/lib/app-error";
import type { AgentVisibility } from "#src/features/agents/agent-visibility";
import { assertAgentLive } from "./active-agent.server";
import type { AgentRepository } from "#src/server/db/repositories/agent.repositories.server";
import { isAdminLike, type WorkspaceMemberRole } from "#src/server/workspaces/member-role.server";
import {
  announceMemberChanged,
  type ConversationRealtime,
} from "#src/server/conversations/conversation-realtime.server";

/**
 * The atomic visibility transition, or whether it was a no-op. Implementations own the
 * public↔private side effects in one transaction: public→private soft-leaves every active channel
 * membership, `#general` included; private→public re-joins `#general` only. Messages, Tasks and
 * Action cards are never touched — history stays exactly as it was.
 */
export interface ChangeAgentVisibilityStore {
  apply(input: { agentId: string; workspaceId: string; visibility: AgentVisibility }): Promise<{
    changed: boolean;
    /** The channels a public→private change soft-left; empty otherwise. */
    leftChannelIds: string[];
    /** The channel a private→public change re-joined (`#general`); absent otherwise. */
    joinedChannelIds?: string[];
  }>;
  /** What a public→private change would do, for the confirmation dialog. Read-only. */
  preview(input: { agentId: string; workspaceId: string }): Promise<AgentVisibilityChangePreview>;
}

export type AgentVisibilityChangePreview = {
  /** Names of the channels (including `#general`, unprefixed) a public→private change would
   * soft-leave; empty for an Agent already private or in no active channel. */
  channelNames: string[];
  /** Existing direct conversations that would become read-only: every DM the Agent has with
   * someone other than its own creator, who alone keeps write access to a private Agent's DM. */
  readOnlyDirectMessageCount: number;
};

type VisibilityPrincipal = { userId: string; workspaceId: string; role: WorkspaceMemberRole };

/**
 * Changes one Agent's visibility, both directions. Authorized
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
    private readonly realtime?: Pick<ConversationRealtime, "memberChanged">,
  ) {}

  async execute(
    principal: VisibilityPrincipal,
    input: { agentId: string; visibility: AgentVisibility },
  ): Promise<{ visibility: AgentVisibility; changed: boolean }> {
    const agent = await this.authorize(principal, input.agentId);
    const {
      changed,
      leftChannelIds,
      joinedChannelIds = [],
    } = await this.store.apply({
      agentId: agent.id,
      workspaceId: agent.workspaceId,
      visibility: input.visibility,
    });
    if (changed) await this.onVisibilityChanged(agent.workspaceId, agent.id).catch(() => {});
    await announceMemberChanged(this.realtime, {
      workspaceId: agent.workspaceId,
      conversationIds: [...leftChannelIds, ...joinedChannelIds],
    });
    return { visibility: input.visibility, changed };
  }

  /** The confirmation dialog's preview, shown only to someone who may make the change: it names
   * the Agent's channels, which a viewer who cannot see a private Agent must never learn. */
  async preview(
    principal: VisibilityPrincipal,
    agentId: string,
  ): Promise<AgentVisibilityChangePreview> {
    const agent = await this.authorize(principal, agentId);
    return this.store.preview({ agentId: agent.id, workspaceId: agent.workspaceId });
  }

  private async authorize(principal: VisibilityPrincipal, agentId: string) {
    const agent = await this.agents.getById(agentId);
    if (!agent || agent.workspaceId !== principal.workspaceId) throw new AppError("NOT_FOUND");
    // A deleted Agent has no visibility left to change, the same "already inert" refusal every
    // other post-delete mutation gives.
    assertAgentLive(agent);
    const isCreator = agent.ownerId === principal.userId;
    if (!isCreator && !isAdminLike(principal.role)) throw new AppError("ACCESS_DENIED");
    return agent;
  }
}
