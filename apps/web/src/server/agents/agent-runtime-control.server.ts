import {
  AGENT_MESSAGE_METHOD,
  AGENT_START_METHOD,
  AGENT_ACTIVITY_METHOD,
  WORKSPACE_PROTOCOL_MAJOR,
  decodeAgentActivity,
  encodeAgentMessageDelivery,
  encodeAgentStartIntent,
  encodeAgentStopIntent,
  type AgentActivity,
  type AgentStartIntent,
  type AgentStopIntent,
} from "@coforge/protocol";
import { daemonControlChannel, type CentrifugoServerApi } from "../centrifugo/server-api.server";
import { runtimeStartFields } from "./manage-agents.server";
import type { AgentRepository } from "../db/repositories/agent.repositories.server";
import type { AgentRuntimeLock } from "./agent-runtime-lock.server";
import type {
  AgentRecoveryContext,
  PendingAgentDelivery,
} from "../db/repositories/direct-conversation.repositories.server";

export type AgentRuntimeControlAuthorization = {
  computerIdForAuthorizedAgent(
    workspaceId: string,
    agentId: string,
    userId: string,
  ): Promise<string | undefined>;
};
export type AgentActivitySink = (activity: AgentActivity) => Promise<void>;

export class PublishAgentRuntimeControl {
  constructor(
    private readonly authorization: AgentRuntimeControlAuthorization,
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

  async stop(intent: AgentStopIntent, userId: string): Promise<void> {
    if (intent.protocolMajor !== 1 || !intent.requestId || !intent.workspaceId || !intent.agentId)
      throw new Error("invalid agent stop intent");
    const computerId = await this.authorization.computerIdForAuthorizedAgent(
      intent.workspaceId,
      intent.agentId,
      userId,
    );
    if (!computerId) throw new Error("agent is not authorized or assigned to a Computer");
    await this.api.publish(
      daemonControlChannel(computerId),
      encodeAgentStopIntent({ ...intent, computerId }),
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
    private readonly conversations: {
      readAgentRecoveryContext(workspaceId: string, agentId: string): Promise<AgentRecoveryContext>;
      readPendingAgentDeliveries(
        workspaceId: string,
        agentId: string,
      ): Promise<PendingAgentDelivery[]>;
    },
    private readonly api: CentrifugoServerApi,
    private readonly runtimeLock: AgentRuntimeLock,
  ) {}

  async recoverWorkspace(
    workspaceId: string,
    computerId: string,
    runningAgentIds: readonly string[],
  ) {
    const runningAgents = new Set(runningAgentIds);
    const agents = await this.agents.listForComputer(workspaceId, computerId);
    for (const listedAgent of agents) {
      await this.runtimeLock.run(listedAgent.id, async () => {
        const agent = await this.agents.getById(listedAgent.id);
        if (!agent || agent.workspaceId !== workspaceId || agent.computerId !== computerId) return;
        if (runningAgents.has(agent.id)) {
          const deliveries = await this.conversations.readPendingAgentDeliveries(
            workspaceId,
            agent.id,
          );
          for (const delivery of deliveries) {
            await this.api.publish(
              daemonControlChannel(computerId),
              encodeAgentMessageDelivery({
                protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
                requestId: crypto.randomUUID(),
                workspaceId,
                agentId: agent.id,
                method: AGENT_MESSAGE_METHOD,
                ...delivery,
              }),
            );
          }
          return;
        }
        const recovery = await this.conversations.readAgentRecoveryContext(workspaceId, agent.id);
        await this.api.publish(
          daemonControlChannel(computerId),
          encodeAgentStartIntent({
            protocolMajor: 1,
            requestId: crypto.randomUUID(),
            workspaceId,
            computerId,
            agentId: agent.id,
            ...runtimeStartFields(agent.runtimeConfig),
            ...recovery,
          }),
        );
      });
    }
  }
}

export { AGENT_ACTIVITY_METHOD, AGENT_START_METHOD };
