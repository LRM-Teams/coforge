import type { AgentStartIntent, AgentStopIntent } from "@lrm/coforge-sdk/internal";
import type { AgentRecord } from "../db/repositories/agent.repositories.server";
import type { AgentRuntimeLock } from "./agent-runtime-lock.server";
import { agentStartIntent, agentStopIntent } from "./manage-agents.server";
import type {
  AgentRuntimeCredentialSummary,
  AgentRuntimeCredentials,
} from "./agent-runtime-credentials.server";

type AgentRuntimeCredentialPrincipal = { workspaceId: string; userId: string };
type AgentLookup = {
  getById(agentId: string): Promise<AgentRecord | undefined>;
};
type CredentialMutation = Pick<AgentRuntimeCredentials, "save" | "delete">;
type AgentRuntimeControl = {
  start(intent: AgentStartIntent, userId: string): Promise<void>;
  stop(intent: AgentStopIntent, userId: string): Promise<void>;
};

export class ChangeAgentRuntimeCredential {
  constructor(
    private readonly agents: AgentLookup,
    private readonly credentials: CredentialMutation,
    private readonly runtimeControl: AgentRuntimeControl,
    private readonly runtimeLock: AgentRuntimeLock,
  ) {}

  save(
    principal: AgentRuntimeCredentialPrincipal,
    agentId: string,
    apiKey: string,
  ): Promise<{
    result: AgentRuntimeCredentialSummary;
    restart: "published" | "deferred";
  }> {
    return this.#restartAroundMutation(principal, agentId, () =>
      this.credentials.save(principal, agentId, apiKey),
    );
  }

  delete(
    principal: AgentRuntimeCredentialPrincipal,
    agentId: string,
  ): Promise<{ result: { deleted: true }; restart: "published" | "deferred" }> {
    return this.#restartAroundMutation(principal, agentId, async () => {
      await this.credentials.delete(principal, agentId);
      return { deleted: true as const };
    });
  }

  async #restartAroundMutation<T>(
    principal: AgentRuntimeCredentialPrincipal,
    agentId: string,
    mutation: () => Promise<T>,
  ) {
    return this.runtimeLock.run(agentId, async () => {
      const agent = await this.agents.getById(agentId);
      if (
        !agent?.computerId ||
        agent.workspaceId !== principal.workspaceId ||
        agent.ownerId !== principal.userId
      )
        throw new Error("Agent is not authorized");
      // ADR 0038: a stopped Agent has nothing running to protect from the old credential; persist
      // without the stop -> ... -> start dance.
      if (agent.stoppedAt) {
        const stoppedResult = await mutation();
        return { result: stoppedResult, restart: "deferred" as const };
      }
      await this.runtimeControl.stop(agentStopIntent(agent), principal.userId);
      let result: T;
      try {
        result = await mutation();
      } catch (error) {
        try {
          await this.runtimeControl.start(agentStartIntent(agent), principal.userId);
        } catch {}
        throw error;
      }
      try {
        const updated = await this.agents.getById(agentId);
        if (updated?.computerId)
          await this.runtimeControl.start(agentStartIntent(updated), principal.userId);
      } catch {
        return { result, restart: "deferred" as const };
      }
      return { result, restart: "published" as const };
    });
  }
}
