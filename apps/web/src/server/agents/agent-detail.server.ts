import type { Prisma } from "../../../generated/client";
import { latestActivityError, type ActivityEntry } from "../../features/agents/agent-activity";

type DetailActivity = ActivityEntry & { computerId: string };

type DetailAgent = {
  id: string;
  workspaceId: string;
  name: string;
  displayName: string;
  description?: string;
  createdAt: Date;
  computerId?: string | null;
  owner: { id: string; username: string };
  runtimeConfig: Prisma.JsonValue;
};

export type AgentDetailSource = {
  findAuthorized(
    workspaceId: string,
    agentId: string,
    userId: string,
  ): Promise<DetailAgent | undefined>;
  listActivity(workspaceId: string, agentId: string): Promise<DetailActivity[]>;
};

function computerLabel(id: string) {
  if (id.length <= 12) return id;
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

export class AgentDetailQuery {
  constructor(private readonly source: AgentDetailSource) {}

  async get(workspaceId: string, agentId: string, userId: string) {
    const agent = await this.source.findAuthorized(workspaceId, agentId, userId);
    if (!agent) return undefined;
    const activity = await this.source.listActivity(workspaceId, agentId);
    const latest = activity[0];
    return {
      ...agent,
      computer: latest
        ? { id: latest.computerId, label: computerLabel(latest.computerId) }
        : undefined,
      latestError: latestActivityError(activity),
      activity,
    };
  }
}
