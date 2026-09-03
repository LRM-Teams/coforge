import {
  AGENT_START_METHOD,
  AGENT_ACTIVITY_METHOD,
  decodeAgentActivity,
  encodeAgentStartIntent,
  type AgentActivity,
  type AgentStartIntent,
} from "@coforge/protocol";
import { daemonControlChannel, type CentrifugoServerApi } from "../centrifugo/server-api.server";
import { runtimeStartFields } from "./agent-collection.server";
import type { AgentRepository } from "../db/repositories/agent.repositories.server";

export type AgentStartAuthorization = {
  computerIdForAuthorizedAgent(
    workspaceId: string,
    agentId: string,
    userId: string,
  ): Promise<string | undefined>;
};
export type AgentActivitySink = (activity: AgentActivity) => Promise<void>;

export class CloudAgentUseCase {
  constructor(
    private readonly authorization: AgentStartAuthorization,
    private readonly api: CentrifugoServerApi,
    private readonly activities: AgentActivitySink,
  ) {}

  async start(intent: AgentStartIntent, userId: string): Promise<void> {
    if (intent.protocolMajor !== 1 || !intent.requestId || !intent.workspaceId || !intent.agentId)
      throw new Error("invalid agent start intent");
    const computerId = await this.authorization.computerIdForAuthorizedAgent(
      intent.workspaceId,
      intent.agentId,
      userId,
    );
    if (!computerId) throw new Error("agent is not authorized or assigned to a Computer");
    await this.api.publish(
      daemonControlChannel(computerId),
      encodeAgentStartIntent({ ...intent, computerId }),
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

  async recoverWorkspace(workspaceId: string, computerId: string) {
    const agents = await this.agents.listForComputer(workspaceId, computerId);
    for (const agent of agents) {
      await this.api.publish(
        daemonControlChannel(computerId),
        encodeAgentStartIntent({
          protocolMajor: 1,
          requestId: crypto.randomUUID(),
          workspaceId,
          computerId,
          agentId: agent.id,
          ...runtimeStartFields(agent.runtimeConfig),
        }),
      );
    }
  }
}

export { AGENT_ACTIVITY_METHOD, AGENT_START_METHOD };
