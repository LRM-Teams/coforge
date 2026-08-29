import {
  AGENT_START_METHOD,
  AGENT_ACTIVITY_METHOD,
  decodeAgentActivity,
  encodeAgentStartIntent,
  type AgentActivity,
  type AgentStartIntent,
} from "@coforge/protocol";
import { workspaceAgentChannel, type CentrifugoServerApi } from "../centrifugo/server-api.server";
import { readRuntimeConfig } from "./agent-collection.server";
import type { AgentRepository } from "../db/repositories/agent.repositories.server";

export type AgentAuthorization = {
  canUseAgent(workspaceId: string, agentId: string, userId: string): Promise<boolean>;
};
export type AgentActivitySink = (activity: AgentActivity) => Promise<void>;

export class CloudAgentUseCase {
  constructor(
    private readonly authorization: AgentAuthorization,
    private readonly api: CentrifugoServerApi,
    private readonly activities: AgentActivitySink,
  ) {}

  async start(intent: AgentStartIntent, userId: string): Promise<void> {
    if (intent.protocolMajor !== 1 || !intent.requestId || !intent.workspaceId || !intent.agentId)
      throw new Error("invalid agent start intent");
    if (!(await this.authorization.canUseAgent(intent.workspaceId, intent.agentId, userId)))
      throw new Error("agent is not authorized");
    await this.api.publish(
      workspaceAgentChannel(intent.workspaceId),
      encodeAgentStartIntent(intent),
    );
  }

  async receiveActivity(payload: Uint8Array, scope: { workspaceId: string; agentId: string }) {
    const activity = decodeAgentActivity(payload);
    if (
      activity.protocolMajor !== 1 ||
      activity.workspaceId !== scope.workspaceId ||
      activity.agentId !== scope.agentId
    )
      throw new Error("agent activity scope is not authorized");
    await this.activities(activity);
    return activity;
  }
}

export class WorkspaceAgentRecovery {
  constructor(
    private readonly agents: AgentRepository,
    private readonly api: CentrifugoServerApi,
  ) {}

  async recoverWorkspace(workspaceId: string) {
    const agents = await this.agents.listInWorkspace(workspaceId);
    for (const agent of agents) {
      await this.api.publish(
        workspaceAgentChannel(workspaceId),
        encodeAgentStartIntent({
          protocolMajor: 1,
          requestId: crypto.randomUUID(),
          workspaceId,
          agentId: agent.id,
          ...readRuntimeConfig(agent),
        }),
      );
    }
  }
}

export { AGENT_ACTIVITY_METHOD, AGENT_START_METHOD };
